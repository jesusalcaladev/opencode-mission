// Mission Control cache publication for the TUI.
//
// Two PROCESS-GLOBAL files live in cacheDir():
//   current.json   pointer to the most recently touched mission
//   missions.json  up to 30 recent missions
// This is telemetry only: it must never fail a mission, and it never writes
// into `.mission/`. The TUI also reads `.mission/` directly; this cache only
// helps it FIND missions.
//
// Historically `updateRegistry` was a standalone function that nonetheless
// read `this.boundDirectory` / `this.currentDirectory`. Called as a plain
// function, `this` was `undefined`, the resulting TypeError was swallowed by a
// silent `catch`, and the TUI cache silently stopped updating. Nothing here
// reads `this`; callers pass `directory` explicitly.

import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextAtomic } from "../mission.js";

export const cacheDir = () =>
  process.env.OPENCODE_MISSION_CACHE_DIR ??
  path.join(os.homedir?.() ?? process.env.HOME ?? "", ".cache", "opencode-mission");
export const pointerPath = () => path.join(cacheDir(), "current.json");
export const registryPath = () => path.join(cacheDir(), "missions.json");

/** Where a session works; falls back to mission root, then caller default. */
export function directoryFor(sessionID, { boundDirectory, fallback, root } = {}) {
  if (boundDirectory && typeof boundDirectory.get === "function") {
    const bound = boundDirectory.get(sessionID ?? "");
    if (typeof bound === "string" && bound.length) return bound;
  }
  return fallback ?? root ?? null;
}

/**
 * Update current.json + missions.json. Never rejects; reports via onError.
 * In tests, writes only when OPENCODE_MISSION_CACHE_DIR points at a sandbox,
 * so a test run can never pollute a user's real cache.
 */
export async function updateRegistry(root, state, objective = "", opts = {}) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.OPENCODE_MISSION_CACHE_DIR) return;
  const onError = typeof opts.onError === "function" ? opts.onError : () => {};
  try {
    await mkdir(cacheDir(), { recursive: true });
    const sessionID = state.session_id ?? "";
    const directory = typeof opts.directory === "string" ? opts.directory : null;
    await writeTextAtomic(
      pointerPath(),
      `${JSON.stringify({ root, sessionID, id: state.id ?? "mission", status: state.status, directory, at: Date.now() })}\n`
    );
    let list = [];
    try {
      const parsed = JSON.parse(await readFile(registryPath(), "utf8"));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
    const checks = Array.isArray(state.last_checks) ? state.last_checks : [];
    const green = checks.filter((c) => c.ok).length;
    const entry = {
      root,
      sessionID,
      id: state.id ?? "mission",
      objective: String(objective ?? "").slice(0, 200),
      directory,
      status: state.status,
      pct: checks.length ? Math.round((green / checks.length) * 100) : 0,
      updated_at: Date.now(),
    };
    list = [entry, ...list.filter((e) => e?.root !== root)].slice(0, 30);
    await writeTextAtomic(registryPath(), `${JSON.stringify(list, null, 2)}\n`);
  } catch (err) {
    onError(err); // telemetry only; never break the mission
  }
}
