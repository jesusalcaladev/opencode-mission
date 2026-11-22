import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  computeProgress,
  loadMission,
  loadTuiModel,
  normalizeRequirements,
  selectSnapshot,
} from "../src/tui/model.js";

async function fixture(overrides = {}, parent) {
  const root = await mkdtemp(path.join(parent ?? os.tmpdir(), "mission-tui-"));
  const dir = path.join(root, ".mission");
  await mkdir(dir, { recursive: true });
  const state = {
    id: "game-engine",
    status: "running",
    objective: "Build a game engine",
    started_at: new Date(Date.now() - 3_600_000).toISOString(),
    turn: 7,
    max_turns: 40,
    cost_usd: 0.84,
    budget_usd: 5,
    hard_budget_usd: 25,
    auto_extend: true,
    stage: "implement",
    strategy_tier: 1,
    last_checks: [
      { id: "build", ok: true, summary: "ok", ms: 12 },
      { id: "e2e", ok: false, summary: "exit 1", ms: 40 },
    ],
    history: [
      { turn: 1, green: 0 },
      { turn: 2, green: 1 },
    ],
    agent_runs: [
      {
        sessionID: "w1",
        role: "implementer",
        taskId: 3,
        status: "running",
        started_at: Date.now() - 60_000,
      },
    ],
    ...overrides,
  };
  await writeFile(path.join(dir, "state.json"), JSON.stringify(state));
  await writeFile(path.join(dir, "mission.md"), "---\nid: game-engine\n---\nBuild a game engine\n");
  await writeFile(
    path.join(dir, "tasks.json"),
    JSON.stringify({
      tasks: [
        { id: 1, subject: "Core loop", status: "completed", verify: "build" },
        { id: 2, subject: "Renderer", status: "pending", verify: "e2e" },
        { id: 3, subject: "Input", status: "in_progress", verify: "e2e" },
      ],
    })
  );
  await writeFile(
    path.join(dir, "progress.json"),
    JSON.stringify({ tasks: [{ id: 3, status: "in_progress", owner: "w1" }] })
  );
  await writeFile(
    path.join(dir, "criteria.json"),
    JSON.stringify({
      checks: [{ id: "build" }, { id: "e2e" }],
      requirements: [{ id: "r1", text: "renders", checks: ["e2e"] }],
    })
  );
  await writeFile(path.join(dir, "journal.md"), "# Journal\n[now] decided to use ECS\n");
  return root;
}

test("tui model: progress blends checks, tasks and requirements", () => {
  const p = computeProgress(
    [{ ok: true }, { ok: false }],
    [{ status: "completed" }, { status: "pending" }, { status: "in_progress" }],
    [{ covered: false }]
  );
  assert.equal(p.checksGreen, 1);
  assert.equal(p.checksTotal, 2);
  assert.equal(p.tasksDone, 1);
  assert.equal(p.tasksTotal, 3);
  assert.equal(p.reqCovered, 0);
  assert.ok(p.pct > 30 && p.pct < 50);
});

test("tui model: normalizeRequirements only covers when all checks are green", () => {
  const checks = [
    { id: "a", ok: true },
    { id: "b", ok: false },
  ];
  const reqs = normalizeRequirements({ requirements: [{ id: "x", checks: ["a", "b"] }] }, checks);
  assert.equal(reqs[0].covered, false);
  const reqs2 = normalizeRequirements({ requirements: [{ id: "x", checks: ["a"] }] }, checks);
  assert.equal(reqs2[0].covered, true);
});

