import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { needsWake, WAKE_FILE } from "../src/mission/wake.js";
import { ensureMission, loadState, saveState, missionDir } from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

const exec = promisify(execFile);

test("needsWake only fires for a running, quiet mission", () => {
  const now = 1_000_000;
  assert.equal(needsWake({ status: "running", last_prompt_at: now - 200_000 }, now), true);
  assert.equal(needsWake({ status: "running", last_prompt_at: now - 1000 }, now), false);
  assert.equal(needsWake({ status: "complete", last_prompt_at: 0 }, now), false);
  assert.equal(needsWake({ status: "running" }, now), true);
});

test("external watchdog writes WAKE for a quiet running mission", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-watchdog-"));
  const root = path.join(base, "mission");
  try {
    await mkdir(path.join(root, ".mission"), { recursive: true });
    await writeFile(
      path.join(root, ".mission", "state.json"),
      JSON.stringify({ status: "running", last_prompt_at: Date.now() - 600_000 }),
      "utf8"
    );
    const script = path.resolve("scripts/mission-watchdog.mjs");
    const { stdout } = await exec(process.execPath, [script, "--once", "--age-ms", "1000", root]);
    const report = JSON.parse(stdout.trim());
    assert.equal(report.scanned, 1);
    assert.equal(report.woken, 1);
    const wake = await readFile(path.join(root, ".mission", WAKE_FILE), "utf8");
    assert.match(wake, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("in-process watcher consumes WAKE and re-admits the lead", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-wake-"));
  const prompts = [];
  const store = new Map();
  const ctx = {
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      prompt: async ({ text }) => prompts.push(text),
      context: async () => [],
      synthetic: async () => {},
      create: async () => ({ id: "lead" }),
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({
        id: sessionID,
        outcome: "complete",
        time: { idle: 10, busy: 0 },
      }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
  try {
    await ensureMission(root, { objective: "wake" });
    const sup = new Supervisor(ctx);
    await sup.start("lead", root);
    const state = await loadState(root);
    state.last_prompt_at = Date.now() - 600_000;
    await saveState(root, state);
    await writeFile(path.join(missionDir(root), WAKE_FILE), "external\n", "utf8");
    sup.registry.push({ sessionID: "lead", root, updated_at: Date.now() });
    sup.bind("lead", root, true);
    await sup.wakeStalled();
    assert.ok(prompts.some((text) => text.startsWith("[MISSION WAKE]")));
    await assert.rejects(() => readFile(path.join(missionDir(root), WAKE_FILE)));
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
