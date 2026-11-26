// Durable journal helpers: append-only writes, bounded tail reads and rotation.
import { appendFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  FILES,
  JOURNAL_HEADER,
  JOURNAL_KEEP_ARCHIVES,
  JOURNAL_MAX_BYTES,
  JOURNAL_MAX_LINE_CHARS,
  JOURNAL_TAIL_CHARS,
} from "./state.js";
import { missionDir, readText } from "./persistence.js";

const journalQueues = new Map();

// Direct callers in recovery/workers/tools do not go through the supervisor's
// per-root serialize(), so the journal needs its own per-file queue. This also
// guarantees the header is written once and rotations never race an append.
async function withJournalLock(file, fn) {
  const previous = journalQueues.get(file) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  journalQueues.set(file, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (journalQueues.get(file) === tail) journalQueues.delete(file);
  }
}

async function ensureJournalHeader(file) {
  const info = await stat(file).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (!info || info.size === 0) await appendFile(file, JOURNAL_HEADER, "utf8");
}

function journalRotationBytes() {
  const configured = Number(process.env.MISSION_JOURNAL_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : JOURNAL_MAX_BYTES;
}

async function pruneJournalArchives(file, keep) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file, ".md")}.`;
  const names = (await readdir(dir).catch(() => [])).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".md")
  );
  // Archive names carry a random suffix, so lexical order is not creation
  // order. Prune by mtime to guarantee the newest lines survive.
  const archives = await Promise.all(
    names.map(async (name) => ({
      name,
      mtime: (await stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
    }))
  );
  archives.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  for (const { name } of archives.slice(0, Math.max(0, archives.length - keep))) {
    await rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

async function rotateJournal(file) {
  const info = await stat(file).catch(() => null);
  if (!info || info.size <= journalRotationBytes()) return;
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 6)}`;
  const archive = path.join(path.dirname(file), `${path.basename(file, ".md")}.${stamp}.md`);
  await rename(file, archive);
  await appendFile(
    file,
    `${JOURNAL_HEADER}[${new Date().toISOString().slice(0, 19)}] journal rotated → ${path.basename(archive)}\n`,
    "utf8"
  );
  await pruneJournalArchives(file, JOURNAL_KEEP_ARCHIVES);
}

export async function readJournalTail(root, maxChars = JOURNAL_TAIL_CHARS) {
  const file = path.join(missionDir(root), FILES.journal);
  const limit = Math.max(0, Number(maxChars) || JOURNAL_TAIL_CHARS);
  const info = await stat(file).catch(() => null);
  if (!info) return "";
  if (info.size <= limit) return readText(file, "");
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, info.size - limit);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    const firstBreak = text.indexOf("\n");
    if (firstBreak >= 0) text = text.slice(firstBreak + 1);
    return JOURNAL_HEADER + text;
  } catch {
    return readText(file, "");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readJournal(root) {
  return readText(path.join(missionDir(root), FILES.journal));
}

export async function appendJournal(root, line) {
  const file = path.join(missionDir(root), FILES.journal);
  await mkdir(path.dirname(file), { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19);
  const text = String(line ?? "")
    .replace(/\s+$/, "")
    .slice(0, JOURNAL_MAX_LINE_CHARS);
  const entry = `[${stamp}] ${text}\n`;
  return withJournalLock(file, async () => {
    await ensureJournalHeader(file);
    await appendFile(file, entry, "utf8");
    if (process.env.MISSION_JOURNAL_FSYNC === "1") {
      const handle = await open(file, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rotateJournal(file);
  });
}
