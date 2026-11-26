import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { decideNext } from "../src/mission/decide.js";
import { normalizePlan } from "../src/planner.js";
import { stageFor, STAGE } from "../src/mission/roles.js";
import { autoExtendDecision } from "../src/mission/chain.js";
import { attemptLimit, claim, fail, retryable } from "../src/mission/lease.js";
import { budgetExhausted, cycleDecision } from "../src/mission/improve.js";
import {
  initialState,
  missionDir,
  ensureMission,
  saveState,
  loadState,
  writeTextAtomic,
} from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

const plan = {
  objective: "Never stop until the goal is verified",
  checks: [{ id: "done", cmd: "test -f done.txt", expect: "exit0", timeout_ms: 5000, kind: "e2e" }],
  tasks: [
    { id: 1, subject: "Create done.txt", files: ["done.txt"], verify: "done", blocked_by: [] },
  ],
};

test("normalizePlan turns relentless into unlimited soft effort ceilings", () => {
  const result = normalizePlan(
    { ...plan, settings: { autonomy: "relentless" } },
    plan.objective,
    "/tmp/ws"
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  const s = result.plan.settings;
  assert.equal(s.never_give_up, true);
  assert.equal(s.max_turns, 0);
  assert.equal(s.max_failures, 0);
  assert.equal(s.max_extensions, 0);
  assert.equal(s.max_task_attempts, 0);
  assert.equal(s.max_review_attempts, 0);
  assert.equal(s.max_goal_audits, 0);
  assert.equal(s.auto_extend, true);
  assert.ok(s.hard_budget_usd > 0);
  assert.ok(s.max_wallclock_min > 0);
});

test("decideNext converts a blocked verdict into a forced re-plan in relentless mode", () => {
  const state = { ...initialState(), never_give_up: true, max_turns: 0, turn: 100 };
  const decision = decideNext({
    state,
    results: [{ id: "done", ok: false }],
    tasks: [],
    verdict: { status: "blocked", unblock: "needs a new approach" },
    stopFile: false,
    pauseFile: false,
    criteria: { checks: [] },
  });
  assert.equal(decision.type, "replan");
  assert.equal(decision.unblock, "needs a new approach");
  const standard = decideNext({
    state: { ...state, never_give_up: false },
    results: [],
    tasks: [],
    verdict: { status: "blocked" },
    stopFile: false,
    pauseFile: false,
    criteria: { checks: [] },
  });
  assert.equal(standard.type, "stop");
  assert.equal(standard.reason, "blocked");
});

test("relentless review and extensions ignore attempt counts but keep hard caps", () => {
  assert.equal(
    stageFor({
      stage: STAGE.REVIEW,
      tasksDone: true,
      review: { ok: false, high: [{ line: "x" }] },
      reviewAttempts: 50,
      maxReviewAttempts: 0,
      extended: true,
    }).decision,
    "retry"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "budget" },
      state: { auto_extend: true, max_extensions: 0, cost_usd: 1, hard_budget_usd: 25 },
      progress: true,
    }).type,
    "extend"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "hard-budget" },
      state: { auto_extend: true, max_extensions: 0, cost_usd: 25, hard_budget_usd: 25 },
      progress: true,
    }).type,
    "stop"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "deadline" },
      state: {
        auto_extend: true,
        max_extensions: 0,
        max_wallclock_min: 1,
        started_at: "2020-01-01T00:00:00Z",
      },
      progress: true,
    }).reason,
    "deadline"
  );
});

test("unlimited task attempts never mark a task FAILED", () => {
  const state = { max_task_attempts: 0 };
  const progress = [{ id: 1, subject: "x", status: "pending", attempts: 0, lease_until: 0 }];
  assert.equal(attemptLimit(state), 0);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(claim(progress, 1, `w${i}`, i * 10, 5, 0), true);
    fail(progress, 1, "boom", i * 10 + 6, 0);
    assert.equal(retryable(progress, 1, 0), true);
  }
  assert.equal(progress[0].status, "pending");
});

test("budgetExhausted respects hard budget and continuous-improvement cycles", () => {
  assert.equal(budgetExhausted({ cost_usd: 26, hard_budget_usd: 25, auto_extend: true }), true);
  assert.equal(budgetExhausted({ cost_usd: 9, budget_usd: 5, auto_extend: true }), false);
  assert.equal(budgetExhausted({ cost_usd: 9, budget_usd: 5 }), true);
  assert.equal(
    cycleDecision({ finding: { text: "x" }, improveCycles: 100, maxCycles: 0 }).type,
    "implement"
  );
});

function fakeCtx() {
  const store = new Map();
  const prompts = [];
  return {
    prompts,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      context: async () => [],
      prompt: async ({ sessionID, text }) => {
        if (!sessionID?.startsWith("worker")) prompts.push(text);
      },
      synthetic: async () => {},
      create: async ({ parentID }) => ({ id: parentID ? "worker-x" : "lead-x" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
      wait: async () => {},
      switchModel: async () => {},
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-relentless-"));
  await ensureMission(root, { objective: "relentless" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({
      version: 1,
      checks: [
        { id: "done", cmd: "test -f done.txt", expect: "exit0", timeout_ms: 5000, kind: "e2e" },
      ],
    })
  );
  await writeTextAtomic(
    path.join(missionDir(root), "tasks.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        { id: 1, subject: "Create done.txt", status: "pending", blocked_by: [], verify: "done" },
      ],
    })
  );
  return root;
}

test("supervisor: blocked verdict re-plans instead of ending a relentless mission", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx, { enableWorkers: false, enableRoles: false });
    await sup.start("lead-x", root);
    const state = await loadState(root);
    state.never_give_up = true;
    state.last_verdict = { status: "blocked", unblock: "try another approach" };
    await saveState(root, state);
    await sup.handleIdle("lead-x");
    const after = await loadState(root);
    assert.equal(after.status, "running");
    assert.equal(after.finish_reason, null);
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /forced retry/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: an unexpected error recovers in relentless mode", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx, { enableWorkers: false, enableRoles: false });
    await sup.start("lead-x", root);
    const state = await loadState(root);
    state.never_give_up = true;
    await saveState(root, state);
    sup.updateMissionCost = async () => {
      throw new Error("injected supervisor failure");
    };
    await sup.handleIdle("lead-x");
    const after = await loadState(root);
    assert.equal(after.status, "running");
    assert.equal(after.failures, 0);
    assert.equal(after.last_prompt_at, 0);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: failure ceiling resets in relentless mode instead of aborting", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("lead-x", root);
    const state = await loadState(root);
    state.never_give_up = true;
    state.max_failures = 1;
    await saveState(root, state);
    await sup.handleFailure("lead-x", new Error("boom"));
    const after = await loadState(root);
    assert.equal(after.status, "running");
    assert.equal(after.failures, 0);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
