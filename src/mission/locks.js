// Per-file locks for a shared workspace. Waves are disjoint by construction,
// but roles, spawned agents and re-queued tasks can still overlap.

export function normalizeLockPath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

export function lockFiles(locks, taskId, files = []) {
  const paths = [...new Set(files.map(normalizeLockPath).filter(Boolean))];
  const conflicts = paths.filter((p) => locks.has(p) && locks.get(p) !== taskId);
  if (conflicts.length) return conflicts;
  for (const p of paths) locks.set(p, taskId);
  return [];
}

export function unlockFiles(locks, taskId) {
  for (const [file, owner] of locks) if (owner === taskId) locks.delete(file);
}

export function lockedBy(locks, file) {
  return locks.get(normalizeLockPath(file)) ?? null;
}
