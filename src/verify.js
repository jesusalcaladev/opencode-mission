// Harness-side integrity checks. The model must not be able to make a check green
// by deleting or weakening the tests that define green in the first place.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./checks.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".mission", ".cache", "dist", "build", "zig-cache", ".zig-cache"]);

function isTestFile(rel) {
  const name = path.basename(rel);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return true;
  if (/^test_.*\.py$/.test(name)) return true;
  if (/(^|\/)(tests?|specs?)\//.test(rel) && /\.[cm]?[jt]sx?$|\.py$|\.rs$|\.go$/.test(name)) return true;
  return false;
}

async function walk(root, dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
    } else if (entry.isFile() && isTestFile(path.relative(root, full).split(path.sep).join("/"))) {
      const data = await readFile(full);
      out.set(path.relative(root, full).split(path.sep).join("/"), createHash("sha256").update(data).digest("hex"));
    }
  }
}

export async function hashTests(root) {
  const files = new Map();
  await walk(root, root, files);
  return Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export async function checkTestIntegrity(root, baseline) {
  const current = await hashTests(root);
  if (!baseline || typeof baseline !== "object" || Object.keys(baseline).length === 0) {
    return { ok: true, current, reason: "baseline established" };
  }
  const damaged = [];
  for (const [file, hash] of Object.entries(baseline)) {
    if (!(file in current)) damaged.push(`deleted ${file}`);
    else if (current[file] !== hash) damaged.push(`modified ${file}`);
  }
  if (current && Object.keys(current).length < Object.keys(baseline).length) {
    damaged.push(`test file count dropped from ${Object.keys(baseline).length} to ${Object.keys(current).length}`);
  }
  return { ok: damaged.length === 0, current, reason: damaged.join("; ") };
}

export async function isGitRepo(root) {
  try {
    const info = await stat(path.join(root, ".git"));
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

/// `paths` MUST be scoped to files the mission owns. Never `git add -A`.
export async function gitCommit(root, message, paths = []) {
  if (!(await isGitRepo(root))) return { ok: false, reason: "not a git repository" };
  if (paths.length === 0) return { ok: false, reason: "no mission-owned paths to commit" };
  const quoted = paths.map((p) => `'${String(p).replace(/'/g, "'\\''")}'`).join(" ");
  const add = await runCommand(`git add -- ${quoted}`, root, 15000);
  if (add.code !== 0) return { ok: false, reason: `git add failed: ${add.stderr.trim().slice(0, 200)}` };
  const commit = await runCommand(`git commit --no-gpg-sign -m ${JSON.stringify(message)}`, root, 30000);
  const text = `${commit.stdout}\n${commit.stderr}`;
  if (commit.code !== 0) {
    if (text.includes("nothing to commit")) return { ok: true, sha: null, reason: "no changes" };
    return { ok: false, reason: `git commit failed: ${text.trim().slice(0, 200)}` };
  }
  const head = await runCommand("git rev-parse --short HEAD", root, 5000);
  return { ok: true, sha: head.stdout.trim(), reason: "committed" };
}

/// Undo a verified checkpoint without touching later unrelated work.
export async function gitRevert(root, sha) {
  if (!sha || !(await isGitRepo(root))) return { ok: false, reason: "nothing to revert" };
  const result = await runCommand(`git revert --no-edit ${JSON.stringify(sha)}`, root, 30000);
  const text = `${result.stdout}\n${result.stderr}`;
  return result.code === 0 ? { ok: true, sha } : { ok: false, reason: text.trim().slice(0, 200) };
}

function safeRef(value) {
  return (
    String(value ?? "mission")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "mission"
  );
}

export async function createWorktree(root, id) {
  if (!(await isGitRepo(root))) return { ok: false, reason: "not a git repository" };
  const cleanId = safeRef(id);
  const parent = path.dirname(root);
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const target = path.join(parent, `.mission-worktree-${cleanId}-${suffix}`);
  const branch = `mission/${cleanId}`;
  const result = await runCommand(`git -C ${JSON.stringify(root)} worktree add -B ${JSON.stringify(branch)} ${JSON.stringify(target)} HEAD`, parent, 30000);
  if (result.code !== 0) return { ok: false, reason: `${result.stderr.trim().slice(0, 200)}` };
  return { ok: true, root: target, branch };
}
