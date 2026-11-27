import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  applyTaskResults,
  captureBaseline,
  decideNext,
  markBaselineRed,
  verifyingTransition,
} from "../src/mission/decide.js";
import { mutationDecision, mutationSettings } from "../src/mission/quality.js";
import { normalizePlan } from "../src/planner.js";
import { ensureMission, initialState } from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

test("a check that was green at baseline cannot complete a task", () => {
  const tasks = [{ id: 1, status: "pending", verify: "a" }];
  const results = [{ id: "a", ok: true }];
  assert.equal(applyTaskResults(tasks, results).tasks[0].status, "completed");
  assert.equal(applyTaskResults(tasks, results, { a: true }).tasks[0].status, "pending");
  assert.equal(applyTaskResults(tasks, results, { a: false }).tasks[0].status, "completed");
  assert.equal(
    applyTaskResults([{ id: 1, status: "pending" }], [], { a: false }).tasks[0].status,
    "pending",
    "a task without a verify check needs an explicit done report"
  );
  assert.equal(
    applyTaskResults(
      [{ id: 1, status: "pending" }],
      [],
      { a: false },
      {
        reportedIDs: new Set([1]),
      }
    ).tasks[0].status,
    "completed"
  );
});

test("one green check does not credit several unreported tasks, and red reopens", () => {
  const tasks = [
    { id: 1, status: "pending", verify: "unit" },
    { id: 2, status: "pending", verify: "unit" },
  ];
  const results = [{ id: "unit", ok: true }];
  const unreported = applyTaskResults(tasks, results, { unit: false });
  assert.deepEqual(
    unreported.tasks.map((t) => t.status),
    ["pending", "pending"]
  );
  const reported = applyTaskResults(tasks, results, { unit: false }, { reportedIDs: new Set([2]) });
  assert.deepEqual(
    reported.tasks.map((t) => t.status),
    ["pending", "completed"]
  );
  const completed = [{ id: 1, status: "completed", verify: "unit" }];
  const regressed = applyTaskResults(
    completed,
    [{ id: "unit", ok: false }],
    { unit: false },
    { reopenRed: true }
  );
  assert.equal(regressed.tasks[0].status, "pending");
});

test("baseline capture, red marking and transitions are monotone", () => {
  const first = captureBaseline([{ id: "a", ok: true }]);
  assert.deepEqual(first, { a: true });
  assert.deepEqual(
    captureBaseline(
      [
        { id: "a", ok: false },
        { id: "b", ok: true },
      ],
      first
    ),
    {
      a: true,
      b: true,
    }
  );
  assert.deepEqual(markBaselineRed(first, ["a", "c"], true), { a: true, c: false });
  assert.equal(verifyingTransition([{ id: "a", ok: true }], { a: false }), true);
  assert.equal(verifyingTransition([{ id: "a", ok: true }], { a: true }), false);
});

test("decideNext refuses a vacuous completion with a baseline", () => {
  const base = {
    state: { ...initialState(), budget_usd: 0, max_turns: 0 },
    results: [{ id: "a", ok: true }],
    tasks: [{ id: 1, status: "completed", verify: "a" }],
    verdict: null,
    stopFile: false,
    pauseFile: false,
    criteria: { checks: [{ id: "a" }] },
  };
  assert.equal(decideNext(base).type, "complete");
  assert.equal(decideNext({ ...base, baseline: { a: true } }).type, "continue");
  assert.equal(decideNext({ ...base, baseline: { a: false } }).type, "complete");
});

test("mutation decision marks a check vacuous only when it survives removal", () => {
  assert.equal(mutationSettings({ never_give_up: true }), true);
  assert.equal(mutationSettings({ mutation_checks: false, never_give_up: true }), false);
  assert.equal(mutationSettings({}), false);
  assert.equal(mutationDecision({ mutatedOk: true, files: ["a.js"] }).reason, "vacuous-check");
  assert.equal(mutationDecision({ mutatedOk: false, files: ["a.js"] }).ok, true);
  assert.equal(mutationDecision({ mutatedOk: true, files: [] }).reason, "skipped");
});

test("relentless plans are repaired with a real e2e or smoke check", () => {
  const base = {
    objective: "o",
    checks: [{ id: "a", cmd: "node --test", expect: "exit0" }],
    tasks: [{ id: 1, subject: "Do it", files: ["a.js"], verify: "a", blocked_by: [] }],
    settings: { autonomy: "relentless" },
  };
  const repaired = normalizePlan(base, "o", "/tmp/ws");
  assert.equal(repaired.ok, true, repaired.errors.join("; "));
  assert.ok(
    repaired.plan.checks.some((c) => c.kind === "e2e" || c.kind === "smoke"),
    "a missing e2e label must be repaired, not reject the whole plan into a smaller fallback"
  );
  const accepted = normalizePlan(
    { ...base, checks: [{ ...base.checks[0], kind: "e2e" }] },
    "o",
    "/tmp/ws"
  );
  assert.equal(accepted.ok, true, accepted.errors.join("; "));
});

test("the two reviewers use distinct models when the catalog allows it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-quality-"));
  const created = [];
  const store = new Map();
  const ctx = {
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      create: async ({ title, model }) => {
        created.push({ id: `rev-${created.length}`, title, model });
        return { id: `rev-${created.length}` };
      },
      prompt: async () => {},
      wait: async () => {},
      context: async () => [],
      synthetic: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
    },
    model: {
      default: async () => null,
      list: async () => [
        { providerID: "p", id: "m1", cost: [{ output: 0 }] },
        { providerID: "p", id: "m2", cost: [{ output: 0 }] },
      ],
    },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
  try {
    await ensureMission(root, { objective: "review" });
    const sup = new Supervisor(ctx, { enableWorkers: false });
    await sup.start("lead", root);
    const state = await sup.d.loadState(root);
    await sup.dispatchReviewPair("lead", root, state, "review", []);
    assert.equal(created.length, 2);
    assert.notEqual(created[0].id, created[1].id);
    assert.notEqual(created[0].model?.id, created[1].model?.id);
    assert.match(created[0].title, /reviewer/);
    assert.match(created[1].title, /reviewer2/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
