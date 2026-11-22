import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

import {
  JOURNAL_HEADER,
  JOURNAL_KEEP_ARCHIVES,
  JOURNAL_MAX_LINE_CHARS,
  appendJournal,
  missionDir,
  readJournal,
  readJournalTail,
} from "../src/mission.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-journal-"));
  await mkdir(path.join(root, ".mission"), { recursive: true });
  return root;
}

test("journal: concurrent appends keep every line and a single header", async () => {
  const root = await fixture();
  try {
    await Promise.all(Array.from({ length: 200 }, (_, i) => appendJournal(root, `line ${i}`)));
    const text = await readJournal(root);
    assert.equal((text.match(/# Journal/g) ?? []).length, 1);
    for (let i = 0; i < 200; i += 1) assert.match(text, new RegExp(`line ${i}\\b`));
    const leftovers = (await readdir(missionDir(root))).filter((n) => n.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal: tail read returns a bounded window on line boundaries", async () => {
  const root = await fixture();
  try {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `L${String(i).padStart(3, "0")} ${"x".repeat(80)}`
    );
    await writeFile(
      path.join(missionDir(root), "journal.md"),
      `${JOURNAL_HEADER}${lines.join("\n")}\n`,
      "utf8"
    );
    const tail = await readJournalTail(root, 300);
    assert.ok(tail.startsWith(JOURNAL_HEADER));
    const body = tail.slice(JOURNAL_HEADER.length).trim().split("\n");
    assert.ok(body.length > 0);
    for (const line of body) assert.match(line, /^L\d{3} /);
    assert.match(body.at(-1), /^L039 /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal: rotation bounds the active file and prunes old archives", async () => {
  const root = await fixture();
  const previous = process.env.MISSION_JOURNAL_MAX_BYTES;
  process.env.MISSION_JOURNAL_MAX_BYTES = "800";
  try {
    for (let i = 0; i < 60; i += 1) await appendJournal(root, `line ${i} ${"y".repeat(40)}`);
    const active = path.join(missionDir(root), "journal.md");
    const info = await stat(active);
    assert.ok(info.size <= 1000, `journal grew to ${info.size} bytes`);
    const archives = (await readdir(missionDir(root))).filter((n) => /^journal\..*\.md$/.test(n));
    assert.ok(archives.length > 0);
    assert.ok(archives.length <= JOURNAL_KEEP_ARCHIVES);
    const text = await readJournal(root);
    assert.match(text, /line 59/);
    const tail = await readJournalTail(root, 200);
    assert.match(tail, /line 59/);
  } finally {
    if (previous === undefined) delete process.env.MISSION_JOURNAL_MAX_BYTES;
    else process.env.MISSION_JOURNAL_MAX_BYTES = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("journal: concurrent appends survive repeated rotations without losing lines", async () => {
  const root = await fixture();
  const previous = process.env.MISSION_JOURNAL_MAX_BYTES;
  process.env.MISSION_JOURNAL_MAX_BYTES = "600";
  try {
    await Promise.all(
      Array.from({ length: 120 }, (_, i) => appendJournal(root, `stress ${i} ${"q".repeat(30)}`))
    );
    const dir = missionDir(root);
    const files = (await readdir(dir)).filter(
      (n) => n === "journal.md" || /^journal\..*\.md$/.test(n)
    );
    const kept = [];
    for (const name of files) {
      const text = await readFile(path.join(dir, name), "utf8");
      kept.push(...text.split("\n").filter((line) => /^\[[^\]]+\] stress \d+ /.test(line)));
    }
    // Old archives are pruned by design; the newest lines must always survive.
    assert.ok(kept.length > 0 && kept.length <= 120);
    assert.ok(kept.some((line) => line.includes("stress 119")));
    assert.ok(kept.some((line) => line.includes("stress 118")));
    assert.match(await readJournal(root), /stress 119/);
    assert.ok(files.length <= 1 + JOURNAL_KEEP_ARCHIVES);
  } finally {
    if (previous === undefined) delete process.env.MISSION_JOURNAL_MAX_BYTES;
    else process.env.MISSION_JOURNAL_MAX_BYTES = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("journal: appends to an existing hand-written journal and caps long lines", async () => {
  const root = await fixture();
  try {
    const file = path.join(missionDir(root), "journal.md");
    await writeFile(file, `${JOURNAL_HEADER}[old] kept\n`, "utf8");
    await appendJournal(root, "new line");
    await appendJournal(root, "z".repeat(JOURNAL_MAX_LINE_CHARS + 500));
    const text = await readJournal(root);
    assert.match(text, /\[old\] kept/);
    assert.match(text, /new line/);
    assert.equal((text.match(/# Journal/g) ?? []).length, 1);
    assert.match(text, new RegExp(`z{${JOURNAL_MAX_LINE_CHARS}}`));
    assert.doesNotMatch(text, new RegExp(`z{${JOURNAL_MAX_LINE_CHARS + 1}}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
