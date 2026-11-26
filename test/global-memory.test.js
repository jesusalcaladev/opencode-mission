import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { GLOBAL_MEMORY_FILE, mergeGlobalMemory } from "../src/mission/global-memory.js";
import {
  ensureMission,
  loadState,
  missionDir,
  saveState,
  writeTextAtomic,
} from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

test("mergeGlobalMemory deduplicates and keeps the newest bounded lines", () => {
  const merged = mergeGlobalMemory("old decision line", ["old decision line", "new decision line"]);
  assert.equal(merged.trim().split("\n").length, 2);
  assert.match(merged, /new decision line/);
  const capped = mergeGlobalMemory("x".repeat(5000), ["tail decision"], 60);
  assert.ok(capped.length <= 62);
  assert.match(capped, /tail decision/);
});

test("compactMemory publishes cross-mission memory and briefs inject it", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-global-"));
  const missionsRoot = path.join(base, "missions");
  const root = path.join(missionsRoot, "m1");
  const store = new Map();
  const ctx = {
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      prompt: async () => {},
      context: async () => [],
      synthetic: async () => {},
      create: async () => ({ id: "lead" }),
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: base },
  };
  try {
    await ensureMission(root, { objective: "global memory" });
    const sup = new Supervisor(ctx, { missionsRoot });
    await sup.start("lead", root);
    const state = await loadState(root);
    state.global_memory = true;
    state.turn = 4;
    await saveState(root, state);
    await writeTextAtomic(
      path.join(missionDir(root), "memory.md"),
      "CROSS-ONLY decision: the renderer owns the ECS snapshots",
      "utf8"
    );
    await sup.compactMemory(root, state);
    const global = await readFile(path.join(missionsRoot, GLOBAL_MEMORY_FILE), "utf8");
    assert.match(global, /CROSS-ONLY decision/);
    await sup.refreshBrief("lead", root, []);
    assert.match(String(sup.briefs.get("lead")), /Cross-mission memory/);
    sup.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
