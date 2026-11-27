// Workspace fingerprint support: list source files without descending into
// dependency/build directories. `readdir(root, { recursive: true })` used to
// traverse node_modules and .git on every verification and filter afterwards,
// which made each turn progressively slower as a real project grew.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const STAMP_SKIP = new Set([
  ".git",
  ".mission",
  "node_modules",
  "zig-cache",
  ".zig-cache",
  "zig-out",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".cache",
]);

export async function listStampFiles(root, limit = 20_000) {
  const out = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      // Never descend: filtering after a recursive walk still paid the cost.
      if (STAMP_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  out.sort();
  return out;
}

/// Stat in bounded batches: thousands of sequential `stat` calls dominated the
/// verification time in large trees.
export async function statFiles(files, batch = 64) {
  const out = [];
  for (let i = 0; i < files.length; i += batch) {
    const slice = files.slice(i, i + batch);
    const stats = await Promise.all(slice.map((file) => stat(file).catch(() => null)));
    stats.forEach((info, index) => {
      if (info) out.push({ file: slice[index], info });
    });
  }
  return out;
}
