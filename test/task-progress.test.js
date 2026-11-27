import test from "node:test";
import assert from "node:assert/strict";
import { expandTaskList } from "../src/planner/tasks.js";
import { computeProgress, isTaskVerified } from "../src/mission/progress.js";
import { claim, release, fail, fromTasks } from "../src/mission/lease.js";
import { normalizePlan } from "../src/planner.js";
import { normalizeTask } from "../src/mission/state.js";

test("expandTaskList splits multi-file tasks and remaps dependencies", () => {
  const tasks = [
    {
      id: 1,
      subject: "Build core",
      files: ["a.js", "b.js", "c.js"],
      verify: "build",
      blocked_by: [],
    },
    { id: 2, subject: "Wire UI", files: ["ui.js"], verify: "ui", blocked_by: [1] },
  ];
  const expanded = expandTaskList(tasks, { target: 4 });
  assert.equal(expanded.length, 4);
  assert.deepEqual(
    expanded.map((t) => t.id),
    [1, 2, 3, 4]
  );
  assert.ok(expanded.every((t) => t.files.length === 1));
  assert.deepEqual(expanded.find((t) => t.verify === "ui").blocked_by, [1, 2, 3]);
  assert.deepEqual(
    tasks.map((t) => t.files.length),
    [3, 1],
    "input must not be mutated"
  );
  assert.equal(expandTaskList(tasks, { target: 2, enabled: false }).length, 2);
});

test("progress is task-verified, monotonic and stage-aware", () => {
  const results = [
    { id: "ok", ok: true },
    { id: "red", ok: false },
  ];
  const tasks = [
    { id: 1, status: "completed", verify: "ok" },
    { id: 2, status: "completed", verify: "red" },
    { id: 3, status: "pending", verify: "ok" },
  ];
  assert.equal(isTaskVerified(tasks[0], results), true);
  assert.equal(isTaskVerified(tasks[1], results), false);
  const progress = computeProgress(results, tasks, [{ id: "r1", covered: true }]);
  assert.equal(progress.tasksDone, 1);
  assert.equal(progress.reqCovered, 1);
  const afterReplan = computeProgress([], [], [], progress.pct);
  assert.equal(afterReplan.pct, progress.pct);
  assert.equal(afterReplan.raw_pct, 0);
});

test("progress and expansion handle empty/disabled inputs", () => {
  const empty = computeProgress([], [], [], 0);
  assert.equal(empty.pct, 0);
  assert.equal(empty.raw_pct, 0);
  assert.equal(computeProgress([{ id: "a", ok: true }], [], [], 90).pct, 90);
  const plain = [{ id: 1, subject: "Solo", files: ["a.js"], verify: "ok", blocked_by: [] }];
  assert.equal(expandTaskList(plain, { target: 12 }), plain);
  assert.equal(expandTaskList(plain, { target: 12, enabled: false }), plain);
  assert.equal(isTaskVerified({ status: "pending", verify: "" }, []), false);
  assert.equal(isTaskVerified({ status: "completed" }, []), true);
});

test("leases record start and finish timestamps", () => {
  const progress = fromTasks([{ id: 1, subject: "A", verify: "ok", files: ["a.js"] }]);
  const now = 1_000_000;
  assert.equal(claim(progress, 1, "worker", now, 1000), true);
  assert.equal(progress[0].started_at, now);
  assert.equal(release(progress, 1, "completed"), true);
  assert.ok(progress[0].finished_at >= now);
  assert.equal(claim(progress, 1, "worker2", now + 10, 1000), false);
  fail(progress, 1, "boom", now + 20, 3);
  assert.equal(progress[0].finished_at, now + 20);
});

test("normalizeTask round-trips stage, milestone and hints (no silent data loss)", () => {
  const planned = {
    id: 4,
    subject: "Wire the renderer",
    files: ["render.js"],
    verify: "build",
    blocked_by: [1],
    stage: "implement",
    milestone: "foundation",
    cost_hint: "low",
    time_hint: "10m",
    attempts: 2,
    started_at: 1000,
    finished_at: 2000,
  };
  const normalized = normalizeTask(planned);
  assert.equal(normalized.stage, "implement");
  assert.equal(normalized.milestone, "foundation");
  assert.equal(normalized.cost_hint, "low");
  assert.equal(normalized.attempts, 2);
  assert.equal(normalized.started_at, 1000);
  assert.deepEqual(normalized.blocked_by, [1]);
});

test("normalizePlan keeps stage labels and expands coarse campaign tasks", () => {
  const result = normalizePlan(
    {
      objective: "Build a game engine",
      checks: [
        { id: "build", cmd: "node --check engine.js", expect: "exit0", kind: "build" },
        { id: "e2e", cmd: "node demo.js", expect: "exit0", kind: "e2e" },
      ],
      tasks: [
        {
          id: 1,
          subject: "Engine files",
          files: ["engine.js", "ecs.js", "physics.js", "demo.js"],
          verify: "build",
          milestone: "foundation",
          stage: "build",
        },
      ],
      settings: { autonomy: "campaign" },
    },
    "Build a game engine",
    "/tmp/ws"
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.ok(result.plan.tasks.length >= 4);
  assert.ok(result.plan.tasks.every((t) => t.files.length === 1));
  assert.ok(result.plan.tasks.every((t) => t.stage === "build"));
});
