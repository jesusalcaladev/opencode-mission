import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tokensFromContext, applyTokens, mergeTokenEntries } from "../src/mission/tokens.js";
import { decideNext } from "../src/mission/decide.js";
import { autoExtendDecision } from "../src/mission/chain.js";
import { initialState } from "../src/mission.js";
import { Supervisor } from "../src/supervisor.js";

test("tokensFromContext reads common token shapes and applyTokens is monotonic", () => {
  assert.deepEqual(
    tokensFromContext([
      { info: { role: "assistant", tokens: { input: 100, output: 40 } } },
      { info: { role: "user", tokens: { input: 999 } } },
    ]),
    { input: 100, output: 40, total: 140 }
  );
  assert.deepEqual(
    tokensFromContext([{ role: "assistant", usage: { inputTokens: 10, outputTokens: 5 } }]),
    { input: 10, output: 5, total: 15 }
  );
  assert.equal(tokensFromContext([{ info: { role: "user" } }]), null);
  assert.equal(applyTokens({ tokens: 500 }, { total: 120 }), 500);
  assert.equal(applyTokens({ tokens: 0 }, { total: 120 }), 120);
  assert.equal(mergeTokenEntries([{ tokens: 4 }, { tokens: 6 }, {}]), 10);
});

test("max_tokens is a hard, non-extendable ceiling", () => {
  const state = {
    ...initialState(),
    max_tokens: 100,
    tokens: 101,
    budget_usd: 0,
    max_turns: 0,
  };
  assert.equal(
    decideNext({
      state,
      results: [],
      tasks: [],
      verdict: null,
      stopFile: false,
      pauseFile: false,
      criteria: { checks: [] },
    }).reason,
    "token-budget"
  );
  assert.equal(
    autoExtendDecision({
      decision: { type: "stop", reason: "token-budget" },
      state: { auto_extend: true, never_give_up: true, max_extensions: 0 },
      progress: true,
    }).type,
    "stop"
  );
});

function fakeCtx({ createdIds = [] } = {}) {
  const store = new Map();
  const prompts = [];
  let index = 0;
  return {
    prompts,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      context: async () => [
        { info: { role: "assistant", cost: 0, tokens: { input: 20, output: 10 } } },
      ],
      create: async () => ({ id: createdIds[index++] ?? `created-${index}` }),
      prompt: async ({ text }) => prompts.push(text),
      synthetic: async () => {},
      wait: async () => {},
      switchModel: async () => {},
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

test("mission parallel starts independent lead sessions", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-parallel-cmd-"));
  try {
    const ctx = fakeCtx({ createdIds: ["lead-a", "lead-b"] });
    const sup = new Supervisor(ctx, { missionsRoot: base });
    const reply = await sup.startParallel("original", "Build alpha CLI | Build beta CLI");
    assert.match(reply, /Started 2 mission\(s\)/);
    assert.equal(ctx.prompts.filter((text) => text.startsWith("[MISSION COORDINATOR]")).length, 2);
    assert.equal(sup.bySession.get("lead-a") !== sup.bySession.get("lead-b"), true);
    assert.equal(sup.byRoot.size, 2);
    sup.dispose();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("updateMissionCost also aggregates tokens across sessions", async () => {
  const ctx = fakeCtx();
  const sup = new Supervisor(ctx, {});
  sup.bind("lead", "/root", true);
  const state = { cost_usd: 0, tokens: 0, agent_runs: [], worker_sessions: [] };
  await sup.updateMissionCost("/root", state, "lead");
  assert.equal(state.tokens, 30);
  assert.equal(state.cost_usd, 0);
});
