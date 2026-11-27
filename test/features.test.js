import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { mkdir, symlink } from "node:fs/promises";
import { runChecks, workspaceStamp } from "../src/checks.js";
import { listStampFiles, statFiles } from "../src/mission/stamp.js";
import { loadProjectInstructions } from "../src/mission/instructions.js";
import { upsertFact, renderFacts } from "../src/mission/facts.js";
import { Supervisor } from "../src/supervisor.js";
import { combineReviews } from "../src/mission/roles.js";

function fakeCtx() {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {},
      context: async () => [],
      synthetic: async () => {},
      create: async () => ({ id: "w" }),
      get: async () => ({ id: "lead", time: {} }),
      wait: async () => {},
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
    const criteria = {
      checks: [
        {
          id: "counter",
          cmd: `node -e "require('fs').appendFileSync('count.txt','x')"`,
          expect: "exit0",
        },
      ],
    };
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

test("stamp: dependency and build directories are skipped, sources are not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-stamp-"));
  try {
    await writeFile(path.join(root, "src.js"), "one");
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "dep");
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "bundle.js"), "out");
    const files = await listStampFiles(root);
    assert.deepEqual(
      files.map((f) => path.basename(f)),
      ["src.js"],
      "node_modules and dist must never be walked"
    );
    const before = await workspaceStamp(root);
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "changed dep");
    assert.equal(await workspaceStamp(root), before, "dependency churn is not a source change");
    // Different size and content, so the mtime granularity cannot hide the change.
    await writeFile(path.join(root, "src.js"), "two and more");
    assert.notEqual(await workspaceStamp(root), before);
    assert.equal(await workspaceStamp(path.join(root, "gone")), "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stamp: missing roots, unreadable files and symlinks are tolerated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-stamp-edge-"));
  try {
    const real = path.join(root, "a.txt");
    await writeFile(real, "x");
    await symlink(real, path.join(root, "link.txt"));
    assert.deepEqual(
      (await listStampFiles(root)).map((f) => path.basename(f)),
      ["a.txt"],
      "a symlink is not a source file"
    );
    assert.deepEqual(await listStampFiles(path.join(root, "gone")), []);
    const stats = await statFiles([real, path.join(root, "missing.txt")]);
    assert.equal(stats.length, 1);
    assert.equal(stats[0].file, real);
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
  facts = upsertFact(facts, {
    kind: "decision",
    subject: "state",
    text: "use a pure state machine",
  });
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

test("autonomy: defaultAutonomy makes missions unattended, invalid values are ignored", () => {
  const on = new Supervisor(fakeCtx(), { defaultAutonomy: "relentless" });
  assert.equal(on.defaultAutonomy, "relentless");
  assert.equal(on.unattendedSettings({}, "relentless").max_turns, 0);
  on.dispose();
  const campaign = new Supervisor(fakeCtx(), { defaultAutonomy: "campaign" });
  assert.equal(campaign.defaultAutonomy, "campaign");
  campaign.dispose();
  const off = new Supervisor(fakeCtx(), { defaultAutonomy: "yolo" });
  assert.equal(off.defaultAutonomy, null);
  off.dispose();
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
