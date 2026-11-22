import test from "node:test";
import assert from "node:assert/strict";
import { parseFindings, rankFindings, cycleDecision, worthImproving } from "../src/mission/improve.js";

test("improve: FINDING lines are parsed into structured items", () => {
  const text = [
    "read the code",
    "FINDING: impact=high risk=low files=src/a.js,src/b.js add a guard for null input",
    "FINDING: impact=low risk=low files=src/c.js rename a variable",
  ].join("\n");
  const findings = parseFindings(text);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].impact, "high");
  assert.deepEqual(findings[0].files, ["src/a.js", "src/b.js"]);
  assert.match(findings[0].text, /guard for null/);
});

test("improve: only findings above the impact threshold are ranked", () => {
  const findings = parseFindings("FINDING: impact=high risk=low files=a.js fix crash\nFINDING: impact=low risk=low files=b.js style");
  const ranked = rankFindings(findings, "medium");
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].impact, "high");
  assert.equal(worthImproving(findings[1], "medium"), false);
});

test("improve: stops on threshold, budgets and cycle limits", () => {
  assert.equal(cycleDecision({ cleanRounds: 2 }).reason, "no-high-value-improvements");
  assert.equal(cycleDecision({ improveCycles: 5 }).reason, "improve-cycle-limit");
  assert.equal(cycleDecision({ outOfBudget: true }).reason, "budget");
  assert.equal(cycleDecision({ stopFile: true }).reason, "stop-file");
  assert.equal(cycleDecision({ finding: { impact: "high" }, improveCycles: 0 }).type, "implement");
});
