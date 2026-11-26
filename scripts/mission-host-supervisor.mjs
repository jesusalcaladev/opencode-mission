#!/usr/bin/env node
// External, opt-in host supervisor. It never talks to OpenCode directly:
// a WAKE marker that stays stale means the in-process watchdog is gone.
// Example command: "systemctl --user restart opencode"

import { execFile } from "node:child_process";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_RESTART_BACKOFF_MS,
  DEFAULT_RESTART_MAX,
  DEFAULT_RESTART_WINDOW_MS,
  DEFAULT_WAKE_AGE_MS,
  HOST_RESTART_FILE,
  hostRestartDecision,
} from "../src/mission/host-restart.js";

const run = promisify(execFile);
const args = process.argv.slice(2);
const value = (flag, env, fallback) => {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return process.env[env] ?? fallback;
};
const missionsRoot = path.resolve(value("--missions-root", "MISSIONS_ROOT", "missions"));
const command = String(value("--command", "MISSION_HOST_RESTART_COMMAND", ""));
const maxRestarts = Number(value("--max", "MISSION_HOST_RESTART_MAX", DEFAULT_RESTART_MAX));
const backoffMs = Number(
  value("--backoff-ms", "MISSION_HOST_RESTART_BACKOFF_MS", DEFAULT_RESTART_BACKOFF_MS)
);
const windowMs = Number(
  value("--window-ms", "MISSION_HOST_RESTART_WINDOW_MS", DEFAULT_RESTART_WINDOW_MS)
);
const minWakeAgeMs = Number(
  value("--wake-age-ms", "MISSION_HOST_RESTART_WAKE_AGE_MS", DEFAULT_WAKE_AGE_MS)
);
const intervalMs = Number(value("--interval-ms", "MISSION_HOST_RESTART_INTERVAL_MS", 0)) || 0;
const dryRun = args.includes("--dry-run") || !command;
const SKIP = new Set([".git", "node_modules", ".opencode"]);

async function* missionRoots(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((entry) => entry.isDirectory() && entry.name === ".mission")) {
    yield dir;
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
    yield* missionRoots(path.join(dir, entry.name));
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function scan() {
  const now = Date.now();
  const report = {
    scanned: 0,
    running: 0,
    restarts: 0,
    skipped: {},
    roots: [],
    dry_run: dryRun,
  };
  for await (const root of missionRoots(missionsRoot)) {
    report.scanned += 1;
    const dir = path.join(root, ".mission");
    try {
      const state = await readJson(path.join(dir, "state.json"), null);
      if (!state || state.status !== "running") continue;
      report.running += 1;
      const stopFile = Boolean(await stat(path.join(dir, "STOP")).catch(() => null));
      const pauseFile = Boolean(await stat(path.join(dir, "PAUSE")).catch(() => null));
      const wake = await stat(path.join(dir, "WAKE")).catch(() => null);
      const decision = hostRestartDecision({
        state,
        stopFile,
        pauseFile,
        wakeAgeMs: wake ? now - wake.mtimeMs : Infinity,
        restart: await readJson(path.join(dir, HOST_RESTART_FILE), {}),
        now,
        maxRestarts,
        windowMs,
        backoffMs,
        minWakeAgeMs,
      });
      if (!decision.restart) {
        report.skipped[decision.reason] = (report.skipped[decision.reason] ?? 0) + 1;
        continue;
      }
      if (!dryRun) {
        try {
          await run(command, {
            shell: true,
            timeout: 30_000,
            env: { ...process.env, MISSION_RESTART_ROOT: root },
          });
          await writeFile(
            path.join(dir, HOST_RESTART_FILE),
            `${JSON.stringify(
              {
                attempts: decision.attempts,
                window_start: decision.window_start,
                next_at: decision.next_at,
                last_at: now,
                last_error: "",
              },
              null,
              2
            )}\n`,
            "utf8"
          );
          await rm(path.join(dir, "WAKE"), { force: true }).catch(() => {});
          report.restarts += 1;
          report.roots.push(root);
        } catch (err) {
          await writeFile(
            path.join(dir, HOST_RESTART_FILE),
            `${JSON.stringify(
              {
                attempts: decision.attempts,
                window_start: decision.window_start,
                next_at: now + backoffMs,
                last_at: now,
                last_error: String(err?.message ?? err).slice(0, 300),
              },
              null,
              2
            )}\n`,
            "utf8"
          ).catch(() => {});
          report.skipped["command-failed"] = (report.skipped["command-failed"] ?? 0) + 1;
        }
      } else {
        report.roots.push(root);
      }
    } catch {
      report.skipped["unreadable"] = (report.skipped["unreadable"] ?? 0) + 1;
    }
  }
  return report;
}

const first = await scan();
process.stdout.write(`${JSON.stringify(first)}\n`);
if (intervalMs > 0) {
  const timer = setInterval(
    async () => {
      try {
        process.stdout.write(`${JSON.stringify(await scan())}\n`);
      } catch (err) {
        process.stderr.write(`host supervisor error: ${String(err)}\n`);
      }
    },
    Math.max(1000, intervalMs)
  );
  timer.unref();
}
