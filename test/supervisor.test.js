import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import {
  ensureMission,
  fileExists,
  loadProgress,
  loadState,
  loadTasks,
  missionDir,
  saveProgress,
  writeTextAtomic,
} from "../src/mission.js";

function fakeCtx({ onPrompt } = {}) {
  const prompts = [];
  const workerPrompts = [];
  const synthetic = [];
  const switched = [];
  const store = new Map();
  let created = 0;
  return {
    prompts,
    workerPrompts,
    synthetic,
    switched,
    storage: {
      get: async (k) => store.get(k),
      set: async (k, v) => store.set(k, v),
    },
    session: {
      prompt: async ({ sessionID, text }) => {
        if (sessionID === "ses_test" || sessionID === "ses_new") prompts.push(text);
        else workerPrompts.push({ sessionID, text });
        if (onPrompt) await onPrompt(text);
      },
      context: async () => [{ info: { role: "assistant", cost: 0.01 } }],
      synthetic: async ({ text }) => synthetic.push(text),
      create: async ({ title, parentID }) => {
        created += 1;
        return { id: parentID ? `ses_worker_${created}` : "ses_new", title };
      },
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
      wait: async () => {},
      switchModel: async ({ model }) => {
        switched.push(model);
      },
    },
    model: {
      default: async () => null,
      list: async () => [
        { providerID: "providerA", id: "m1", cost: [{ output: 1 }] },
        { providerID: "providerB", id: "m2", cost: [{ output: 2 }] },
        { providerID: "free", id: "m0", cost: [{ output: 0 }] },
      ],
    },
    event: {
      subscribe: async function* () {},
    },
    location: { directory: "/tmp" },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-supervisor-"));
  await ensureMission(root, { id: "loop-test" });
  await writeTextAtomic(
    path.join(missionDir(root), "criteria.json"),
    JSON.stringify({ version: 1, checks: [{ id: "done", cmd: "test -f done.txt", expect: "exit0", timeout_ms: 5000 }] }),
  );
  await writeTextAtomic(
    path.join(missionDir(root), "tasks.json"),
    JSON.stringify({
      version: 1,
      tasks: [{ id: 1, subject: "Create done.txt", status: "pending", blocked_by: [], verify: "done" }],
    }),
  );
  await writeTextAtomic(
    path.join(missionDir(root), "state.json"),
    JSON.stringify({
      version: 1,
      id: "loop-test",
      status: "running",
      turn: 0,
      cost_usd: 0,
      max_turns: 5,
      budget_usd: 1,
      best_green: 0,
      strategy_tier: 1,
      last_checks: [],
    }),
  );
  return root;
}

test("supervisor: red check -> nudge -> agent writes file -> green -> complete", async () => {
  const root = await fixture();
  try {
    let wrote = false;
    const ctx = fakeCtx({
      onPrompt: async (text) => {
        if (text.startsWith("[MISSION SUPERVISOR") && !wrote) {
          await writeFile(path.join(root, "done.txt"), "");
          wrote = true;
        }
      },
    });
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    assert.equal(ctx.prompts.length, 1);
    assert.match(ctx.prompts[0], /^\[MISSION START\]/);

    await sup.handleIdle("ses_test");
    let state = await loadState(root);
    assert.equal(state.turn, 1);
    assert.equal(state.last_checks[0].ok, false);
    assert.equal(ctx.prompts.length, 2);
    assert.match(ctx.prompts[1], /^\[MISSION SUPERVISOR/);
    assert.match(ctx.prompts[1], /- done: exit 1/);
    assert.equal(state.status, "running");

    await sup.handleIdle("ses_test");
    state = await loadState(root);
    assert.equal(state.status, "complete", `unexpected finish: ${state.finish_reason}`);
    assert.equal(state.finish_reason, "all criteria green");
    assert.equal(state.cost_usd, 0.01);
    const tasks = await loadTasks(root);
    assert.equal(tasks[0].status, "completed");
    assert.match(ctx.synthetic.at(-1), /MISSION COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: STOP file aborts at the next idle boundary", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await writeTextAtomic(path.join(missionDir(root), "STOP"), "");
    await sup.handleIdle("ses_test");
    const state = await loadState(root);
    assert.equal(state.status, "aborted");
    assert.equal(state.finish_reason, "stop-file");
    assert.equal(ctx.prompts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: a met verdict with a red check is refused", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await sup.toolVerdict("ses_test", { status: "met", summary: "trust me" });
    await sup.handleIdle("ses_test");
    const state = await loadState(root);
    assert.equal(state.status, "running");
    assert.equal(state.last_verdict, null);
    assert.equal(state.last_checks[0].ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: mission_write cannot rewrite the harness contract", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    const criteriaPath = path.join(missionDir(root), "criteria.json");
    const before = await readFile(criteriaPath, "utf8");

    const refused = await sup.toolWrite("ses_test", { path: ".mission/criteria.json", content: '{"checks":[]}' });
    assert.match(refused, /Refusing to write mission control files/);
    assert.equal(await readFile(criteriaPath, "utf8"), before);

    const accepted = await sup.toolWrite("ses_test", { path: "./notes.txt", content: "hello" });
    assert.match(accepted, /Wrote notes\.txt/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: two failure events for one turn count once", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await sup.handleFailure("ses_test", new Error("boom"));
    await sup.handleFailure("ses_test", new Error("boom"));
    assert.equal((await loadState(root)).failures, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: auto-dispatch spawns workers at mission start", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root, { autoDispatch: true });
    assert.equal(ctx.workerPrompts.length, 1);
    assert.match(ctx.workerPrompts[0].text, /MISSION WORKER/);
    assert.match(ctx.prompts[0], /MISSION COORDINATOR/);
    const progress = await loadProgress(root);
    // The fake worker never called task_done, so its lease was released with an
    // attempt recorded. That is exactly what lets the next idle reclaim it.
    assert.equal(progress[0].attempts, 1);
    assert.match(progress[0].last_error, /no worker report/);
    assert.equal(progress[0].lease_until, 0);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 migration: v1 missions gain progress, memory and charter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-v2-migrate-"));
  try {
    await mkdir(missionDir(root), { recursive: true });
    await writeTextAtomic(path.join(missionDir(root), "mission.md"), "---\nid: old\n---\nOld mission.\n");
    await writeTextAtomic(path.join(missionDir(root), "criteria.json"), JSON.stringify({ checks: [{ id: "x", cmd: "true" }] }));
    await writeTextAtomic(
      path.join(missionDir(root), "tasks.json"),
      JSON.stringify({ tasks: [{ id: 1, subject: "old task", status: "in_progress", verify: "x", blocked_by: [] }] }),
    );
    await writeTextAtomic(path.join(missionDir(root), "state.json"), JSON.stringify({ status: "running", session_id: "lead" }));
    await writeTextAtomic(path.join(missionDir(root), "journal.md"), "# Journal\n\n");

    await ensureMission(root);
    const progress = await loadProgress(root);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].owner, "lead");
    assert.equal(progress[0].lease_until, 0);
    for (const file of ["memory.md", "summary.md", "charter.md", "progress.json"]) {
      assert.equal(await fileExists(path.join(missionDir(root), file)), true, file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory: compaction distills decisions into memory.md", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await writeTextAtomic(
      path.join(missionDir(root), "journal.md"),
      "# Journal\n\n[t1] decided to use leases instead of dispatched_tasks\n[t2] looked at the tree and did nothing\n",
    );
    await sup.compactMemory(root, { turn: 4 });
    const memory = await readFile(path.join(missionDir(root), "memory.md"), "utf8");
    assert.match(memory, /leases instead of dispatched_tasks/);
    assert.doesNotMatch(memory, /looked at the tree/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease: an expired worker lease is reclaimed on the next idle", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await saveProgress(root, [
      { id: 1, subject: "Create done.txt", status: "in_progress", owner: "dead_worker", attempts: 0, lease_until: Date.now() - 1000, last_error: "", verify: "done" },
    ]);
    await sup.handleIdle("ses_test");
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /leases expired: #1 → reclaimed/);
    assert.ok(ctx.workerPrompts.length >= 1);
    const progress = await loadProgress(root);
    assert.ok(progress[0].attempts >= 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: handoff moves the mission to a fresh session", async () => {
  const root = await fixture();
  try {
    const state = await loadState(root);
    state.handoff_every_turns = 1;
    await writeTextAtomic(path.join(missionDir(root), "state.json"), JSON.stringify(state));

    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    assert.equal(ctx.prompts.length, 1);

    await sup.handleIdle("ses_test");
    assert.equal(ctx.prompts.length, 2);
    assert.match(ctx.prompts[1], /\[FRESH CONTEXT\]/);
    const fresh = await loadState(root);
    assert.equal(fresh.session_id, "ses_new");
    assert.equal(fresh.last_handoff_turn, 1);
    assert.equal(sup.rootFor("ses_test"), null);
    assert.equal(sup.rootFor("ses_new"), root);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: modifying an existing test refuses progress (test erosion)", async () => {
  const root = await fixture();
  try {
    const testFile = path.join(root, "cli.test.js");
    await writeFile(testFile, "test('one', () => {});\n");
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);

    await writeFile(testFile, "test('one', () => {}); // weakened\n");
    await sup.handleIdle("ses_test");
    const state = await loadState(root);
    assert.equal(state.status, "aborted");
    assert.match(state.finish_reason, /test-erosion/);
    assert.equal(ctx.prompts.length, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: quota failure rotates model and schedules a backoff retry", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await sup.handleFailure("ses_test", new Error("provider.quota 402: not enough credits"));

    const state = await loadState(root);
    assert.equal(state.failures, 1);
    assert.equal(state.status, "running");
    assert.equal(ctx.switched.length, 1);
    assert.equal(ctx.switched[0].providerID, "free");
    assert.equal(ctx.switched[0].id, "m0");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
