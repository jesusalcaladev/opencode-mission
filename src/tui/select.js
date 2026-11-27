// Pure snapshot selection for the Mission Control TUI (node:test safe).
//
// Strict session scoping is preserved: a session with no mission of its own
// must not inherit another terminal's work. But matching is made robust to a
// stale cache / session drift instead of failing silently to the empty state.
//
// Order:
//   1. registry entries whose sessionID === sessionID (newest first) that also
//      have a loaded snapshot at the same root;
//   2. a loaded snapshot whose own sessionID === sessionID (state names lead);
//   3. conservative fallback: a running/paused mission whose root is inside
//      `directory`, used when the cached sessionID drifted (e.g. after handoff);
//   4. never leak another session's mission.
//
// The shared global pointer is consulted only when there is no active session.

import path from "node:path";
import { STATUS } from "../mission/state.js";

const ACTIVE = new Set([STATUS.RUNNING, STATUS.PAUSED]);

function underRoot(root, directory) {
  if (typeof root !== "string" || typeof directory !== "string" || !directory) return false;
  const r = path.resolve(root);
  const d = path.resolve(directory);
  return r === d || r.startsWith(`${d}${path.sep}`);
}

export function selectSnapshot({
  sessionID,
  directory,
  pointer,
  registry = [],
  snapshots = [],
} = {}) {
  const full = snapshots.filter(Boolean);
  const byRoot = new Map(full.map((s) => [path.resolve(s.root), s]));

  if (sessionID) {
    const owned = registry
      .filter((e) => e && e.sessionID === sessionID && typeof e.root === "string")
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    for (const entry of owned) {
      const match = byRoot.get(path.resolve(entry.root));
      if (match) return match;
    }
    // Older missions may predate the registry; their state still names the lead.
    const direct = full.find((s) => s.sessionID === sessionID);
    if (direct) return direct;
    // Cached sessionID can drift after a handoff/restart; don't show nothing
    // when an active mission in this very workspace is loaded. Never another
    // session's mission.
    if (directory) {
      const active = full.find((s) => ACTIVE.has(s.status) && underRoot(s.root, directory));
      if (active) return active;
    }
    return null;
  }

  if (pointer?.root) {
    const match = byRoot.get(path.resolve(pointer.root));
    if (match) return match;
  }
  return full.find((s) => s.status === STATUS.RUNNING) ?? full[0] ?? null;
}
