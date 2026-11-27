import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stateProblems, normalizeState } from "../src/mission/schema.js";
import { ensureMission, loadState, missionDir } from "../src/mission.js";

test("stateProblems identifies malformed durable state", () => {
  const problems = stateProblems({
    status: "banana",
    turn: "NaN",
    last_checks: {},
    metrics: [],
    history: null,
  });
  assert.ok(problems.some((p) => p.includes("status")));
  assert.ok(problems.some((p) => p.includes("turn")));
  assert.ok(problems.some((p) => p.includes("last_checks")));
  assert.ok(problems.some((p) => p.includes("metrics")));
  assert.ok(problems.some((p) => p.includes("history")));
  assert.deepEqual(stateProblems(null), ["state is not an object"]);
});

test("normalizeState repairs bad fields and keeps valid ones", () => {
  const state = normalizeState({
    status: "running",
    turn: 7,
    cost_usd: "not a number",
    last_checks: {},
    metrics: [],
    facts: [{ subject: "k", text: "v" }],
  });
  assert.equal(state.status, "running");
  assert.equal(state.turn, 7);
  assert.equal(state.cost_usd, 0);
  assert.deepEqual(state.last_checks, []);
  assert.deepEqual(state.metrics, {});
  assert.equal(state.facts.length, 1);
  assert.ok(state.max_turns > 0);
  assert.deepEqual(stateProblems(state), []);
});

test("loadState never returns a corrupted object to the supervisor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-schema-"));
  try {
    await ensureMission(root, { objective: "schema" });
    await writeFile(
      path.join(missionDir(root), "state.json"),
      JSON.stringify({ status: "running", turn: "oops", history: {} }),
      "utf8"
    );
    const state = await loadState(root);
    assert.equal(state.status, "running");
    assert.equal(state.turn, 0);
    assert.deepEqual(state.history, []);
    assert.deepEqual(stateProblems(state), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
