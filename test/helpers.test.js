import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { ensureMission, loadProgress, saveProgress, loadState, saveState } from "../src/mission.js";

function ctx() {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {},
      context: async () => [{ info: { role: "assistant", cost: 0.02 } }],
      synthetic: async () => {},
      create: async () => ({ id: "n" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      wait: async () => {},
      switchModel: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-helpers-"));
  await ensureMission(root, { id: "helpers" });
  const state = await loadState(root);
  state.last_checks = [{ id: "a", ok: false, summary: "exit 1" }];
  await saveState(root, state);
  return root;
}

test("helpers: expired leases are reclaimed and tasks reset", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(ctx());
    await sup.start("lead", root);
    await saveProgress(root, [
      { id: 1, status: "in_progress", owner: "dead", attempts: 0, lease_until: Date.now() - 10 },
    ]);
    await sup.reclaimExpiredLeases(root, await loadProgress(root));
    assert.equal((await loadProgress(root))[0].status, "pending");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("helpers: stop decisions and nudges are built from durable state", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(ctx());
    await sup.start("lead", root);
    const decision = await sup.resolveStopDecision(root, await loadState(root), {
      type: "continue",
    });
    assert.equal(decision.type, "continue");
    const state = await loadState(root);
    state.auto_extend = false;
    const stopped = await sup.resolveStopDecision(root, state, {
      type: "stop",
      reason: "max-turns",
    });
    assert.equal(stopped.type, "stop");
    const nudge = sup.buildNudge({
      sessionID: "lead",
      targetSession: "lead",
      state,
      results: [{ id: "a", ok: false, summary: "exit 1" }],
      tasks: [],
    });
    assert.match(nudge, /MISSION SUPERVISOR/);
    assert.match(nudge, /- a: exit 1/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("helpers: status, cost and durable notes", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(ctx());
    await sup.start("lead", root);
    assert.match(await sup.statusText(root), /Mission:/);
    assert.equal(await sup.sessionCost("lead"), 0.02);
    assert.match(
      await sup.toolFact("lead", { kind: "decision", subject: "x", text: "y" }),
      /Fact stored/
    );
    assert.match(await sup.toolLog("lead", { text: "note" }), /Journal entry appended/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
