import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scoreCase, summarize } from "../src/mission/eval.js";

const exec = promisify(execFile);

test("scoreCase checks exact state and harness invariants", () => {
  const good = scoreCase(
    { status: "complete", checks_green: 4, prompt_contains: "MISSION" },
    { status: "complete", checks_green: 4, prompts: "[MISSION SUPERVISOR]" }
  );
  assert.equal(good.pass, true);
  const bad = scoreCase(
    { status: "complete", checks_green: 4, tasks_pending: 0 },
    { status: "complete", checks_green: 3, checks_red: 1, tasks_pending: 2, prompts: "" }
  );
  assert.equal(bad.pass, false);
  assert.ok(bad.reasons.some((r) => r.includes("checks_green")));
  assert.ok(
    bad.reasons.some((r) => r.includes("invariant")) ||
      bad.reasons.some((r) => r.includes("tasks_pending"))
  );
});

test("summarize aggregates success rate and stop reasons", () => {
  const summary = summarize([
    { pass: true, turns: 2, checks_green: 4, finish_reason: "all criteria green" },
    { pass: false, turns: 4, checks_green: 0, finish_reason: "max-turns" },
  ]);
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.success_rate, 0.5);
  assert.equal(summary.avg_turns, 3);
  assert.equal(summary.hard_stops["all criteria green"], 1);
});

test("eval runner executes real cases through the supervisor", async () => {
  const script = path.resolve("scripts/mission-eval.mjs");
  for (const filter of ["cli-standard", "token-budget"]) {
    const { stdout } = await exec(process.execPath, [script, "--filter", filter]);
    const report = JSON.parse(stdout);
    assert.equal(report.summary.total, 1, stdout);
    assert.equal(report.summary.passed, 1, stdout);
    assert.equal(report.gate.ok, true, stdout);
  }
});
