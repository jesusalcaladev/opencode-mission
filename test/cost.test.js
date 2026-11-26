import test from "node:test";
import assert from "node:assert/strict";
import { Supervisor } from "../src/supervisor.js";
import {
  costFromContext,
  mergeCosts,
  applyCost,
  generationCost,
  sessionIDsForMission,
} from "../src/mission/cost.js";

test("costFromContext sums assistant costs and ignores other roles", () => {
  assert.equal(
    costFromContext([
      { info: { role: "assistant", cost: 0.25 } },
      { info: { role: "user", cost: 99 } },
      { role: "assistant", cost: 0.5 },
    ]),
    0.75
  );
  assert.equal(costFromContext([{ info: { role: "user" } }]), null);
  assert.equal(costFromContext(null), null);
});

test("mergeCosts is idempotent and keeps the maximum per session", () => {
  const a = [
    { sessionID: "lead", cost: 1 },
    { sessionID: "worker-1", cost: 2 },
    { sessionID: "lead", cost: 1.5 },
    { sessionID: "worker-2", cost: NaN },
  ];
  assert.equal(mergeCosts(a), 3.5);
  assert.equal(mergeCosts([...a, ...a]), 3.5);
  assert.equal(mergeCosts([]), 0);
});

test("applyCost never decreases the durable total", () => {
  assert.equal(applyCost({ cost_usd: 4 }, 2), 4);
  assert.equal(applyCost({ cost_usd: 0 }, 2.5), 2.5);
  assert.equal(applyCost({ cost_usd: 1 }, null), 1);
});

test("generationCost reads provider cost shapes", () => {
  assert.equal(generationCost({ cost: 0.2 }), 0.2);
  assert.equal(generationCost({ usage: { cost: 0.3 } }), 0.3);
  assert.equal(generationCost({ data: { cost: 0.4 } }), 0.4);
  assert.equal(generationCost("plain text"), 0);
});

test("sessionIDsForMission deduplicates lead, workers and recorded runs", () => {
  const ids = sessionIDsForMission({
    leadID: "lead",
    boundIDs: ["lead", "w1"],
    workerSessions: ["w2", "w1"],
    agentRuns: [{ sessionID: "w3" }],
  });
  assert.deepEqual(ids, ["lead", "w1", "w2", "w3"]);
});

test("updateMissionCost adds every mission session, not just the lead", async () => {
  const costs = { lead: 1, worker1: 0.5, worker2: 0.25 };
  const ctx = {
    session: {
      context: async ({ sessionID }) => [
        { info: { role: "assistant", cost: costs[sessionID] ?? 0 } },
      ],
    },
  };
  const supervisor = new Supervisor(ctx, { enableWorkers: false });
  supervisor.bind("lead", "/root", true);
  supervisor.bind("worker1", "/root", false);
  const state = {
    cost_usd: 0,
    agent_runs: [{ sessionID: "worker2", cost: 0.25 }],
    worker_sessions: ["worker1", "worker2"],
  };
  const total = await supervisor.updateMissionCost("/root", state, "lead");
  assert.equal(total, 1.75);
  assert.equal(state.cost_usd, 1.75);
  const lower = await supervisor.updateMissionCost("/root", state, "lead");
  assert.equal(lower, 1.75);
});
