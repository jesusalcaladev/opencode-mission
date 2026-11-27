import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";

function fakeCtx(directory) {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {},
      synthetic: async () => {},
      create: async () => ({ id: "ses_test" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      switchModel: async () => {},
      wait: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory },
  };
}

async function criteriaAt(root) {
  return JSON.parse(await readFile(path.join(root, ".mission", "criteria.json"), "utf8"));
}

test("planAndStart: the mission workspace is the current project, not missionsRoot", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-project-"));
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "mission-sandbox-"));
  const ctx = fakeCtx(project);
  const sup = new Supervisor(ctx, {
    missionsRoot: sandbox,
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    const reply = await sup.planAndStart("ses_test", "create smoke.txt containing ready");
    assert.match(reply, /Plan source: fallback/);
    assert.match(reply, new RegExp(`Workspace: ${project}`));
    assert.equal(sup.rootFor("ses_test"), project);
    assert.deepEqual(
      await readdir(sandbox),
      [],
      "missionsRoot must not be used for /mission start"
    );
    const criteria = await criteriaAt(project);
    assert.deepEqual(
      criteria.checks.map((c) => c.id),
      ["file1", "content1"]
    );
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("planAndStart: a failing planner uses the project's real toolchain checks", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-toolchain-"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { test: "node --test", build: "node -e 0" } })
  );
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    const reply = await sup.planAndStart("ses_test", "terminar el SaaS y el generador");
    assert.match(reply, /Plan source: toolchain/);
    const criteria = await criteriaAt(project);
    assert.deepEqual(
      criteria.checks.map((c) => c.id),
      ["unit", "build"]
    );
    assert.equal(criteria.checks[0].cmd, "npm test");
    assert.ok(
      criteria.checks.every((c) => !/ls\s+-A|^\s*true\s*$/.test(c.cmd)),
      "no vacuous existence check"
    );
    const tasks = JSON.parse(await readFile(path.join(project, ".mission", "tasks.json"), "utf8"));
    assert.equal(tasks.tasks.length, criteria.checks.length);
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("planAndStart: a Zig project gets real zig build checks", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-zig-"));
  await writeFile(
    path.join(project, "build.zig"),
    'pub fn build(b: *std.Build) void { const t = b.step("test", "tests"); _ = t; }\n'
  );
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    const reply = await sup.planAndStart("ses_test", "terminar el motor y el editor");
    assert.match(reply, /Plan source: toolchain/);
    assert.deepEqual(
      (await criteriaAt(project)).checks.map((c) => c.cmd),
      ["zig build test", "zig build"]
    );
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("planAndStart: no toolchain and no criteria refuses to start", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-no-criteria-"));
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    const reply = await sup.planAndStart("ses_test", "terminar todo lo que falta");
    assert.match(reply, /Could not create a mission/);
    assert.match(reply, /no verifiable criteria|no real criteria/);
    assert.equal(await readdir(project).then((l) => l.includes(".mission")), false);
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("planAndStart: a throwing model picker still produces a complete mission", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-plan-model-"));
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => "not json",
  });
  sup.pickPlannerModel = async () => {
    throw new Error("model catalogue down");
  };
  try {
    const reply = await sup.planAndStart("ses_test", "create notes.txt containing hello");
    assert.match(reply, /fallback-after-error/);
    assert.ok((await criteriaAt(project)).checks.length >= 1);
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("planAndStart: a failed write leaves no partial workspace behind", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-plan-write-"));
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => "not json",
  });
  sup.writePlanFiles = async () => {
    throw new Error("disk full");
  };
  try {
    const reply = await sup.planAndStart("ses_test", "create broken.txt containing x");
    assert.match(reply, /Could not create the mission/);
    assert.equal(await readdir(project).then((l) => l.includes(".mission")), false);
    assert.equal(await readdir(project).then((l) => l.includes("broken.txt")), false);
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("planAndStart --long runs unattended with unlimited turns", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "mission-long-"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } })
  );
  const sup = new Supervisor(fakeCtx(project), {
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    await sup.planAndStart("ses_test", "terminar todo", { autonomy: "relentless" });
    const state = await sup.d.loadState(project);
    assert.equal(state.autonomy, "relentless");
    assert.equal(state.max_turns, 0, "no turn ceiling for unattended runs");
    assert.equal(state.goal_audit, false);
  } finally {
    sup.dispose();
    await rm(project, { recursive: true, force: true });
  }
});

test("rootFor: a mission from another project is never reused", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "mission-first-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "mission-second-"));
  const ctx = fakeCtx(first);
  const sup = new Supervisor(ctx, { enableWorkers: false, generate: async () => "not json" });
  try {
    await sup.planAndStart("ses_test", "create a.txt containing a");
    assert.equal(sup.rootFor("ses_test"), first);
    sup.currentDirectory = second;
    assert.equal(sup.rootFor("ses_test"), null, "old project must not follow the session");
    sup.currentDirectory = first;
    assert.equal(sup.rootFor("ses_test"), first);
  } finally {
    sup.dispose();
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
