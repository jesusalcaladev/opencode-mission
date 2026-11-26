import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { wavesFor } from "../src/team.js";
import { lockFiles, unlockFiles, lockedBy } from "../src/mission/locks.js";
import {
  ensureMission,
  loadTasks,
  loadProgress,
  writeTextAtomic,
  missionDir,
} from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

test("maxWorkers is configurable above 8 and waves use the full value", () => {
  const sup = new Supervisor({}, { maxWorkers: 24 });
  assert.equal(sup.maxWorkers, 24);
  const tasks = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    files: [`f${i}.js`],
    blocked_by: [],
  }));
  assert.equal(wavesFor(tasks, 24)[0].length, 12);
});

test("file locks reject overlapping owners and are released", () => {
  const locks = new Map();
  assert.deepEqual(lockFiles(locks, 1, ["./a.js", "b.js"]), []);
  assert.deepEqual(lockFiles(locks, 2, ["a.js"]), ["a.js"]);
  assert.equal(lockedBy(locks, "a.js"), 1);
  unlockFiles(locks, 1);
  assert.equal(lockedBy(locks, "a.js"), null);
  assert.equal(lockedBy(locks, "b.js"), null);
});

function fakeCtx() {
  const store = new Map();
  const created = [];
  const prompts = [];
  return {
    created,
    prompts,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      context: async () => [],
      create: async ({ parentID }) => {
        const id = parentID ? `worker-${created.length}` : "lead";
        created.push(id);
        return { id };
      },
      prompt: async ({ text }) => prompts.push(text),
      synthetic: async () => {},
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-parallel-"));
  await ensureMission(root, { objective: "parallel" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({
      version: 1,
      checks: [{ id: "done", cmd: "test -f done.txt", expect: "exit0", timeout_ms: 5000 }],
    })
  );
  await writeTextAtomic(
    path.join(missionDir(root), "tasks.json"),
    JSON.stringify({ version: 1, tasks: [] })
  );
  return root;
}

test("mission_spawn creates a verifiable task and dispatches a worker", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx, { maxWorkers: 4 });
    await sup.start("lead", root);
    const before = (await loadTasks(root)).length;
    const reply = await sup.toolSpawn("lead", {
      subject: "Write the missing file",
      files: ["done.txt"],
      verify: "done",
    });
    assert.match(reply, /Spawned task #1/);
    const tasks = await loadTasks(root);
    assert.equal(tasks.length, before + 1);
    assert.equal(tasks.at(-1).verify, "done");
    assert.ok((await loadProgress(root)).some((p) => p.id === tasks.at(-1).id));
    assert.ok(ctx.created.some((id) => id.startsWith("worker-")));
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mission_spawn respects capacity: a full pool queues the task", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx, { maxWorkers: 1 });
    await sup.start("lead", root);
    const before = (await loadTasks(root)).length;
    sup.workers.set("busy-worker", { root, taskId: 0, leadID: "lead", role: "implementer" });
    const reply = await sup.toolSpawn("lead", { subject: "Queued work", files: ["x.js"] });
    assert.match(reply, /next idle boundary/);
    assert.equal((await loadTasks(root)).length, before + 1);
    sup.workers.delete("busy-worker");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
