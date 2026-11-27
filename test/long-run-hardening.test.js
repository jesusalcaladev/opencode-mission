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
import { fromTasks } from "../src/mission/lease.js";
import { reviewFingerprint, alreadyReworked } from "../src/mission/review.js";

function ctx({ failPromptFor = null } = {}) {
  const store = new Map();
  const prompts = [];
  return {
    prompts,
    storage: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) },
    session: {
      context: async () => [],
      prompt: async ({ sessionID, text }) => {
        if (failPromptFor && sessionID === failPromptFor) throw new Error("prompt failed");
        prompts.push({ sessionID, text });
      },
      synthetic: async () => {},
      create: async () => ({ id: "new-session" }),
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

async function fixture(root, checks) {
  await ensureMission(root, { objective: "long run hardening" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({ version: 1, checks })
  );
}

test("handoff rolls back when the new session cannot be prompted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-handoff-safe-"));
  const c = ctx({ failPromptFor: "new-session" });
  const sup = new Supervisor(c, { enableWorkers: false, enableRoles: false });
  try {
    await fixture(root, [
      { id: "red", cmd: "test -f missing.flag", expect: "exit0", timeout_ms: 5000 },
    ]);
    await sup.start("lead", root, { autoDispatch: false });
    const state = await loadState(root);
    state.turn = 1;
    state.handoff_every_turns = 1;
    await saveState(root, state);

    await sup.handleIdle("lead");
    const after = await loadState(root);
    assert.equal(after.session_id, "lead");
    assert.equal(sup.rootFor("lead"), root);
    assert.ok(!sup.rootFor("new-session"));
    assert.equal(sup.pendingHandoffs.size, 0);
    assert.ok(
      (await sup.d.readText(path.join(missionDir(root), "journal.md"), "")).includes(
        "handoff to new-session did not deliver"
      )
    );
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("review rework ignores a finding it already reworked", () => {
  const text = "SEVERITY: high — wrong output";
  const fingerprint = reviewFingerprint(text);
  assert.equal(alreadyReworked({ review_fingerprints: [] }, fingerprint), false);
  assert.equal(alreadyReworked({ review_fingerprints: [fingerprint] }, fingerprint), true);
  assert.equal(alreadyReworked({ review_fingerprints: [fingerprint] }, "other finding"), false);
});

test("goal audit with no verifiable gap does not consume a round or rotate stages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-goal-noop-"));
  const sup = new Supervisor(ctx(), { enableWorkers: false, enableRoles: false });
  try {
    await fixture(root, [{ id: "unit", cmd: "node --version", expect: "exit0", timeout_ms: 5000 }]);
    const state = await loadState(root);
    state.goal_audits = 0;
    state.stage_reports = {
      "goal-auditor": { text: "GAP: requirement=foo check=does_not_exist still missing" },
    };
    await saveState(root, state);
    const before = (await loadTasks(root)).length;
    const decision = await sup.runGoalAudit("lead", root, state, "objective", []);
    assert.equal(decision.type, "continue");
    const after = await loadState(root);
    assert.equal(after.goal_audits, 0);
    assert.equal(after.goal_audit_done, true);
    assert.equal((await loadTasks(root)).length, before);
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a quiet worker with a failing re-prompt is finalized without renewing its lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-quiet-worker-"));
  const c = ctx({ failPromptFor: "w1" });
  c.session.prompt = async ({ sessionID }) => {
    if (sessionID === "w1") throw new Error("prompt failed");
  };
  const sup = new Supervisor(c, { enableWorkers: false, enableRoles: false });
  try {
    await fixture(root, [{ id: "unit", cmd: "node --version", expect: "exit0", timeout_ms: 5000 }]);
    await sup.start("lead", root, { autoDispatch: false });
    await sup.saveTasksSafe(root, [
      { id: 1, subject: "task", files: ["a.js"], status: "in_progress", verify: "unit" },
    ]);
    const progress = fromTasks(await sup.d.loadTasks(root));
    progress[0].status = "in_progress";
    progress[0].owner = "w1";
    const leaseUntil = Date.now() + 120_000;
    progress[0].lease_until = leaseUntil;
    await sup.saveProgressSafe(root, progress);
    sup.bind("w1", root, false);
    sup.workers.set("w1", { root, taskId: 1, leadID: "lead", role: "implementer", revives: 0 });
    const state = await loadState(root);
    state.worker_timeout_ms = 30_000;
    await saveState(root, state);

    await sup.watchWorker({ id: "w1", task: { id: 1 } }, "lead", root, state, root);
    const after = await sup.d.loadProgress(root);
    assert.ok(after[0].lease_until <= leaseUntil, "a failed re-prompt must not renew the lease");
    assert.equal(sup.workers.has("w1"), false);
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
