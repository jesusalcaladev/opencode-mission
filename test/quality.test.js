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
    "completed"
  );
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

test("relentless plans require a real e2e or smoke check", () => {
  const base = {
    objective: "o",
    checks: [{ id: "a", cmd: "node --test", expect: "exit0" }],
    tasks: [{ id: 1, subject: "Do it", files: ["a.js"], verify: "a", blocked_by: [] }],
    settings: { autonomy: "relentless" },
  };
  const rejected = normalizePlan(base, "o", "/tmp/ws");
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(" "), /e2e or smoke/);
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
