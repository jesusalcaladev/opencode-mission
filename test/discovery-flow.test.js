import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { missionDir } from "../src/mission.js";
import { RECON_BEGIN } from "../src/mission/discovery.js";

function ctx(directory) {
  const c = {
    prompts: [],
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async ({ text }) => {
        c.prompts.push(String(text));
      },
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

function blueprintPlan() {
  const checks = [
    { id: "toolchain", cmd: "node --version", expect: "exit0", timeout_ms: 5000, kind: "build" },
    {
      id: "unit",
      cmd: 'node -e "process.exit(0)"',
      expect: "exit0",
      timeout_ms: 5000,
      kind: "unit",
    },
    { id: "e2e", cmd: 'node -e "process.exit(0)"', expect: "exit0", timeout_ms: 5000, kind: "e2e" },
    {
      id: "smoke",
      cmd: 'node -e "process.exit(0)"',
      expect: "exit0",
      timeout_ms: 5000,
      kind: "smoke",
    },
  ];
  const ids = checks.map((check) => check.id);
  const tasks = Array.from({ length: 14 }, (_, index) => ({
    id: index + 1,
    subject: `Implement unit ${index + 1}`,
    files: [`src/unit-${index + 1}.js`],
    verify: ids[index % ids.length],
    blocked_by: [],
    milestone: index < 4 ? "foundation" : "build",
    stage: index < 4 ? "foundation" : "build",
  }));
  return {
    objective: "Build the widget engine",
    definition_of_done: ["the engine runs"],
    checks,
    tasks,
    requirements: [{ id: "req-1", text: "the engine runs", checks: ["e2e"] }],
    milestones: [{ id: "foundation", title: "Foundation" }],
    settings: { autonomy: "campaign" },
  };
}

async function fixture(base) {
  const root = path.join(base, "mission");
  const dir = path.join(root, ".mission");
  await mkdir(path.join(dir, "discovery"), { recursive: true });
  await writeFile(
    path.join(dir, "discovery", "architecture.md"),
    "FILES: src/index.js:1 — entry point\nCHECK: id=build | cmd=npm run build | expect=exit0\n"
  );
  await writeFile(
    path.join(dir, "discovery", "quality.md"),
    "CURRENT BEHAVIOR: node --test is the runner\nRISKS: no e2e today\n"
  );
  const plan = blueprintPlan();
  const blueprint = [
    "# Blueprint",
    "Foundation first, then the build.",
    "```json",
    JSON.stringify(plan),
    "```",
    "",
  ].join("\n");
  await writeFile(path.join(dir, "blueprint.md"), blueprint);
  return { root, plan };
}

test("discovery flow: cached recon + blueprint produce a big validated plan without agents", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-discovery-"));
  try {
    const { root, plan } = await fixture(base);
    const c = ctx(root);
    const sup = new Supervisor(c, { enableWorkers: false, enableRoles: true });
    try {
      const reply = await sup.planAndStart("lead", "Build the widget engine", {
        discovery: true,
        reconAgents: 2,
      });
      assert.match(reply, /Plan source: blueprint/);
      assert.match(reply, /Discovery: 2 recon report\(s\)/);
      assert.match(reply, /goal audit before completion/);
      assert.equal(
        c.prompts.some((text) => text.includes("[MISSION RECON")),
        false
      );
      assert.equal(
        c.prompts.some((text) => text.includes("[MISSION ARCHITECT]")),
        false
      );

      const criteria = JSON.parse(
        await readFile(path.join(missionDir(root), "criteria.json"), "utf8")
      );
      assert.equal(criteria.checks.length, plan.checks.length);
      const tasks = JSON.parse(await readFile(path.join(missionDir(root), "tasks.json"), "utf8"));
      assert.equal(tasks.tasks.length, 14);
      assert.ok(
        tasks.tasks.every((task) => task.stage),
        "stage labels survive plan persistence"
      );
      assert.ok(tasks.tasks.every((task) => plan.checks.some((check) => check.id === task.verify)));

      const state = await sup.d.loadState(root);
      assert.equal(state.discovery_done, true);
      assert.equal(state.recon_agents, 2);
      assert.equal(state.goal_audit, true);

      const memory = await sup.d.loadMemory(root);
      assert.ok(memory.includes(RECON_BEGIN));
      assert.match(memory, /entry point/);
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discovery flow: the investigator stage does not repeat the recon", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-discovery-skip-"));
  try {
    const { root } = await fixture(base);
    const c = ctx(root);
    const sup = new Supervisor(c, { enableWorkers: false, enableRoles: true });
    try {
      await sup.planAndStart("lead", "Build the widget engine", {
        discovery: true,
        reconAgents: 2,
      });
      c.prompts.length = 0;
      await sup.handleIdle("lead");
      assert.equal(
        c.prompts.some((text) => text.includes("[MISSION INVESTIGATOR]")),
        false,
        "recon already covered investigation"
      );
      const state = await sup.d.loadState(root);
      assert.equal(state.stage, "implement");
      assert.match(
        await readFile(path.join(missionDir(root), "journal.md"), "utf8"),
        /skipping duplicate investigation/
      );
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("discovery flow: finishing writes a detailed MISSION_REPORT.md in the project", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-discovery-report-"));
  try {
    const { root } = await fixture(base);
    const c = ctx(root);
    const sup = new Supervisor(c, { enableWorkers: false, enableRoles: true });
    try {
      await sup.planAndStart("lead", "Build the widget engine", {
        discovery: true,
        reconAgents: 2,
      });
      await sup.stop("lead", "test stop");
      const file = path.join(root, "MISSION_REPORT.md");
      await access(file);
      const report = await readFile(file, "utf8");
      assert.match(report, /Mission report — Build the widget engine/);
      assert.match(report, /## What was done/);
      assert.match(report, /## How it was verified/);
      assert.match(report, /## Engineering loop/);
      assert.match(report, /Recon agents: 2/);
      assert.match(report, /Implement unit 1/);
      assert.match(report, /## Next steps/);
      const state = await sup.d.loadState(root);
      assert.equal(state.report_path, "MISSION_REPORT.md");
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
