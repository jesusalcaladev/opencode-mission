import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  enqueue as queueEnqueue,
  sortQueue,
  runningCount,
  nextBatch,
  markRunning,
  markFinished,
  requeueDead,
  queueStats,
} from "../src/mission/queue.js";
import { Supervisor } from "../src/supervisor.js";

test("queue sorts by priority then age and only releases pending entries", () => {
  let entries = [];
  entries = queueEnqueue(entries, "low task", 0, 100);
  entries = queueEnqueue(entries, "high task", 5, 200);
  entries = queueEnqueue(entries, "another low", 0, 150);
  assert.deepEqual(
    sortQueue(entries).map((e) => e.objective),
    ["high task", "low task", "another low"]
  );
  assert.equal(nextBatch(entries, 2).length, 2);
  assert.equal(nextBatch(entries, 0).length, 0);
  const running = markRunning(entries, [entries[0]], ["lead-1"]);
  assert.equal(runningCount(running), 1);
  assert.equal(running.find((e) => e.sessionID === "lead-1").status, "running");
  assert.equal(nextBatch(running, 4).length, 2);
  const requeued = requeueDead(running, []);
  assert.equal(runningCount(requeued), 0);
  assert.equal(queueStats(requeued).pending, 3);
  const finished = markFinished(running, running.find((e) => e.status === "running").id);
  assert.equal(queueStats(finished).done, 1);
});

function fakeCtx({ ids = [] } = {}) {
  const store = new Map();
  const prompts = [];
  let index = 0;
  return {
    ids,
    prompts,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      context: async () => [],
      create: async () => ({ id: ids[index++] ?? `session-${index}` }),
      prompt: async ({ text }) => prompts.push(text),
      synthetic: async () => {},
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID, outcome: "complete", time: {} }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

test("queue persists priorities and launches in bounded batches", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-queue-"));
  try {
    const ctx = fakeCtx({ ids: ["lead-a", "lead-b"] });
    const sup = new Supervisor(ctx, { missionsRoot: base, parallelSlots: 1 });
    assert.match(await sup.enqueueMission("Build alpha CLI", 1), /Queued/);
    assert.match(await sup.enqueueMission("Build beta CLI", 5), /Queued/);
    const loaded = await sup.loadQueue();
    assert.equal(loaded.length, 2);
    assert.equal(sortQueue(loaded)[0].priority, 5);
    const first = await sup.runQueue();
    assert.match(first, /Started 1 queued mission/);
    assert.equal(runningCount(await sup.loadQueue()), 1);
    const second = await sup.runQueue(1);
    assert.match(second, /Started 1 queued mission/);
    assert.equal(runningCount(await sup.loadQueue()), 2);
    assert.match(await sup.runQueue(), /No queued missions/);
    sup.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("load: eight parallel missions get independent sessions and workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-queue-load-"));
  try {
    const ids = Array.from({ length: 8 }, (_, i) => `lead-${i}`);
    const ctx = fakeCtx({ ids });
    const plan = JSON.stringify({
      objective: "Build a tiny CLI",
      checks: [
        { id: "unit", cmd: "node --test", expect: "exit0", timeout_ms: 30000, kind: "unit" },
      ],
      tasks: [{ id: 1, subject: "Build a tiny CLI", files: [], verify: "unit", blocked_by: [] }],
      settings: { max_turns: 4, budget_usd: 1 },
    });
    const sup = new Supervisor(ctx, {
      missionsRoot: base,
      maxWorkers: 3,
      generate: async () => plan,
    });
    const objectives = Array.from({ length: 8 }, (_, i) => `Build tiny CLI number ${i}`);
    const reply = await sup.startParallel("original", objectives.join(" | "));
    assert.match(reply, /Started 8 mission\(s\)/);
    assert.equal(sup.byRoot.size, 8);
    assert.equal(sup.bySession.size, 8);
    assert.equal(new Set([...sup.bySession.values()]).size, 8);
    assert.ok(ctx.prompts.length >= 8);
    sup.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
