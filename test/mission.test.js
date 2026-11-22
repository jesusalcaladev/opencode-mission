import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import {
  STATUS,
  applyTaskResults,
  buildBrief,
  decideNext,
  ensureMission,
  loadCriteria,
  loadState,
  loadTasks,
  nextStrategy,
  objectiveOf,
  selectTask,
  stopRequested,
  writeTextAtomic,
} from "../src/mission.js";
import { evaluateExpect, runChecks } from "../src/checks.js";

const baseState = (over = {}) => ({
  status: STATUS.RUNNING,
  turn: 1,
  cost_usd: 0.2,
  max_turns: 12,
  budget_usd: 5,
  best_green: 0,
  strategy_tier: 1,
  last_checks: [],
  ...over,
});

test("expect evaluation: exit0 and contains", () => {
  assert.equal(evaluateExpect("exit0", { code: 0, stdout: "" }), true);
  assert.equal(evaluateExpect("exit0", { code: 1, stdout: "" }), false);
  assert.equal(evaluateExpect("contains:1.0.0", { code: 0, stdout: "1.0.0\n" }), true);
  assert.equal(evaluateExpect("contains:1.0.0", { code: 0, stdout: "2.0.0\n" }), false);
  assert.equal(evaluateExpect("contains:1.0.0", { code: 1, stdout: "1.0.0\n" }), false);
});

test("selectTask respects blocked_by", () => {
  const tasks = [
    { id: 1, subject: "a", status: "completed", blocked_by: [] },
    { id: 2, subject: "b", status: "pending", blocked_by: [1] },
    { id: 3, subject: "c", status: "pending", blocked_by: [2] },
  ];
  assert.equal(selectTask(tasks).id, 2);
  tasks[1].status = "completed";
  assert.equal(selectTask(tasks).id, 3);
  assert.equal(selectTask(tasks.map((t) => ({ ...t, status: "completed" }))), null);
});

test("the harness completes tasks from green checks, including chains", () => {
  const tasks = [
    { id: 1, subject: "a", status: "pending", blocked_by: [], verify: "a" },
    { id: 2, subject: "b", status: "pending", blocked_by: [1], verify: "b" },
    { id: 3, subject: "c", status: "pending", blocked_by: [2], verify: "c" },
  ];
  const first = applyTaskResults(tasks, [{ id: "a", ok: true }]);
  assert.equal(first.tasks[0].status, "completed");
  assert.equal(first.tasks[1].status, "pending");
  const all = applyTaskResults(tasks, [
    { id: "a", ok: true },
    { id: "b", ok: true },
    { id: "c", ok: true },
  ]);
  assert.deepEqual(
    all.tasks.map((t) => t.status),
    ["completed", "completed", "completed"]
  );
});

test("decideNext: a red check never completes, even with a met verdict", () => {
  const d = decideNext({
    state: baseState(),
    results: [{ id: "a", ok: false }],
    tasks: [{ id: 1, status: "completed" }],
    verdict: { status: "met", summary: "done trust me" },
    stopFile: false,
  });
  assert.equal(d.type, "continue");
});

test("decideNext: green checks plus finished tasks complete; the verdict is not needed", () => {
  const d = decideNext({
    state: baseState(),
    results: [
      { id: "a", ok: true },
      { id: "b", ok: true },
    ],
    tasks: [{ id: 1, status: "completed" }],
    verdict: null,
    stopFile: false,
  });
  assert.equal(d.type, "complete");
});

test("decideNext: STOP file, budget, turn ceiling and blocked verdict", () => {
  const green = [{ id: "a", ok: true }];
  const done = [{ id: 1, status: "completed" }];
  assert.equal(
    decideNext({ state: baseState(), results: green, tasks: done, stopFile: true }).reason,
    "stop-file"
  );
  assert.equal(
    decideNext({ state: baseState({ cost_usd: 5 }), results: green, tasks: done }).reason,
    "budget"
  );
  assert.equal(
    decideNext({ state: baseState({ turn: 12 }), results: green, tasks: done }).reason,
    "max-turns"
  );
  const blocked = decideNext({
    state: baseState(),
    results: [],
    tasks: [],
    verdict: { status: "blocked", summary: "no key", unblock: "provide a key" },
  });
  assert.equal(blocked.reason, "blocked");
  assert.equal(blocked.unblock, "provide a key");
});

test("decideNext: wall-clock deadline stops the mission", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const state = baseState({
    started_at: "2026-11-21T11:00:00Z",
    max_wallclock_min: 30,
  });
  const d = decideNext({
    state,
    results: [{ id: "a", ok: true }],
    tasks: [{ id: 1, status: "completed" }],
    now,
  });
  assert.equal(d.type, "stop");
  assert.equal(d.reason, "deadline");
});

test("strategy escalates only without verified progress", () => {
  assert.equal(nextStrategy(1, false), 2);
  assert.equal(nextStrategy(2, false), 3);
  assert.equal(nextStrategy(3, false), 3);
  assert.equal(nextStrategy(3, true), 2);
});

test("objectiveOf and buildBrief carry the rules and the current state", () => {
  const text = "---\nid: x\n---\nShip the thing.\nmore prose\n";
  assert.equal(objectiveOf(text), "Ship the thing.");
  const brief = buildBrief({
    root: "/tmp/m",
    missionText: text,
    state: baseState({ turn: 4 }),
    tasks: [{ id: 7, subject: "next", status: "pending", blocked_by: [] }],
    journal: "trial one failed",
    results: [{ id: "a", ok: false, summary: "exit 1" }],
  });
  assert.match(brief, /Ship the thing\./);
  assert.match(brief, /#7 next/);
  assert.match(brief, /a: exit 1/);
  assert.match(brief, /mission_verdict/);
  assert.match(brief, /Turn 4\/12/);
});

test("ensureMission is idempotent and STOP is detected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-test-"));
  try {
    const first = await ensureMission(root, { objective: "Do the work." });
    await writeFile(
      path.join(first.dir, "criteria.json"),
      '{"checks":[{"id":"x","cmd":"true","expect":"exit0"}]}'
    );
    await ensureMission(root);
    const criteria = await loadCriteria(root);
    assert.equal(criteria.checks[0].id, "x");
    assert.equal((await loadState(root)).max_turns, 12);
    assert.equal((await loadTasks(root)).length, 1);
    assert.equal(await stopRequested(root), false);
    await writeTextAtomic(first.stopPath, "");
    assert.equal(await stopRequested(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runChecks writes evidence and reports red/green honestly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-checks-"));
  try {
    await writeFile(path.join(root, "cli.js"), 'console.log("1.0.0")');
    const criteria = {
      checks: [
        { id: "version", cmd: "node cli.js", expect: "contains:1.0.0", timeout_ms: 5000 },
        { id: "missing", cmd: "node nope.js", expect: "exit0", timeout_ms: 5000 },
      ],
    };
    const results = await runChecks(root, criteria);
    assert.deepEqual(
      results.map((r) => r.ok),
      [true, false]
    );
    assert.equal(results[0].evidence, path.join(".mission", "evidence", "version.txt"));
    assert.match(results[0].summary, /1\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
