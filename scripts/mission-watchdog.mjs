#!/usr/bin/env node
// External watchdog. It never prompts OpenCode: it only writes .mission/WAKE
// when a running mission has gone quiet. The in-process supervisor consumes it.
// Run with --once from cron, or without it for a resident helper.

import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const once = args.includes("--once");
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const ageMs = Math.max(1000, Number(argValue("--age-ms", 180_000)) || 180_000);
const intervalMs = Math.max(1000, Number(argValue("--interval-ms", 60_000)) || 60_000);
const roots = args.filter((a) => !a.startsWith("--") && !/^\d+$/.test(a));
const base = roots.length ? roots : [process.env.MISSIONS_ROOT || path.resolve("missions")];

const SKIP = new Set([".git", "node_modules", ".opencode"]);

async function* missionRoots(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isDirectory() && e.name === ".mission")) {
    yield dir;
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    yield* missionRoots(path.join(dir, entry.name));
  }
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function needsWake(state, now) {
  if (!state || state.status !== "running") return false;
  const last = Number(state.last_prompt_at);
  return !Number.isFinite(last) || now - last >= ageMs;
}

async function scan() {
  const now = Date.now();
  const result = { scanned: 0, running: 0, woken: 0, errors: 0, roots: [] };
  for (const baseRoot of base) {
    for await (const root of missionRoots(path.resolve(baseRoot))) {
      result.scanned += 1;
      const dir = path.join(root, ".mission");
      try {
        const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
        if (state.status !== "running") continue;
        result.running += 1;
        if ((await exists(path.join(dir, "STOP"))) || (await exists(path.join(dir, "PAUSE"))))
          continue;
        if (!needsWake(state, now) || (await exists(path.join(dir, "WAKE")))) continue;
        const tmp = path.join(dir, `.WAKE.${process.pid}.tmp`);
        await writeFile(tmp, `${new Date(now).toISOString()}\n`, "utf8");
        await rename(tmp, path.join(dir, "WAKE"));
        result.woken += 1;
        result.roots.push(root);
      } catch {
        result.errors += 1;
      }
    }
  }
  return result;
}

const report = await scan();
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!once) {
  const timer = setInterval(async () => {
    try {
      const next = await scan();
      process.stdout.write(`${JSON.stringify(next)}\n`);
    } catch (err) {
      process.stderr.write(`watchdog error: ${String(err)}\n`);
    }
  }, intervalMs);
  timer.unref();
}
