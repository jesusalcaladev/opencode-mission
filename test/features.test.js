import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { runChecks, workspaceStamp } from "../src/checks.js";
import { loadProjectInstructions } from "../src/mission/instructions.js";
import { upsertFact, renderFacts } from "../src/mission/facts.js";
import { Supervisor } from "../src/supervisor.js";
import { combineReviews } from "../src/mission/roles.js";

function fakeCtx() {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {}, context: async () => [], synthetic: async () => {},
      create: async () => ({ id: "w" }), get: async () => ({ id: "lead", time: {} }), wait: async () => {},
      switchModel: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

test("checks: a valid cache skips command execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-cache-"));
  try {
    const criteria = { checks: [{ id: "counter", cmd: `node -e "require('fs').appendFileSync('count.txt','x')"`, expect: "exit0" }] };
    const stamp = await workspaceStamp(root);
    const first = await runChecks(root, criteria, { stamp, cache: null });
    assert.equal(first.length, 1);
    const afterFirst = await readFile(path.join(root, "count.txt"), "utf8");
    assert.equal(afterFirst.length, 1);
    const { criteriaSignature } = await import("../src/checks.js");
    const hit = await runChecks(root, criteria, {
      stamp,
      cache: { stamp, signature: criteriaSignature(criteria.checks), results: first },
    });
    assert.equal(hit.length, 1);
    assert.equal((await readFile(path.join(root, "count.txt"), "utf8")).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instructions: AGENTS.md enters the brief and CLAUDE.md is deduped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-instructions-"));
  try {
    const agents = "Always use tabs in this project.\nDo not edit generated files.\n";
    await writeFile(path.join(root, "AGENTS.md"), agents);
    await writeFile(path.join(root, "CLAUDE.md"), agents);
    const text = await loadProjectInstructions(null, root, "");
    assert.match(text, /Always use tabs/);
    assert.equal((text.match(/Always use tabs/g) ?? []).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("facts: upsert replaces by kind+subject and renders compactly", () => {
  let facts = [];
  facts = upsertFact(facts, { kind: "decision", subject: "state", text: "use a pure state machine" });
  facts = upsertFact(facts, { kind: "decision", subject: "state", text: "use mixins" });
  facts = upsertFact(facts, { kind: "blocker", subject: "quota", text: "provider exhausted" });
  assert.equal(facts.length, 2);
  assert.match(renderFacts(facts), /use mixins/);
  assert.match(renderFacts(facts), /\[blocker\] quota/);
});

test("review: a lone high finding is downgraded, agreement keeps it high", () => {
  const a = "SEVERITY: high — broken output";
  const b = "SEVERITY: low — style only";
  assert.doesNotMatch(combineReviews(a, b), /SEVERITY: high/);
  assert.match(combineReviews(a, a), /SEVERITY: high/);
});

test("repeat guard: three stalled turns force strategy tier 3", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-repeat-"));
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root, { autoDispatch: false });
    const { loadState } = await import("../src/mission.js");
    const state = await loadState(root);
    state.stall_turns = 2;
    state.strategy_tier = 2;
    sup.recordTurn(state, [], [], true);
    assert.equal(state.strategy_tier, 3);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("models: fastModel is used for read-only roles", () => {
  const sup = new Supervisor(fakeCtx(), {
    model: { providerID: "strong", id: "m1" },
    fastModel: { providerID: "fast", id: "m0" },
  });
  assert.deepEqual(sup.modelForRole("reviewer"), { providerID: "fast", id: "m0" });
  assert.deepEqual(sup.modelForRole("implementer"), { providerID: "strong", id: "m1" });
  sup.dispose();
});
