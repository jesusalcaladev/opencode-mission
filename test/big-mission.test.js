import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { missionSizing, isBigObjective } from "../src/mission/sizing.js";
import { deploymentVerified, deployCheckIds } from "../src/mission/deployment.js";
import { decideNext } from "../src/mission/decide.js";
import { normalizePlan, validateMonotonic } from "../src/planner/normalize.js";
import { expandTaskList } from "../src/planner/tasks.js";
import { computeProgress } from "../src/mission/progress.js";
import { Supervisor } from "../src/supervisor.js";

const BIG_OBJECTIVE =
  "Hazlo completo por favor ahora mismo el focus es en la UI para hacer DUX mucho mejor y trabajar de calidad de otro nivel, toda la aplicación y el sistema completo";

test("sizing: a big objective asks for 15-30 checks and 20-40 tasks", () => {
  const sizing = missionSizing({ objective: BIG_OBJECTIVE });
  assert.equal(sizing.big, true);
  assert.equal(sizing.minChecks, 15);
  assert.equal(sizing.minTasks, 20);
  assert.equal(sizing.targetChecks, 24);
  assert.equal(sizing.targetTasks, 32);
  assert.equal(isBigObjective({ objective: "make a file" }), false);
  assert.equal(isBigObjective({ objective: "make a file", options: { big: true } }), true);
});

function reconReports() {
  const checks = Array.from(
    { length: 16 },
    (_, i) => `CHECK: id=area-${i} | cmd=node -e "process.exit(0)" | expect=exit0`
  );
  const files = Array.from({ length: 14 }, (_, i) => `src/unit-${i}.js:1 — file ${i}`);
  const tasks = [
    "TASK: subject=Wire the renderer | files=src/unit-1.js | check=area-1",
    "TASK: subject=Wire the shell | files=src/unit-2.js | check=area-2",
  ];
  return [
    { area: "architecture", text: ["FILES: " + files.join(" "), ...checks, ...tasks].join("\n") },
  ];
}

test("normalizePlan repairs a thin big plan from recon evidence", () => {
  const proposals = {
    reports: reconReports(),
    checks: Array.from({ length: 16 }, (_, i) => ({
      id: `area-${i}`,
      cmd: 'node -e "process.exit(0)"',
      expect: "exit0",
    })),
    tasks: [
      { subject: "Wire the renderer", files: ["src/unit-1.js"], check: "area-1" },
      { subject: "Wire the shell", files: ["src/unit-2.js"], check: "area-2" },
    ],
  };
  const sizing = missionSizing({ objective: BIG_OBJECTIVE, proposals });
  const result = normalizePlan(
    {
      objective: BIG_OBJECTIVE,
      checks: [{ id: "unit", cmd: 'node -e "process.exit(0)"', expect: "exit0" }],
      tasks: [{ id: 1, subject: "Do it", files: ["src/unit-1.js"], verify: "unit" }],
      requirements: [],
    },
    BIG_OBJECTIVE,
    "/tmp/ws",
    { proposals, sizing }
  );
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.ok(result.plan.checks.length >= 15, `checks: ${result.plan.checks.length}`);
  assert.ok(result.plan.tasks.length >= 20, `tasks: ${result.plan.tasks.length}`);
  assert.ok(
    result.plan.tasks.every((t) => t.files.length > 0),
    "every synthesized task must own a file so workers cannot collide"
  );
  assert.ok(result.plan.checks.some((c) => c.kind === "e2e"));
  assert.ok(deployCheckIds({ checks: result.plan.checks }).length > 0);
  assert.ok(
    result.plan.requirements.length >= result.plan.checks.length,
    "every check must become a covered requirement"
  );
});

test("expandTaskList can split a single-file task when asked", () => {
  const one = [{ id: 1, subject: "Polish UI", files: ["ui.zig"], verify: "unit" }];
  assert.equal(expandTaskList(one, { target: 12 }), one);
  const expanded = expandTaskList(one, { target: 12, expandSingle: true });
  assert.equal(expanded.length, 3);
  assert.deepEqual(
    expanded.map((t) => t.stage),
    ["implement", "test", "verify"]
  );
});

test("deployment gate requires commit, tasks and a real e2e check", () => {
  const criteria = {
    checks: [
      { id: "unit", kind: "unit" },
      { id: "e2e-ui", kind: "e2e" },
    ],
  };
  const results = [
    { id: "unit", ok: true },
    { id: "e2e-ui", ok: true },
  ];
  const tasks = [{ id: 1, status: "completed" }];
  const pending = deploymentVerified({ criteria, results, tasks, commit: null });
  assert.equal(pending.verified, false);
  const done = deploymentVerified({
    criteria,
    results,
    tasks,
    commit: { ok: true, sha: "abc123" },
  });
  assert.equal(done.verified, true);
  const state = { status: "running" };
  assert.equal(
    decideNext({ state, results, tasks, criteria, deployment: pending }).type,
    "continue"
  );
  assert.equal(decideNext({ state, results, tasks, criteria, deployment: done }).type, "complete");
});

