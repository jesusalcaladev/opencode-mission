import test from "node:test";
import assert from "node:assert/strict";
import {
  promptKey,
  isDuplicatePrompt,
  recordPrompt,
  recordHandoff,
  recoverLeases,
  pruneRegistry,
} from "../src/mission/recovery.js";
import {
  initialMetrics,
  metricsFromState,
  recordMetric,
  recordMetrics,
  metricsLines,
} from "../src/mission/metrics.js";
import { splitPrompt } from "../src/team.js";
import { webSearch } from "../src/research.js";

test("reliability: prompt ledger deduplicates identical boundaries", () => {
  const now = Date.now();
  let state = { prompt_ledger: [] };
  const key = promptKey("nudge", "ses_1", "7");
  assert.equal(isDuplicatePrompt(state, key, now), false);
  state = {
    ...state,
    prompt_ledger: recordPrompt(state, { key, kind: "nudge", sessionID: "ses_1" }, now),
  };
  assert.equal(isDuplicatePrompt(state, key, now + 1000), true);
  assert.equal(isDuplicatePrompt(state, key, now + 20_000), false);
  assert.equal(state.prompt_ledger.length, 1);
});

test("reliability: handoff lineage keeps the last 40 entries", () => {
  let state = { handoffs: [] };
  for (let i = 0; i < 45; i += 1)
    state = { ...state, handoffs: recordHandoff(state, `a${i}`, `b${i}`, i) };
  assert.equal(state.handoffs.length, 40);
  assert.equal(state.handoffs.at(-1).to, "b44");
});

test("reliability: recoverLeases keeps live leases and flags their status", () => {
  const now = Date.now();
  const progress = [
    { id: 1, status: "in_progress", owner: "w1", lease_until: now + 60_000 },
    { id: 2, status: "in_progress", owner: "dead", lease_until: now - 1 },
    { id: 3, status: "completed", lease_until: 0 },
  ];
  const out = recoverLeases(progress, now);
  assert.equal(out[0].lease_until, now + 60_000);
  assert.match(out[0].last_error, /survived restart/);
  assert.equal(out[1].lease_until, now - 1);
});

test("reliability: pruneRegistry drops stale roots and caps the list", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ root: `/r${i}`, updated_at: i }));
  const out = pruneRegistry(entries, ["/r39", "/r5"], 10);
  assert.deepEqual(
    out.map((e) => e.root),
    ["/r39", "/r5"]
  );
});

test("telemetry: counters accumulate and render as lines", () => {
  let m = initialMetrics();
  m = recordMetric(m, "turns", 2);
  m = recordMetric(m, "turns", 3);
  m = recordMetrics(m, { checksRun: 5, checksGreen: 4, agentsSpawned: 2 });
  const fromState = metricsFromState({ metrics: m });
  assert.equal(fromState.turns, 5);
  assert.equal(fromState.checksRun, 5);
  assert.equal(fromState.agentsSpawned, 2);
  const lines = metricsLines(m);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /turns 5 · checks 5/);
});

test("telemetry: split prompt asks for verifiable subtasks", () => {
  const prompt = splitPrompt({
    objective: "Build a game engine",
    task: { id: 4, subject: "Physics", files: ["physics.js"], verify: "collision" },
    attempts: 3,
  });
  assert.match(prompt, /2\.\.5 smaller/);
  assert.match(prompt, /Physics/);
  assert.match(prompt, /existing-check-id/);
});

test("research: webSearch caches repeated queries", async () => {
  let calls = 0;
  const ctx = {
    websearch: {
      query: async () => {
        calls += 1;
        return {
          data: { results: [{ url: `https://cache-test-${calls}.dev`, title: "x", content: "y" }] },
        };
      },
    },
  };
  const query = `cache-proof-${Date.now()}`;
  const a = await webSearch(ctx, query, 5);
  const b = await webSearch(ctx, query, 5);
  assert.equal(calls, 1);
  assert.equal(a[0].url, b[0].url);
});
