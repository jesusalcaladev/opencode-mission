import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import {
  applyAutoExtension,
  autoExtendDecision,
  CAMPAIGN_EXTEND_TURNS,
} from "../src/mission/chain.js";
import { appendHistory, campaignSettings, recentProgress } from "../src/mission/autonomy.js";
import { requirementsMet, decideNext } from "../src/mission/decide.js";
import { parseGaps, stageFor, STAGE, ROLE, canWrite } from "../src/mission/roles.js";
import { validateMonotonic, normalizePlan } from "../src/planner.js";
import { pauseRequested } from "../src/mission.js";

const baseState = () => ({
  status: "running",
  turn: 40,
  max_turns: 40,
  cost_usd: 3,
  budget_usd: 5,
  hard_budget_usd: 25,
  auto_extend: true,
  extensions: 0,
  max_extensions: 50,
  extension_turns: 20,
  extension_budget_usd: 5,
  extension_writes: 200,
  max_writes: 500,
  writes: 480,
  started_at: new Date(Date.now() - 60 * 60_000).toISOString(),
  max_wallclock_min: 480,
  last_progress_turn: 40,
  best_green: 3,
  tasks_done: 2,
  history: [],
});

test("campaign: auto-extend only on progress and never past hard caps", () => {
  const state = baseState();
  assert.equal(
    autoExtendDecision({ decision: { type: "stop", reason: "max-turns" }, state, progress: true })
      .type,
    "extend"
  );
  assert.equal(
    autoExtendDecision({ decision: { type: "stop", reason: "max-turns" }, state, progress: false })
      .reason,
    "stalled"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "budget" },
      state: { ...state, cost_usd: 25 },
      progress: true,
    }).reason,
    "hard-budget"
  );
  assert.equal(
    autoExtendDecision({ decision: { type: "stop", reason: "hard-budget" }, state, progress: true })
      .reason,
    "hard-budget"
  );
  assert.equal(
    autoExtendDecision({ decision: { type: "stop", reason: "paused" }, state, progress: true })
      .reason,
    "paused"
  );
  assert.equal(
    autoExtendDecision({ decision: { type: "stop", reason: "blocked" }, state, progress: true })
      .reason,
    "blocked"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "max-turns" },
      state: { ...state, extensions: 50 },
      progress: true,
    }).reason,
    "extension-limit"
  );
  assert.equal(
    autoExtendDecision({ decision: { type: "continue" }, state, progress: true }).type,
    "work"
  );
});

test("campaign: applyAutoExtension raises windows but respects hard budget", () => {
  const state = baseState();
  const next = applyAutoExtension(state);
  assert.equal(next.extensions, 1);
  assert.equal(next.max_turns, state.max_turns + CAMPAIGN_EXTEND_TURNS);
  assert.equal(next.max_writes, state.max_writes + 200);
  assert.equal(next.budget_usd, 10);
  const capped = applyAutoExtension({ ...state, budget_usd: 24 });
  assert.equal(capped.budget_usd, 25);
  assert.equal(state.extensions, 0, "original state is not mutated");
});

test("campaign: recentProgress and history track verified progress", () => {
  const state = baseState();
  assert.equal(recentProgress(state), true);
  assert.equal(recentProgress({ ...state, last_progress_turn: 10 }), false);
  assert.equal(recentProgress({ ...state, best_green: 0, tasks_done: 0 }), false);
  const withHistory = appendHistory(state, {
    results: [
      { id: "a", ok: true },
      { id: "b", ok: false },
    ],
    tasks: [{ id: 1, status: "completed" }],
  });
  assert.equal(withHistory.at(-1).green, 1);
  assert.equal(withHistory.at(-1).done, 1);
});

test("campaign: requirements must be covered before completion", () => {
  const criteria = { requirements: [{ id: "r1", checks: ["e2e"] }] };
  const green = [{ id: "e2e", ok: true }];
  const red = [{ id: "e2e", ok: false }];
  assert.equal(requirementsMet(criteria, green), true);
  assert.equal(requirementsMet(criteria, red), false);
  const decision = decideNext({
    state: { ...baseState(), turn: 0 },
    results: green,
    tasks: [{ id: 1, status: "completed" }],
    criteria,
  });
  assert.equal(decision.type, "complete");
  const uncovered = decideNext({
    state: { ...baseState(), turn: 0 },
    results: [{ id: "build", ok: true }],
    tasks: [{ id: 1, status: "completed" }],
    criteria,
  });
  assert.equal(uncovered.type, "continue");
  assert.equal(uncovered.requirementsOk, false);
});

