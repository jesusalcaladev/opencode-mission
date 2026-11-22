/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// Runs in the TUI process: only reads durable files written by the supervisor.
// No OpenTUI, no Solid, no network. Everything here is testable with node --test.

import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const cacheDir = () =>
  path.join(os.homedir?.() ?? process.env.HOME ?? "", ".cache", "opencode-mission");
export const pointerPath = () => path.join(cacheDir(), "current.json");
export const registryPath = () => path.join(cacheDir(), "missions.json");

import { readPointer, readRegistry } from "./model.js";

const readText = (file, fallback = "") => readFile(file, "utf8").catch(() => fallback);

const MISSION_FILES = ["state.json", "criteria.json", "tasks.json", "mission.md"];

/**
 * True only when `root` is a real, fully authored mission on disk.
 *
 * The pointer (`current.json`) and the registry (`missions.json`) are stale by
 * design: they keep the last mission after its workspace is deleted, and a
 * failed plan can leave a half-created `.mission/` with only `state.json`.
 * Both used to be shown as a mission with a workspace path that does not exist
 * and "(no objective) / 0 checks". Filtering here is the single place that
 * keeps the TUI honest without writing to the supervisor's cache files.
 */
export async function isMissionRoot(root) {
  if (typeof root !== "string" || !root.length) return false;
  const dir = path.join(root, ".mission");
  const present = await Promise.all(
    MISSION_FILES.map(async (name) => {
      const st = await stat(path.join(dir, name)).catch(() => null);
      return Boolean(st && st.isFile());
    })
  );
  return present.every(Boolean);
}

export async function discoverRoots(missionsRoot, limit = 12) {
  const candidates = new Set();
  const pointer = await readPointer();
  if (pointer?.root) candidates.add(pointer.root);
  for (const entry of await readRegistry()) candidates.add(entry.root);
  if (missionsRoot) {
    try {
      const dirs = await readdir(path.resolve(missionsRoot), { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        candidates.add(path.join(path.resolve(missionsRoot), d.name));
      }
    } catch {
      // A missing missionsRoot is normal in fresh installs.
    }
  }
  const roots = [];
  // Validate every source the same way. A directory scan alone used to trust
  // any folder with a `.mission` dir, including half-created ones.
  for (const root of candidates) {
    if (await isMissionRoot(root)) roots.push(root);
  }
  return roots.slice(0, limit);
}

function ratio(a, b) {
  return b > 0 ? a / b : 0;
}
