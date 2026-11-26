import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import {
  ensureMission,
  loadState,
  loadTasks,
  missionDir,
  saveProgress,
  saveState,
  writeTextAtomic,
} from "../src/mission.js";

function fakeCtx({ fallbackModel = null } = {}) {
  const store = new Map();
  return {
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      context: async () => [
        { info: { role: "assistant", cost: 0.02, tokens: { input: 10, output: 5 } } },
      ],
      prompt: async () => {},
      synthetic: async () => {},
      create: async () => ({ id: "worker-x" }),
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({
        id: sessionID,
        outcome: "complete",
        time: { idle: 1, busy: 0 },
      }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
    fallbackModel,
  };
}

async function fixture(root) {
  await ensureMission(root, { objective: "hardening" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({
      version: 1,
      checks: [{ id: "ok", cmd: "node --version", expect: "exit0", timeout_ms: 5000 }],
    })
  );
  await writeTextAtomic(
    path.join(missionDir(root), "tasks.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 1,
          subject: "Task one",
          status: "pending",
          blocked_by: [],
          verify: "ok",
          files: ["a.txt"],
        },
      ],
    })
  );
}

test("worker failure releases its lease without aborting the mission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx());
    await sup.start("lead", root);
    await saveProgress(root, [
      {
        id: 1,
        subject: "Task one",
        status: "in_progress",
        owner: "worker-1",
        attempts: 0,
        lease_until: Date.now() + 60_000,
        last_error: "",
        verify: "ok",
      },
    ]);
    sup.bind("worker-1", root, false);
    sup.workers.set("worker-1", { root, taskId: 1, leadID: "lead", role: "implementer" });
    sup.knownWorkers.add("worker-1");
    await sup.handleFailure("worker-1", new Error("worker died"));
    const progress = await sup.d.loadProgress(root);
    assert.equal(progress[0].attempts, 1);
    assert.equal(progress[0].owner, null);
    assert.equal((await loadState(root)).status, "running");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lead failures dedupe, then abort at the ceiling when not relentless", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx());
    await sup.start("lead", root);
    const state = await loadState(root);
    state.max_failures = 1;
    await saveState(root, state);
    await sup.handleFailure("lead", new Error("boom"));
    await sup.handleFailure("lead", new Error("boom"));
    assert.equal((await loadState(root)).failures, 1);
    const fresh = await loadState(root);
    fresh.last_failure_at = Date.now() - 5000;
    await saveState(root, fresh);
    await sup.handleFailure("lead", new Error("boom again"));
    const final = await loadState(root);
    assert.equal(final.status, "aborted");
    assert.equal(final.finish_reason, "repeated-execution-failure");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured fallback model is used on quota errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-"));
  try {
    await fixture(root);
    const switched = [];
    const ctx = fakeCtx({ fallbackModel: { providerID: "p", id: "fallback" } });
    ctx.session.switchModel = async ({ model }) => switched.push(model);
    const sup = new Supervisor(ctx, { fallbackModel: ctx.fallbackModel });
    await sup.start("lead", root);
    await sup.rotateModel("lead", "429 rate limit");
    assert.equal(switched.length, 1);
    assert.equal(switched[0].id, "fallback");
    await sup.rotateModel("lead", "all good");
    assert.equal(switched.length, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal audit turns a GAP into a verifiable task and then reports clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx());
    await sup.start("lead", root);
    const state = await loadState(root);
    state.stage = "goal-audit";
    state.stage_reports = {
      "goal-auditor": {
        text: "GAP: requirement=r1 cmd=node --version files=a.txt text=missing coverage",
      },
    };
    await saveState(root, state);
    const first = await sup.runGoalAudit("lead", root, state, "objective", [
      { id: "ok", ok: true },
    ]);
    assert.equal(first.type, "continue");
    const tasks = await loadTasks(root);
    assert.ok(tasks.some((t) => t.id === 2 && t.verify === "goal-2"));
    const clean = await loadState(root);
    clean.stage_reports["goal-auditor"] = { text: "NO GAPS" };
    await saveState(root, clean);
    const second = await sup.runGoalAudit("lead", root, clean, "objective", []);
    assert.equal(second.type, "continue");
    assert.equal((await loadState(root)).goal_audit_done, true);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation cost and recorded worker tokens feed the durable ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx());
    await sup.start("lead", root);
    assert.equal(sup.noteGeneration(root, { cost: 0.25 }), 0.25);
    const state = await loadState(root);
    state.agent_runs = [{ sessionID: "worker-1", status: "done", cost: 0.5, tokens: 100 }];
    await saveState(root, state);
    const fresh = await loadState(root);
    await sup.recordWorkerCost(root, fresh, "worker-1");
    assert.equal(sup.missionCostTotal(fresh, sup.generationCosts.get(root)), 0.75);
    assert.equal(fresh.tokens, 100);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
