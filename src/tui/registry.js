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

export async function discoverRoots(missionsRoot, limit = 12) {
  const roots = new Set();
  const pointer = await readPointer();
  if (pointer?.root) roots.add(pointer.root);
  for (const entry of await readRegistry()) roots.add(entry.root);
  if (missionsRoot) {
    try {
      const dirs = await readdir(path.resolve(missionsRoot), { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const root = path.join(path.resolve(missionsRoot), d.name);
        const st = await stat(path.join(root, ".mission")).catch(() => null);
        if (st) roots.add(root);
      }
    } catch {
      // A missing missionsRoot is normal in fresh installs.
    }
  }
  return [...roots].slice(0, limit);
}

function ratio(a, b) {
  return b > 0 ? a / b : 0;
}
