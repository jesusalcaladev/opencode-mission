import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import {
  ensureMission,
  loadState,
  loadTasks,
  saveProgress,
  saveState,
  writeTextAtomic,
  missionDir,
} from "../src/mission.js";

function fakeCtx() {
  const prompts = [];
  return {
    prompts,
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async ({ sessionID: _sessionID, text }) => {
        prompts.push(text);
      },
      context: async () => [],
      synthetic: async () => {},
      create: async ({ parentID }) => ({ id: parentID ? `w${prompts.length}` : "lead" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      wait: async () => {},
      switchModel: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
    websearch: {
      query: async () => ({
        data: { results: [{ url: "https://a.dev", title: "A", content: "c" }] },
      }),
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-cov-"));
  await ensureMission(root, { id: "cov" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({
      checks: [{ id: "build", cmd: "true", expect: "exit0" }],
      requirements: [{ id: "r1", text: "r1", checks: ["build"] }],
    })
  );
  await writeTextAtomic(
    path.join(missionDir(root), "tasks.json"),
    JSON.stringify({
      tasks: [{ id: 1, subject: "one", status: "completed", verify: "build", files: [] }],
    })
  );
  return root;
}

test("research tools: note and web search work through the supervisor", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("lead", root);
    const note = await sup.toolResearchNote("lead", {
      title: "Findings",
      content: "hello research",
    });
    assert.match(note, /research\/findings\.md/);
    assert.match(
      await readFile(path.join(root, "research", "findings.md"), "utf8"),
      /hello research/
    );
    const search = await sup.toolWebSearch("lead", { query: "engines" });
    assert.match(search, /1 results/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("goal audit: a GAP becomes a new verifiable task", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("lead", root);
    const state = await loadState(root);
    state.stage_reports = {
      "goal-auditor": { text: "GAP: requirement=r1 check=build files=engine.js missing game loop" },
    };
    await saveState(root, state);
    const result = await sup.runGoalAudit("lead", root, state, "Build a game engine", [
      { id: "build", ok: true },
    ]);
    assert.equal(result.type, "continue");
    assert.ok((await loadTasks(root)).length >= 2);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scheduler: waitWithTimeout and lead tick debounce", async () => {
  const ctx = fakeCtx();
  const sup = new Supervisor(ctx);
  await sup.waitWithTimeout("idle-session", 10);
  let ticks = 0;
  sup.handleIdle = async () => {
    ticks += 1;
  };
  sup.scheduleLeadTick("lead");
  sup.scheduleLeadTick("lead");
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(ticks, 1);
  sup.dispose();
});

test("recovery: bindings and stale worker leases are reclaimed", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    ctx.session.get = async ({ sessionID }) => ({
      id: sessionID,
      outcome: "interrupted",
      time: {},
    });
    const sup = new Supervisor(ctx);
    await sup.start("lead", root);
    assert.equal(sup.rootFor("lead"), root);
    await saveProgress(root, [
      { id: 1, status: "in_progress", owner: "dead", attempts: 0, lease_until: Date.now() + 1000 },
    ]);
    await sup.recoverStaleWorkers(root);
    const progress = (await import("../src/mission.js")).loadProgress;
    assert.equal((await progress(root))[0].status, "pending");
    sup.unbind("lead");
    assert.equal(sup.rootFor("lead"), null);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
