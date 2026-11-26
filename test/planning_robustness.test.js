import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";

function fakeCtx() {
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
    location: { directory: "/tmp" },
  };
}

test("planAndStart: a failing planner still writes a complete mission", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-plan-robust-"));
  const sup = new Supervisor(fakeCtx(), {
    missionsRoot: base,
    enableWorkers: false,
    generate: async () => {
      throw new Error("planner unavailable");
    },
  });
  try {
    const reply = await sup.planAndStart("ses_test", "create smoke.txt containing ok");
    assert.match(reply, /Plan source: fallback/);
    const dirs = await readdir(base);
    const root = path.join(
      base,
      dirs.find((d) => d.startsWith("create-smoke"))
    );
    for (const file of ["state.json", "criteria.json", "tasks.json", "mission.md"]) {
      const text = await readFile(path.join(root, ".mission", file), "utf8");
      assert.ok(text.length > 0, `${file} must exist and be non-empty`);
    }
    const criteria = JSON.parse(
      await readFile(path.join(root, ".mission", "criteria.json"), "utf8")
    );
    assert.ok(criteria.checks.length >= 1, "a mission must never have 0 checks");
    const tasks = JSON.parse(await readFile(path.join(root, ".mission", "tasks.json"), "utf8"));
    assert.ok(tasks.tasks.length >= 1, "a mission must never have 0 tasks");
    const mission = await readFile(path.join(root, ".mission", "mission.md"), "utf8");
    assert.match(mission, /create smoke\.txt/);
  } finally {
    sup.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test("planAndStart: a throwing model picker still produces a complete mission", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-plan-model-"));
  const sup = new Supervisor(fakeCtx(), {
    missionsRoot: base,
    enableWorkers: false,
    generate: async () => "not json",
  });
  sup.pickPlannerModel = async () => {
    throw new Error("model catalogue down");
  };
  try {
    const reply = await sup.planAndStart("ses_test", "create notes.txt containing hello");
    assert.match(reply, /fallback-after-error/);
    const dirs = await readdir(base);
    const root = path.join(
      base,
      dirs.find((d) => d.startsWith("create-notes"))
    );
    const criteria = JSON.parse(
      await readFile(path.join(root, ".mission", "criteria.json"), "utf8")
    );
    assert.ok(criteria.checks.length >= 1);
  } finally {
    sup.dispose();
    await rm(base, { recursive: true, force: true });
  }
});

test("planAndStart: a failed write leaves no partial workspace behind", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-plan-write-"));
  const sup = new Supervisor(fakeCtx(), {
    missionsRoot: base,
    enableWorkers: false,
    generate: async () => "not json",
  });
  sup.writePlanFiles = async () => {
    throw new Error("disk full");
  };
  try {
    const reply = await sup.planAndStart("ses_test", "create broken.txt containing x");
    assert.match(reply, /Could not create the mission/);
    assert.deepEqual(await readdir(base), [], "no half-authored mission folder");
  } finally {
    sup.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
