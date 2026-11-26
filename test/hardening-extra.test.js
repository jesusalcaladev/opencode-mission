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
  saveState,
  writeTextAtomic,
} from "../src/mission.js";

function fakeCtx({ failCreate = false } = {}) {
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
      prompt: async ({ text }) => prompts.push(text),
      synthetic: async () => {},
      create: async () => {
        if (failCreate) throw new Error("create failed");
        return { id: "worker-extra" };
      },
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
  };
}

async function fixture(root) {
  await ensureMission(root, { objective: "hardening extra" });
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
          status: "completed",
          blocked_by: [],
          verify: "ok",
          files: [],
        },
      ],
    })
  );
}

test("improvement cycle audits, implements and stops on hard budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-extra-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx(), { enableRoles: true });
    await sup.start("lead", root);
    const first = await sup.runImproveCycle("lead", root, await loadState(root), []);
    assert.equal(first.type, "continue");
    assert.match((await loadState(root)).stage_reports.auditor.text, /NO FINDINGS/);

    const state = await loadState(root);
    state.stage_reports.auditor.text = "FINDING: impact=medium risk=low files=a.js description";
    await saveState(root, state);
    await sup.runImproveCycle("lead", root, state, []);
    assert.equal((await loadState(root)).improve_cycles, 1);
    assert.equal((await loadTasks(root)).at(-1).id, 2);

    const limited = await loadState(root);
    limited.hard_budget_usd = 1;
    limited.cost_usd = 2;
    limited.stage_reports = {
      auditor: { text: "FINDING: impact=medium risk=low files=a.js description" },
    };
    const stopped = await sup.runImproveCycle("lead", root, limited, []);
    assert.equal(stopped.type, "complete");
    assert.equal(stopped.reason, "budget");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal audit dispatch and cap stop without endless loops", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-extra-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx(), { enableRoles: true });
    await sup.start("lead", root);
    const state = await loadState(root);
    state.stage = "goal-audit";
    await saveState(root, state);
    const dispatched = await sup.runGoalAudit("lead", root, state, "objective", []);
    assert.equal(dispatched.type, "continue");

    const capped = await loadState(root);
    capped.max_goal_audits = 1;
    capped.goal_audits = 1;
    capped.stage_reports = {
      "goal-auditor": { text: "GAP: requirement=r1 cmd=node --version files=a.txt text=missing" },
    };
    const stopped = await sup.runGoalAudit("lead", root, capped, "objective", []);
    assert.equal(stopped.type, "stop");
    assert.equal(stopped.reason, "goal-gaps");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EXTEND file grants a stop decision one more window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-extra-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx());
    await sup.start("lead", root);
    await writeTextAtomic(path.join(missionDir(root), "EXTEND"), "1\n");
    const state = await loadState(root);
    state.max_extensions = 3;
    const decision = await sup.resolveStopDecision(root, state, {
      type: "stop",
      reason: "budget",
    });
    assert.equal(decision.type, "continue");
    assert.equal(state.extensions, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("handoff failure stays in the same session; duplicate nudges are skipped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-hardening-extra-"));
  try {
    await fixture(root);
    const sup = new Supervisor(fakeCtx({ failCreate: true }));
    await sup.start("lead", root);
    const state = await loadState(root);
    state.turn = 4;
    state.handoff_every_turns = 1;
    assert.equal(await sup.maybeHandoff("lead", root, state), "lead");
    await saveState(root, state);
    const nudge = sup.buildNudge({
      sessionID: "lead",
      targetSession: "lead",
      state,
      results: [],
      tasks: [],
    });
    assert.equal(await sup.deliverNudge(root, "lead", "lead", state, nudge), true);
    assert.equal(await sup.deliverNudge(root, "lead", "lead", state, nudge), false);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
