import test from "node:test";
import assert from "node:assert/strict";
import {
  RECON_BEGIN,
  RECON_END,
  architectPrompt,
  harvestPlan,
  mergeReconMemo,
  parseBlueprint,
  parseProposals,
  reconAreas,
  reconMemo,
  reconPrompt,
  sanitizeId,
} from "../src/mission/discovery.js";
import { normalizePlan } from "../src/planner.js";
import { buildMissionReport, dependencySnapshot, diffDependencies } from "../src/mission/report.js";

test("discovery: recon fan-out is bounded to 1..4 areas", () => {
  assert.equal(reconAreas().length, 3);
  assert.equal(reconAreas(1).length, 1);
  assert.equal(reconAreas(4).length, 4);
  assert.equal(reconAreas(99).length, 4);
  assert.equal(reconAreas(0).length, 1);
  assert.equal(reconAreas("nope").length, 3);
  const ids = reconAreas(4).map((area) => area.id);
  assert.deepEqual([...new Set(ids)], ids, "every area has a unique id");
  assert.ok(reconAreas(4).every((area) => area.role.startsWith("recon-")));
});

test("discovery: prompts demand real paths and machine-readable proposals", () => {
  const area = reconAreas(1)[0];
  const prompt = reconPrompt({ objective: "Ship the CLI", workspace: "/tmp/ws", area });
  assert.match(prompt, /\[MISSION RECON · architecture\]/);
  assert.match(prompt, /READ-ONLY/);
  assert.match(prompt, /CHECK: id=/);
  assert.match(prompt, /TASK: subject=/);
  assert.match(prompt, /mission_report\(role='recon-architecture'/);

  const architect = architectPrompt({ objective: "Ship the CLI", workspace: "/tmp/ws", memo: "M" });
  assert.match(architect, /\[MISSION ARCHITECT\]/);
  assert.match(architect, /```json/);
  assert.match(architect, /8\.\.24 checks/);
  assert.match(architect, /20\.\.100 tasks/);
});

test("discovery: proposals are parsed, sanitized and deduplicated", () => {
  const { checks, tasks } = parseProposals([
    "CHECK: id=Build|cmd=npm run build|expect=exit0\nCHECK: id=build|cmd=node -e 1|expect=exit0",
    {
      text: [
        "CHECK: id=Smoke E2E | cmd=node cli.js --help | expect=contains:Usage",
        "TASK: subject=Write the parser | files=src/parser.js,src/ast.js | check=build",
        "TASK: subject=Write the CLI | files=./cli.js | check=smoke-e2e",
        "TASK: no check here | files=a.js",
      ].join("\n"),
    },
  ]);
  assert.equal(checks.length, 2, "duplicate ids collapse to one check");
  assert.equal(checks[0].id, "build");
  assert.equal(checks[1].id, "smoke-e2e");
  assert.equal(checks[1].expect, "contains:Usage");
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0].files, ["src/parser.js", "src/ast.js"]);
  assert.deepEqual(tasks[1].files, ["cli.js"], "leading ./ is normalized");
  assert.equal(sanitizeId("../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeId(""), "");
});

test("discovery: a harvested plan passes the same validation as a planner plan", () => {
  const reports = [
    "CHECK: id=build | cmd=node --version | expect=exit0\nTASK: subject=Build the engine | files=engine.js | check=build",
    'CHECK: id=e2e | cmd=node -e "process.exit(0)" | expect=exit0\nTASK: subject=Wire the demo | files=demo.js | check=e2e',
  ];
  const plan = harvestPlan(reports, "Build an engine", "/tmp/ws");
  assert.ok(plan);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    [1, 2]
  );
  const parsed = normalizePlan(plan, "Build an engine", "/tmp/ws");
  assert.equal(parsed.ok, true, parsed.errors?.join("; "));
  assert.equal(parsed.plan.checks.length, 2);
  assert.equal(parsed.plan.tasks.length, 2);
  assert.equal(harvestPlan([], "x", "/tmp"), null);
  assert.equal(harvestPlan(["TASK: subject=x | files=a.js | check=missing"], "x", "/tmp"), null);
});

test("discovery: blueprint json is extracted and the markdown is kept", () => {
  const text = [
    "# Blueprint",
    "Milestone 1: parser.",
    "```json",
    JSON.stringify({
      checks: [{ id: "build", cmd: "node --version", expect: "exit0" }],
      tasks: [{ id: 1, subject: "Build", files: ["a.js"], verify: "build", blocked_by: [] }],
    }),
    "```",
    "Milestone 2: CLI.",
  ].join("\n");
  const parsed = parseBlueprint(text);
  assert.ok(parsed.plan);
  assert.equal(parsed.plan.checks[0].id, "build");
  assert.match(parsed.markdown, /Milestone 1/);
  assert.match(parsed.markdown, /Milestone 2/);
  assert.doesNotMatch(parsed.markdown, /```json/);
  const missing = parseBlueprint("only prose");
  assert.equal(missing.plan, null);
  assert.match(missing.error, /no plan json/);
});

test("discovery: the recon memo is replaced, never appended twice", () => {
  const first = mergeReconMemo("old memory", reconMemo([{ area: "architecture", text: "A" }]));
  assert.ok(first.includes(RECON_BEGIN));
  assert.match(first, /RECON · architecture/);
  const second = mergeReconMemo(first, reconMemo([{ area: "quality", text: "Q" }]));
  assert.equal((second.match(new RegExp(RECON_BEGIN, "g")) ?? []).length, 1);
  assert.doesNotMatch(second, /RECON · architecture/);
  assert.match(second, /RECON · quality/);
  assert.ok(second.endsWith(RECON_END));
  assert.equal(mergeReconMemo("memory only", ""), "memory only");
  assert.ok(reconMemo([], 100) === "");
});

test("report: dependency snapshots and diffs are conservative", () => {
  assert.equal(dependencySnapshot(""), null);
  assert.equal(dependencySnapshot("{not json"), null);
  const before = dependencySnapshot(
    JSON.stringify({ dependencies: { a: "1.0.0" }, devDependencies: { b: "2.0.0" } })
  );
  const after = dependencySnapshot(
    JSON.stringify({ dependencies: { a: "1.2.0", c: "3.0.0" }, devDependencies: {} })
  );
  assert.deepEqual(before, { a: "1.0.0", b: "2.0.0" });
  const diff = diffDependencies(before, after);
  assert.deepEqual(diff.added, ["c@3.0.0"]);
  assert.deepEqual(diff.removed, ["b"]);
  assert.deepEqual(diff.changed, ["a 1.0.0 → 1.2.0"]);
  assert.deepEqual(diffDependencies(null, after), { added: [], removed: [], changed: [] });
});

test("report: every promised section is present and bounded", () => {
  const report = buildMissionReport({
    root: "/tmp/ws",
    objective: "Build a widget engine",
    state: {
      status: "complete",
      finish_reason: "all criteria green",
      turn: 12,
      cost_usd: 1.5,
      budget_usd: 5,
      tokens: 1234,
      autonomy: "relentless",
      never_give_up: true,
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      finished_at: new Date().toISOString(),
      last_checks: [
        { id: "build", ok: true, ms: 1200 },
        { id: "e2e", ok: false, ms: 800 },
      ],
      agent_runs: [{ role: "implementer", sessionID: "w1" }],
      metrics: { turns: 12, reviews: 2 },
      recon_agents: 3,
    },
    tasks: [
      { id: 1, subject: "Core loop", status: "completed", stage: "foundation" },
      { id: 2, subject: "Renderer", status: "pending", stage: "build" },
    ],
    progress: [{ id: 1, status: "completed", attempts: 2, started_at: 1000, finished_at: 5000 }],
    criteria: {
      checks: [{ id: "build", cmd: "npm run build" }],
      requirements: [{ id: "r1", text: "renders", checks: ["build"] }],
    },
    memory: "decided to use ECS",
    summary: "Memory entries: 3",
    improvements: "- [ ] improve shaders",
    research: "sources: example.com",
    blueprint: "# Blueprint\nfoundation first",
    discovery: ["architecture.md", "quality.md"],
    git: { head: "abc1234", branch: "main", stat: " 2 files changed" },
    depsBefore: { a: "1.0.0" },
    depsAfter: { a: "1.0.0", b: "2.0.0" },
  });
  for (const heading of [
    "# Mission report",
    "## What was done",
    "## How it was verified",
    "## Engineering loop",
    "## Files changed",
    "## Dependencies",
    "## Research",
    "## Decisions and constraints",
    "## Evidence",
    "## Next steps",
  ])
    assert.ok(report.includes(heading), `missing ${heading}`);
  assert.match(report, /1\/2 checks green/);
  assert.match(report, /1\/2 tasks verified/);
  assert.match(report, /b@2\.0\.0/, "added dependency is reported");
  assert.match(report, /abc1234/);
  assert.match(report, /Recon agents: 3/);
  assert.ok(report.length < 20_000);
  const empty = buildMissionReport({});
  assert.match(empty, /No tasks were recorded/);
  assert.match(empty, /No check results were recorded/);
  assert.match(empty, /No dependency baseline was captured/);
});