test("campaign: pause file and hard budget stop before soft budgets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-campaign-"));
  try {
    await mkdir(path.join(root, ".mission"), { recursive: true });
    assert.equal(await pauseRequested(root), false);
    await writeFile(path.join(root, ".mission", "PAUSE"), "");
    assert.equal(await pauseRequested(root), true);
    const state = baseState();
    assert.equal(decideNext({ state, results: [], tasks: [], pauseFile: true }).reason, "paused");
    assert.equal(
      decideNext({ state: { ...state, cost_usd: 26 }, results: [], tasks: [] }).reason,
      "hard-budget"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("campaign: extended stage machine includes integrate and goal audit", () => {
  assert.deepEqual(stageFor({ stage: STAGE.IMPLEMENT, tasksDone: true, extended: true }), {
    stage: STAGE.INTEGRATE,
    decision: "continue",
  });
  assert.deepEqual(stageFor({ stage: STAGE.INTEGRATE, tasksDone: true, extended: true }), {
    stage: STAGE.VERIFY,
    decision: "continue",
  });
  assert.equal(
    stageFor({
      stage: STAGE.REVIEW,
      tasksDone: true,
      review: { ok: true },
      extended: true,
      goalAudit: true,
      goalAuditDone: false,
    }).stage,
    STAGE.GOAL_AUDIT
  );
  assert.equal(
    stageFor({
      stage: STAGE.GOAL_AUDIT,
      tasksDone: true,
      review: { ok: true },
      extended: true,
      goalAudit: true,
      goalAuditDone: true,
    }).decision,
    "complete"
  );
  assert.equal(canWrite(ROLE.INTEGRATOR), true);
  assert.equal(canWrite(ROLE.RESEARCHER), false);
});

test("campaign: goal audit parses GAP lines", () => {
  const gaps = parseGaps(
    "GAP: requirement=r1 check=e2e files=engine.js missing game loop\nNO GAPS"
  );
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].requirement, "r1");
  assert.equal(gaps[0].check, "e2e");
  assert.deepEqual(gaps[0].files, ["engine.js"]);
});

test("campaign: re-plan cannot drop green checks or completed tasks", () => {
  const plan = {
    checks: [{ id: "a", cmd: "true", expect: "exit0" }],
    tasks: [{ id: 1, subject: "x" }],
  };
  const bad = validateMonotonic(
    plan,
    [{ id: "build", ok: true }],
    [{ id: 2, status: "completed" }]
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  const good = validateMonotonic(plan, [{ id: "a", ok: true }], []);
  assert.equal(good.ok, true);
});

test("campaign: normalizePlan accepts requirements and campaign settings", () => {
  const raw = {
    objective: "Build a complete 2D game engine",
    definition_of_done: ["headless run works"],
    checks: [
      { id: "build", cmd: "node --check engine.js", kind: "build", expect: "exit0" },
      { id: "e2e", cmd: "node demo.js", kind: "e2e", expect: "exit0" },
    ],
    tasks: [{ id: 1, subject: "Engine core", files: ["engine.js"], verify: "build" }],
    requirements: [{ id: "r1", text: "It runs", checks: ["e2e"] }],
    milestones: [{ id: "m1", title: "Core" }],
    settings: { autonomy: "campaign", goal_audit: true },
  };
  const result = normalizePlan(raw, raw.objective, "/tmp/x");
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.plan.settings.autonomy, "campaign");
  assert.equal(result.plan.settings.max_turns, 40);
  assert.equal(result.plan.settings.auto_extend, true);
  assert.equal(result.plan.requirements[0].id, "r1");
  assert.equal(result.plan.checks[1].kind, "e2e");
});

test("campaign: campaignSettings provides long-run defaults", () => {
  const s = campaignSettings({ settings: { autonomy: "campaign" } });
  assert.equal(s.max_turns, 40);
  assert.equal(s.auto_extend, true);
  assert.equal(s.max_wallclock_min, 480);
  assert.equal(s.hard_budget_usd, 25);
  assert.equal(s.goal_audit, true);
});