test("plan caps and monotonic rules are preserved after repair", () => {
  const checks = Array.from({ length: 31 }, (_, i) => ({
    id: `c${i}`,
    cmd: 'node -e "process.exit(0)"',
    expect: "exit0",
  }));
  const tasks = checks.slice(0, 5).map((c, i) => ({
    id: i + 1,
    subject: `Task ${i + 1}`,
    files: [],
    verify: c.id,
  }));
  const tooMany = normalizePlan({ checks, tasks, requirements: [] }, "small", "/tmp/ws");
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.join(" "), /1\.\.30/);
  const previous = {
    checks: [{ id: "keep", cmd: "node --version", expect: "exit0" }],
    tasks: [{ id: 1, status: "completed", subject: "done" }],
  };
  const next = {
    checks: [{ id: "keep", cmd: "node --version", expect: "exit0" }],
    tasks: [{ id: 1, status: "completed", subject: "done" }],
  };
  assert.equal(validateMonotonic(next, previous.checks, previous.tasks).ok, true);
  assert.equal(
    validateMonotonic({ checks: [], tasks: [] }, previous.checks, previous.tasks).ok,
    false
  );
});

test("deploy evidence changes progress without breaking the small-mission formula", () => {
  const results = [
    { id: "unit", ok: true },
    { id: "e2e", ok: true },
  ];
  const tasks = [
    { id: 1, status: "completed", verify: "unit" },
    { id: 2, status: "completed", verify: "e2e" },
  ];
  const requirements = [{ covered: true }, { covered: true }];
  const plain = computeProgress(results, tasks, requirements, 0, null);
  const verified = computeProgress(results, tasks, requirements, 0, { verified: true });
  const pending = computeProgress(results, tasks, requirements, 0, { verified: false });
  assert.equal(plain.deployVerified, null);
  assert.ok(verified.pct > pending.pct);
  assert.equal(verified.deployVerified, true);
  const noRequirements = computeProgress(results, tasks, [], 0, { verified: true });
  assert.equal(noRequirements.pct, 100, "empty requirements must not cap a finished mission");
});

test("deployment gate refuses a plan with no real e2e/smoke check", () => {
  const verdict = deploymentVerified({
    criteria: { checks: [{ id: "unit", kind: "unit" }] },
    results: [{ id: "unit", ok: true }],
    tasks: [{ id: 1, status: "completed" }],
    commit: { ok: true, sha: "abc" },
  });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.deployGreen, false);
});

test("a cached blueprint is not reused for a different objective", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-blueprint-cache-"));
  const root = path.join(base, "app");
  const dir = path.join(root, ".mission");
  try {
    await mkdir(path.join(dir, "discovery"), { recursive: true });
    await writeFile(
      path.join(dir, "discovery", "architecture.md"),
      "CHECK: id=unit | cmd=node --version | expect=exit0\n"
    );
    await writeFile(path.join(dir, "blueprint-objective.txt"), "an old, different objective");
    await writeFile(path.join(dir, "blueprint.json"), JSON.stringify(planForCache("old")));
    await writeFile(path.join(dir, "blueprint.md"), "# Old blueprint\n");
    const c = ctx(root);
    const sup = new Supervisor(c, { enableWorkers: false, enableRoles: true, discovery: true });
    const roles = [];
    const real = sup.dispatchRoleStage.bind(sup);
    sup.dispatchRoleStage = async (sid, ws, role, ...rest) => {
      roles.push(role);
      if (role === "architect") return { text: blueprintMarkdown(planForCache("new")) };
      return real(sid, ws, role, ...rest);
    };
    try {
      await sup.planAndStart("lead", "Build a completely new影像 pipeline engine", {
        discovery: true,
      });
      assert.ok(roles.includes("architect"), "the architect must re-plan for a new objective");
      const state = await sup.d.loadState(root);
      assert.equal(state.blueprint, "blueprint.md");
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function planForCache(tag) {
  return {
    objective: `Build ${tag}`,
    checks: [{ id: "unit", cmd: "node --version", expect: "exit0", kind: "unit" }],
    tasks: [{ id: 1, subject: `Implement ${tag}`, files: [], verify: "unit" }],
    requirements: [],
  };
}

function blueprintMarkdown(value) {
  return `# Blueprint\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

function ctx(directory) {
  const c = {
    prompts: [],
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async ({ text }) => c.prompts.push(String(text)),
      synthetic: async () => {},
      create: async () => ({ id: "ses_child" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      switchModel: async () => {},
      wait: async () => {},
      context: async () => [],
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory },
  };
  return c;
}

test("planAndStart persists big sizing and the deployment gate", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-big-"));
  try {
    const root = path.join(base, "app");
    const dir = path.join(root, ".mission", "discovery");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "architecture.md"), reconReports()[0].text + "\n");
    const c = ctx(root);
    const sup = new Supervisor(c, {
      enableWorkers: false,
      discovery: false,
      generate: async () =>
        JSON.stringify({
          objective: BIG_OBJECTIVE,
          checks: [{ id: "unit", cmd: 'node -e "process.exit(0)"', expect: "exit0" }],
          tasks: [{ id: 1, subject: "Do it", files: ["src/unit-1.js"], verify: "unit" }],
          requirements: [],
        }),
    });
    try {
      const reply = await sup.planAndStart("lead", BIG_OBJECTIVE, { discovery: false });
      assert.match(reply, /task\(s\) scheduled/);
      const criteria = JSON.parse(
        await readFile(path.join(root, ".mission", "criteria.json"), "utf8")
      );
      const tasks = JSON.parse(await readFile(path.join(root, ".mission", "tasks.json"), "utf8"));
      assert.ok(criteria.checks.length >= 15, `checks: ${criteria.checks.length}`);
      assert.ok(tasks.tasks.length >= 20, `tasks: ${tasks.tasks.length}`);
      const state = await sup.d.loadState(root);
      assert.equal(state.sizing.big, true);
      assert.equal(state.require_deploy, true);
      assert.equal(state.deploy.verified, false);
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