test("tui model: loadMission returns a full snapshot", async () => {
  const root = await fixture();
  try {
    const s = await loadMission(root);
    assert.equal(s.id, "game-engine");
    assert.equal(s.status, "running");
    assert.equal(s.objective, "Build a game engine");
    assert.equal(s.checks.length, 2);
    assert.equal(s.checksGreen, 1);
    assert.equal(s.tasks.length, 3);
    assert.equal(s.tasksDone, 1);
    assert.equal(s.agents.length, 1);
    assert.equal(s.agents[0].sessionID, "w1");
    assert.deepEqual(s.nextTask, { id: 2, subject: "Renderer" });
    assert.equal(s.requirements.length, 1);
    assert.equal(s.requirements[0].covered, false);
    assert.equal(s.paused, false);
    assert.equal(s.auto_extend, true);
    assert.ok(s.elapsed_ms > 3_500_000);
    assert.match(s.journal, /decided to use ECS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tui model: selectSnapshot scopes by session before the global pointer", () => {
  const a = { root: path.resolve("/tmp/a"), sessionID: "sess-a", status: "running" };
  const b = { root: path.resolve("/tmp/b"), sessionID: "sess-b", status: "paused" };
  const registry = [
    { root: b.root, sessionID: "sess-b", updated_at: 2 },
    { root: a.root, sessionID: "sess-a", updated_at: 1 },
  ];
  assert.equal(selectSnapshot({ sessionID: "sess-a", registry, snapshots: [a, b] }), a);
  assert.equal(selectSnapshot({ sessionID: "sess-b", registry, snapshots: [a, b] }), b);
  // A session with no mission never inherits someone else's mission.
  assert.equal(selectSnapshot({ sessionID: "sess-c", registry, snapshots: [a, b] }), null);
  // State still identifies the lead for missions predating the registry.
  assert.equal(selectSnapshot({ sessionID: "sess-b", snapshots: [a, b] }), b);
  // No active session (dashboard from home): pointer, then first running.
  assert.equal(selectSnapshot({ pointer: { root: b.root }, snapshots: [a, b] }), b);
  assert.equal(selectSnapshot({ snapshots: [a, b] }), a);
  assert.equal(selectSnapshot({}), null);
  // Stale pointers and registry entries fall through to the next source.
  assert.equal(selectSnapshot({ pointer: { root: "/gone" }, snapshots: [a, b] }), a);
  assert.equal(
    selectSnapshot({
      sessionID: "sess-a",
      registry: [null, { root: "/gone", sessionID: "sess-a" }, { sessionID: "sess-a" }],
      snapshots: [null, a, b],
    }),
    a
  );
  assert.equal(selectSnapshot({ snapshots: [b] }), b);
  assert.equal(selectSnapshot({ snapshots: [] }), null);
});

test("tui model: concurrent terminals each show only their own mission", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mission-tui-multi-"));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "mission-tui-home-"));
  const oldHome = process.env.HOME;
  try {
    const rootA = await fixture({ id: "mission-a", sessionID: "sess-a" }, parent);
    const rootB = await fixture({ id: "mission-b", sessionID: "sess-b" }, parent);
    process.env.HOME = fakeHome;
    const cache = path.join(fakeHome, ".cache", "opencode-mission");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "current.json"), JSON.stringify({ root: rootA }));
    await writeFile(
      path.join(cache, "missions.json"),
      JSON.stringify([
        { root: rootA, sessionID: "sess-a", updated_at: 2 },
        { root: rootB, sessionID: "sess-b", updated_at: 1 },
      ])
    );

    const shared = { missionsRoot: parent };
    const a = await loadTuiModel({ ...shared, sessionID: "sess-a" });
    assert.equal(a.snapshot.root, rootA);
    assert.equal(a.snapshot.id, "mission-a");
    const b = await loadTuiModel({ ...shared, sessionID: "sess-b" });
    assert.equal(b.snapshot.root, rootB);
    assert.equal(b.snapshot.id, "mission-b");
    const idle = await loadTuiModel({ ...shared, sessionID: "sess-c" });
    assert.equal(idle.snapshot, null);
    const global = await loadTuiModel(shared);
    assert.equal(global.snapshot.root, rootA);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(parent, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("tui model: loadTuiModel prefers an active mission and lists recent ones", async () => {
  const root = await fixture();
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "mission-tui-home-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = fakeHome;
    const cache = path.join(fakeHome, ".cache", "opencode-mission");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "current.json"), JSON.stringify({ root }));
    const model = await loadTuiModel({ missionsRoot: path.dirname(root) });
    assert.equal(model.snapshot.root, root);
    assert.ok(model.missions.length >= 1);
    assert.ok(model.missions.some((m) => m.root === root && m.status === "running"));
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(root, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
