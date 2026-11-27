import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { applyTaskResults } from "../src/mission/decide.js";
import { fromTasks, syncTasks } from "../src/mission/lease.js";
import { computeProgress } from "../src/mission/progress.js";

function ctx(directory) {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {},
      synthetic: async () => {},
      create: async () => ({ id: "ses_test" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      switchModel: async () => {},
      wait: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory },
  };
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("syncTasks keeps completions from either view and propagates reports", () => {
  const tasks = [
    { id: 1, status: "in_progress", verify: "unit" },
    { id: 2, status: "completed", verify: "unit" },
  ];
  const progress = fromTasks(tasks);
  progress[0].status = "completed";
  progress[1].status = "in_progress";
  const synced = syncTasks(progress, tasks);
  assert.equal(synced[0].status, "completed");
  assert.equal(synced[1].status, "completed", "a completion already earned is sticky");
});

test("a baseline-green check only completes a task after a worker report", () => {
  const tasks = [{ id: 1, status: "in_progress", verify: "unit" }];
  const results = [{ id: "unit", ok: true }];
  const baseline = { unit: true };
  assert.equal(applyTaskResults(tasks, results, baseline).tasks[0].status, "in_progress");
  const credited = applyTaskResults(tasks, results, baseline, { reportedIDs: new Set([1]) });
  assert.equal(credited.tasks[0].status, "completed");
  assert.equal(computeProgress(results, credited.tasks).tasksDone, 1);
});

test("a rejected report stays failed and never completes the task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-task-reject-"));
  const sup = new Supervisor(ctx(root), { enableWorkers: false });
  try {
    await sup.start("ses_test", root, { objective: "Make unit pass", autoDispatch: false });
    await sup.d.saveCriteria(root, {
      version: 2,
      checks: [{ id: "unit", cmd: "test -f missing.txt", expect: "exit0", timeout_ms: 5000 }],
    });
    await sup.saveTasksSafe(root, [
      {
        id: 1,
        subject: "Make unit pass",
        status: "in_progress",
        verify: "unit",
        files: [],
        blocked_by: [],
      },
    ]);
    await sup.saveProgressSafe(root, fromTasks(await sup.d.loadTasks(root)));

    assert.match(await sup.toolCheck("ses_test"), /0\/1 checks green/);
    assert.match(await sup.toolStatus("ses_test"), /Mission:/);
    assert.match(
      await sup.toolReport("ses_test", { role: "auditor", text: "NO FINDINGS" }),
      /Report stored/
    );
    assert.match(
      await sup.toolTaskDone("ses_test", { id: 1, status: "done", summary: "trust me" }),
      /Report rejected/
    );
    assert.equal(
      (await json(path.join(root, ".mission", "tasks.json"))).tasks[0].status,
      "pending",
      "a rejected report releases the lease for retry"
    );
    const state = await sup.d.loadState(root);
    assert.equal(state.task_reports["1"].status, "failed");
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("mission_task_done updates tasks.json so the TUI shows 1/1", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-task-sync-"));
  const sup = new Supervisor(ctx(root), { enableWorkers: false });
  try {
    await sup.start("ses_test", root, {
      objective: "Make npm test pass",
      autoDispatch: false,
    });
    await sup.saveTasksSafe(root, [
      {
        id: 1,
        subject: "Make npm test pass",
        status: "in_progress",
        verify: "unit",
        files: [],
        blocked_by: [],
      },
    ]);
    await sup.saveProgressSafe(root, fromTasks(await sup.d.loadTasks(root)));
    const state = await sup.d.loadState(root);
    state.last_checks = [{ id: "unit", ok: true, summary: "exit 0", evidence: "x" }];
    state.writes = 1;
    await sup.saveStateSafe(root, state);

    const reply = await sup.toolTaskDone("ses_test", {
      id: 1,
      status: "done",
      summary: "Fixed the failing test",
      evidence: ["tests/api.test.js"],
    });
    assert.match(reply, /Report recorded/);
    assert.equal(
      (await json(path.join(root, ".mission", "progress.json"))).tasks[0].status,
      "completed"
    );
    assert.equal(
      (await json(path.join(root, ".mission", "tasks.json"))).tasks[0].status,
      "completed"
    );
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("mission_task_done refuses a report from a session that does not own the lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-task-owner-"));
  const sup = new Supervisor(ctx(root), { enableWorkers: false });
  try {
    await sup.start("ses_test", root, { objective: "Ownership check", autoDispatch: false });
    await sup.saveTasksSafe(root, [
      {
        id: 1,
        subject: "Owned by another worker",
        status: "in_progress",
        verify: "unit",
        files: [],
      },
    ]);
    const progress = fromTasks(await sup.d.loadTasks(root));
    progress[0].status = "in_progress";
    progress[0].owner = "ses_other";
    progress[0].lease_until = Date.now() + 60_000;
    await sup.saveProgressSafe(root, progress);
    const reply = await sup.toolTaskDone("ses_test", {
      id: 1,
      status: "done",
      summary: "I did not actually own this",
    });
    assert.match(reply, /No active lease/);
    const state = await sup.d.loadState(root);
    assert.equal(state.task_reports?.["1"], undefined);
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
