import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, fallbackPlan, normalizePlan, planPrompt } from "../src/planner.js";

const valid = {
  objective: "Build a tiny CLI with three tests",
  checks: [
    { id: "version", cmd: "node cli.js --version", expect: "contains:1.0.0", timeout_ms: 10000 },
    { id: "tests", cmd: "node --test", expect: "exit0" },
  ],
  tasks: [
    { id: 1, subject: "Write cli.js", files: ["cli.js"], verify: "version", blocked_by: [] },
    { id: 2, subject: "Write tests", files: ["cli.test.js"], verify: "tests", blocked_by: [1] },
  ],
  settings: {
    max_turns: 8,
    budget_usd: 2,
    handoff_every_turns: 3,
    max_failures: 2,
    isolation: "none",
  },
};

test("normalizePlan accepts a well-formed plan and clamps settings", () => {
  const result = normalizePlan(valid, "objective", "/tmp/ws");
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.plan.checks[0].expect, "contains:1.0.0");
  assert.equal(result.plan.checks[1].timeout_ms, 30000);
  assert.deepEqual(result.plan.tasks[1].blocked_by, [1]);
  assert.equal(result.plan.settings.max_turns, 8);
});

test("normalizePlan rejects unsafe commands and invalid dependencies", () => {
  const dangerous = normalizePlan(
    { ...valid, checks: [{ id: "x", cmd: "sudo rm -rf /", expect: "exit0" }] },
    "o",
    "/tmp"
  );
  assert.equal(dangerous.ok, false);
  assert.match(dangerous.errors.join(" "), /unsafe/);

  const cycle = normalizePlan(
    {
      ...valid,
      tasks: [
        { id: 1, subject: "task a", verify: "version", blocked_by: [2] },
        { id: 2, subject: "task b", verify: "tests", blocked_by: [1] },
      ],
    },
    "o",
    "/tmp"
  );
  assert.equal(cycle.ok, false);
  assert.match(cycle.errors.join(" "), /cycle/);
});

test("normalizePlan parses fenced JSON and rejects path traversal in files", () => {
  const fenced = `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``;
  assert.equal(normalizePlan(fenced, "o", "/tmp").ok, true);
  const withPath = normalizePlan(
    { ...valid, tasks: [{ ...valid.tasks[0], files: ["../etc/passwd"] }, valid.tasks[1]] },
    "o",
    "/tmp"
  );
  assert.equal(withPath.ok, true);
  assert.deepEqual(withPath.plan.tasks[0].files, []);
});

test("createPlan retries after a malformed answer and falls back when the model fails", async () => {
  let calls = 0;
  const generate = async () => {
    calls += 1;
    return calls === 1 ? "not json" : JSON.stringify(valid);
  };
  const good = await createPlan("objective", "/tmp/ws", generate);
  assert.equal(good.source, "model");
  assert.equal(calls, 2);

  const bad = await createPlan("objective", "/tmp/ws", async () => {
    throw new Error("quota");
  });
  assert.equal(bad.source, "no-criteria");
  assert.equal(bad.plan.unstartable, true);
  assert.deepEqual(bad.plan.checks, []);
});

test("fallbackPlan derives real checks from the objective (no vacuous node --test)", () => {
  const plan = fallbackPlan("Create a file named proof.txt containing the word ready", "/tmp/ws");
  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ["file1", "content1"]
  );
  assert.match(plan.checks[0].cmd, /proof\.txt/);
  assert.match(plan.checks[1].cmd, /ready/);
  assert.deepEqual(plan.tasks[0].files, ["proof.txt"]);
});

test("fallbackPlan pairs each file with its own word and creates parallel tasks", () => {
  const plan = fallbackPlan(
    "Create alpha.txt containing alpha and beta.txt containing beta",
    "/tmp/ws"
  );
  assert.deepEqual(
    plan.checks.map((c) => c.id),
    ["file1", "file2", "content1", "content2"]
  );
  assert.match(plan.checks[2].cmd, /alpha.*alpha\.txt|alpha\.txt.*alpha/);
  assert.match(plan.checks[3].cmd, /beta.*beta\.txt|beta\.txt.*beta/);
  assert.deepEqual(
    plan.tasks.map((t) => t.files),
    [["alpha.txt"], ["beta.txt"]]
  );
});

test("planPrompt forces executable criteria instead of vague goals", () => {
  const prompt = planPrompt("make something great", "/tmp/ws");
  assert.match(prompt, /JSON/);
  assert.match(prompt, /checks/);
  assert.match(prompt, /disjoint/i);
  assert.match(prompt, /make something great/);
});
