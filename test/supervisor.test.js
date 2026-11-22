import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import {
  ensureMission,
  fileExists,
  loadCriteria,
  loadProgress,
  loadState,
  loadTasks,
  missionDir,
  saveProgress,
  saveRoadmap,
  saveState,
  saveTasks,
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
      stage: "done",
      stage_reports: {},
      review_attempts: 0,
      continuous_improvement: false,
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

test("supervisor: every successful write is counted toward the ceiling", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    await sup.toolWrite("ses_test", { path: "notes.txt", content: "hello" });
    assert.equal((await loadState(root)).writes, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: heartbeat renews the lease of an assigned task", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    const progress = await loadProgress(root);
    progress[0].status = "in_progress";
    progress[0].lease_until = Date.now() + 1000;
    await saveProgress(root, progress);
    const before = progress[0].lease_until;
    const reply = await sup.toolHeartbeat("ses_test", { id: 1 });
    assert.match(reply, /renewed/);
    assert.ok((await loadProgress(root))[0].lease_until > before);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: parallel journal writes never lose a line", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    await Promise.all(Array.from({ length: 25 }, (_, i) => sup.journal(root, `parallel line ${i}`)));
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    for (let i = 0; i < 25; i += 1) assert.match(journal, new RegExp(`parallel line ${i}`));
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor: a done report with a red verify check is rejected and retried", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.last_checks = [{ id: "done", ok: false, summary: "exit 1" }];
    await saveState(root, state);

    const refused = await sup.toolTaskDone("ses_test", { id: 1, status: "done", summary: "I wrote done.txt" });
    assert.match(refused, /Report rejected/);
    assert.equal((await loadProgress(root))[0].attempts, 1);

    const green = await loadState(root);
    green.last_checks = [{ id: "done", ok: true, summary: "exit 0" }];
    await saveState(root, green);
    const accepted = await sup.toolTaskDone("ses_test", { id: 1, status: "done", summary: "done.txt now exists" });
    assert.match(accepted, /Report recorded/);
    assert.equal((await loadProgress(root))[0].status, "completed");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog: a stalled mission gets a validated new plan from the model", async () => {
  const root = await fixture();
  try {
    const plan = {
      objective: "New approach",
      checks: [{ id: "newcheck", cmd: "test -f new.txt", expect: "exit0", timeout_ms: 10000 }],
      tasks: [{ id: 1, subject: "Create new.txt", files: ["new.txt"], verify: "newcheck", blocked_by: [] }],
      settings: { max_turns: 12, budget_usd: 5, max_failures: 3, handoff_every_turns: 0 },
    };
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx, { generate: async () => JSON.stringify(plan) });
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.strategy_tier = 2;
    state.turn = 8;
    state.last_progress_turn = 5;
    await saveState(root, state);

    const applied = await sup.maybeReplan(root, state, [], await loadTasks(root));
    assert.equal(applied, true);
    const criteria = await loadCriteria(root);
    assert.equal(criteria.checks[0].id, "newcheck");
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /re-plan applied/);
    assert.equal((await loadState(root)).strategy_tier, 1);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("roles: read-only agents cannot write and implementers stay in their files", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    sup.roles.set("ses_test", "reviewer");
    assert.match(await sup.toolWrite("ses_test", { path: "x.txt", content: "hello" }), /read-only/);

    sup.roles.set("ses_test", "implementer");
    const tasks = await loadTasks(root);
    tasks[0].files = ["done.txt"];
    await saveTasks(root, tasks);
    sup.workers.set("ses_test", { root, taskId: 1, leadID: "lead" });
    assert.match(
      await sup.toolWrite("ses_test", { path: "other.txt", content: "hello" }),
      /outside task #1 files/,
    );
    assert.match(await sup.toolWrite("ses_test", { path: "done.txt", content: "hello" }), /Wrote done\.txt/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline: high severity review blocks completion, clean review allows it", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    const state = await loadState(root);
    const tasks = await loadTasks(root);
    for (const t of tasks) t.status = "completed";

    state.stage = "review";
    state.continuous_improvement = false;
    state.review_attempts = 0;
    state.stage_reports = { review: { text: "found a bug\nSEVERITY: high — wrong output", at: "" } };
    assert.equal((await sup.runRolePipeline("ses_test", root, state, tasks, [], { type: "complete" })).type, "continue");
    assert.equal(state.review_attempts, 1);

    state.stage = "review";
    state.review_attempts = 2;
    state.stage_reports = { review: { text: "SEVERITY: high — still broken", at: "" } };
    assert.equal((await sup.runRolePipeline("ses_test", root, state, tasks, [], { type: "complete" })).reason, "review-high");

    state.stage = "review";
    state.stage_reports = { review: { text: "SEVERITY: low — style only", at: "" } };
    assert.equal((await sup.runRolePipeline("ses_test", root, state, tasks, [], { type: "complete" })).type, "complete");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline: investigate and review stages dispatch their own agents", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.stage = "investigate";
    const afterInvestigate = await sup.runRolePipeline("ses_test", root, state, [], [], { type: "complete" });
    assert.equal(afterInvestigate.type, "continue");
    assert.equal(state.stage, "implement");
    assert.ok(ctx.workerPrompts.some((p) => p.text.includes("MISSION INVESTIGATOR")));

    state.stage = "review";
    delete state.stage_reports?.review;
    const afterReview = await sup.runRolePipeline(
      "ses_test",
      root,
      state,
      [{ id: 1, status: "completed" }],
      [],
      { type: "complete" },
    );
    assert.equal(afterReview.type, "continue");
    assert.ok(ctx.workerPrompts.some((p) => p.text.includes("MISSION REVIEWER")));
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("improve: a valuable finding creates one bounded improvement task", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.stage_reports = {
      auditor: { text: "FINDING: impact=high risk=low files=done.txt add a guard", at: "" },
    };
    const decision = await sup.runImproveCycle("ses_test", root, state, []);
    assert.equal(decision.type, "continue");
    assert.equal((await loadTasks(root)).length, 2);
    assert.equal(state.improve_cycles, 1);
    assert.equal(state.stage, "implement");
    assert.match(await readFile(path.join(missionDir(root), "improvements.md"), "utf8"), /impact: high/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("improve: two clean audits stop with an explicit reason", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(fakeCtx());
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.clean_audit_rounds = 2;
    state.stage_reports = { auditor: { text: "NO FINDINGS", at: "" } };
    const decision = await sup.runImproveCycle("ses_test", root, state, []);
    assert.equal(decision.type, "complete");
    assert.equal(decision.reason, "no-high-value-improvements");
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity: EXTEND consumes once and raises the turn ceiling", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.turn = state.max_turns - 1;
    await saveState(root, state);
    await writeTextAtomic(path.join(missionDir(root), "EXTEND"), "");

    await sup.handleIdle("ses_test");
    const after = await loadState(root);
    assert.equal(after.extensions, 1);
    assert.equal(after.status, "running");
    assert.ok(after.max_turns > state.max_turns);
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /budget extended 1\/3/);
    assert.equal(await fileExists(path.join(missionDir(root), "EXTEND")), false);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity: chain starts the next roadmap item and carries memory", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    await saveRoadmap(root, "# Roadmap\n\n- [ ] id: first: do one thing\n- [ ] id: second: do another\n");
    await writeTextAtomic(path.join(missionDir(root), "memory.md"), "decided to keep the contract small");

    const started = await sup.continueChain(root, "ses_test");
    assert.equal(started, true);
    assert.equal((await loadState(root)).chain_index, 1);
    const roadmap = await readFile(path.join(missionDir(root), "roadmap.md"), "utf8");
    assert.match(roadmap, /- \[x\] id: first/);
    assert.match(roadmap, /- \[ \] id: second/);
    assert.match(await readFile(path.join(missionDir(root), "memory.md"), "utf8"), /contract small/);
    assert.match(ctx.prompts.at(-1), /MISSION CHAIN/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity: rescue timer re-admits exactly one stalled turn", async () => {
  const root = await fixture();
  try {
    const ctx = fakeCtx();
    const sup = new Supervisor(ctx);
    await sup.start("ses_test", root);
    const state = await loadState(root);
    state.last_prompt_at = Date.now() - 200_000;
    await saveState(root, state);

    await sup.rescueStalled();
    const prompts = ctx.prompts.filter((p) => p.includes("MISSION RESCUE"));
    assert.equal(prompts.length, 1);
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /rescue timer re-admitted/);
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
