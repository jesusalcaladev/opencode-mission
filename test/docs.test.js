import test from "node:test";
import assert from "node:assert/strict";
import { analyzeDocs } from "../scripts/check-docs.mjs";

test("analyzeDocs accepts a documented public surface", () => {
  const problems = analyzeDocs({
    readme: "npm run eval\n| `write` |\n/mission status",
    runbook: "npm run watchdog",
    contract: "state.json is durable",
    scripts: ["eval", "watchdog"],
    tools: ["write"],
    commands: ["status"],
  });
  assert.deepEqual(problems, []);
});

test("analyzeDocs reports missing scripts, tools and commands", () => {
  const problems = analyzeDocs({
    readme: "",
    runbook: "",
    contract: "",
    scripts: ["eval"],
    tools: ["spawn"],
    commands: ["parallel"],
  });
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.includes("eval")));
  assert.ok(problems.some((p) => p.includes("mission_spawn")));
  assert.ok(problems.some((p) => p.includes("/mission parallel")));
  assert.ok(problems.some((p) => p.includes("state.json")));
});
