import test from "node:test";
import assert from "node:assert/strict";

import { STATUS, TASK_STATUS, parseFrontmatter, objectiveOf, normalizeTask } from "../src/mission/state.js";
import { decideNext, applyTaskResults } from "../src/mission/decide.js";
import { distill, buildBrief } from "../src/mission/memory.js";
import { fromTasks, migrateV1, claim, release, renew, fail, expired, retryable, MAX_ATTEMPTS } from "../src/mission/lease.js";
import { normalizePlan } from "../src/planner.js";
import { needsReplan, afterReplan, replanPrompt, STALL_TURNS } from "../src/mission/watchdog.js";

test("state: frontmatter numbers and objective extraction", () => {
  const text = "---\nid: x\nmax_turns: 9\n---\nDo the thing.\nmore";
  const meta = parseFrontmatter(text);
  assert.equal(meta.id, "x");
  assert.equal(meta.max_turns, 9);
  assert.equal(objectiveOf(text), "Do the thing.");
});

test("state: normalizeTask keeps ids and drops malformed dependencies", () => {
  const t = normalizeTask({ id: 3, subject: "work", status: "weird", files: ["a.js", 7], blocked_by: [1, "x", -2] });
  assert.equal(t.id, 3);
  assert.equal(t.status, TASK_STATUS.PENDING);
  assert.equal(t.files.length, 1);
  assert.equal(t.blocked_by.length, 1);
});

test("decide: stop file and blocked verdict beat completion", () => {
  const state = { status: STATUS.RUNNING, turn: 1, max_turns: 12, cost_usd: 0, budget_usd: 5 };
  const results = [{ id: "x", ok: true }];
  const tasks = [{ id: 1, status: TASK_STATUS.COMPLETED }];
  assert.equal(decideNext({ state, results, tasks, stopFile: true }).reason, "stop-file");
  assert.equal(decideNext({ state, results, tasks, verdict: { status: "blocked", unblock: "key" } }).reason, "blocked");
  assert.equal(decideNext({ state, results, tasks }).type, "complete");
});

test("decide: applyTaskResults settles dependency chains", () => {
  const tasks = [
    { id: 1, subject: "a", status: TASK_STATUS.PENDING, verify: "a", blocked_by: [] },
    { id: 2, subject: "b", status: TASK_STATUS.PENDING, verify: "b", blocked_by: [1] },
  ];
  const out = applyTaskResults(tasks, [{ id: "a", ok: true }, { id: "b", ok: true }]);
  assert.equal(out.tasks[1].status, TASK_STATUS.COMPLETED);
  assert.equal(out.changed, true);
});

test("memory: distill keeps decisions and drops duplicates within budget", () => {
  const journal = [
    "[t1] explored the tree",
    "[t2] decided to use a pure state module because the supervisor was too large",
    "[t3] decided to use a pure state module because the supervisor was too large",
    "[t4] verified 2/3 checks green",
    "[t5] blocker: worker lease expired on task 4",
  ].join("\n");
  const out = distill({ journal, maxChars: 4000 });
  assert.match(out.memory, /pure state module/);
  assert.match(out.memory, /lease expired/);
  assert.equal((out.memory.match(/pure state module/g) ?? []).length, 1);
  assert.ok(out.memory.length <= 4000);
});

test("memory: brief carries distilled memory and workers in flight", () => {
  const brief = buildBrief({
    root: "/tmp/m",
    missionText: "---\nid: x\n---\nShip it.",
    state: { id: "x", turn: 2, max_turns: 10, cost_usd: 0, budget_usd: 5, strategy_tier: 1 },
    tasks: [{ id: 1, subject: "next", status: "pending", blocked_by: [] }],
    journal: "verified one check",
    results: [],
    memory: "decided to keep the contract host-agnostic",
    summary: "Memory entries: 1",
    progress: [{ id: 2, status: "in_progress", lease_until: Date.now() + 1000 }],
  });
  assert.match(brief, /host-agnostic/);
  assert.match(brief, /#2/);
  assert.match(brief, /MISSION BRIEF/);
});

test("lease: claim, renew, release and reclaim after expiry", () => {
  const now = 1_000_000;
  const progress = fromTasks([{ id: 1, subject: "a", status: TASK_STATUS.PENDING }], now);
  assert.equal(claim(progress, 1, "w1", now, 1000), true);
  assert.equal(claim(progress, 1, "w2", now, 1000), false);
  assert.equal(expired(progress, now + 999).length, 0);
  assert.equal(expired(progress, now + 1001).length, 1);
  fail(progress, 1, "lease expired", now + 1001);
  assert.equal(retryable(progress, 1), true);
  assert.equal(claim(progress, 1, "w2", now + 1002, 1000), true);
  release(progress, 1, TASK_STATUS.COMPLETED);
  assert.equal(claim(progress, 1, "w3", now + 2000, 1000), false);
});

test("lease: attempts are bounded", () => {
  const now = 1_000_000;
  const progress = fromTasks([{ id: 1, subject: "a", status: TASK_STATUS.PENDING }], now);
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    assert.equal(claim(progress, 1, `w${i}`, now + i * 10, 5), true);
    fail(progress, 1, "boom", now + i * 10 + 6);
  }
  assert.equal(retryable(progress, 1), false);
  assert.equal(progress[0].status, TASK_STATUS.FAILED);
});

test("memory: a decision from turn 5 survives 200 turns of compaction", () => {
  let memory = "";
  let summary = "";
  let journal = "[t5] decided to keep the contract host-agnostic\n";
  for (let turn = 6; turn <= 200; turn += 1) {
    journal += `[t${turn}] explored file ${turn} without a decision\n`;
    if (turn % 4 === 0) {
      const distilled = distill({ journal, memory, summary });
      memory = distilled.memory;
      summary = distilled.summary;
    }
  }
  assert.match(memory, /host-agnostic/);
  assert.match(summary, /Memory entries/);
});

test("planner: vacuous criteria are rejected, not treated as checks", () => {
  for (const cmd of ["true", "exit 0", "echo ok", ":"]) {
    const raw = JSON.stringify({
      checks: [{ id: "x", cmd, expect: "exit0" }],
      tasks: [{ id: 1, subject: "do work", verify: "x" }],
    });
    const out = normalizePlan(raw, "o", "/tmp");
    assert.equal(out.ok, false, `accepted vacuous command: ${cmd}`);
    assert.match(out.errors.join(" "), /vacuous/);
  }
});

test("lease: heartbeat renewal extends the deadline", () => {
  const now = 1_000_000;
  const progress = fromTasks([{ id: 1, subject: "a", status: "pending" }], now);
  claim(progress, 1, "w1", now, 1000);
  const before = progress[0].lease_until;
  assert.equal(renew(progress, 1, now + 500, 1000), true);
  assert.ok(progress[0].lease_until > before);
});

test("watchdog: a stalled tier-2 mission requests a real re-plan", () => {
  const stalled = { strategy_tier: 2, turn: 8, last_progress_turn: 5, last_replan_turn: 0 };
  assert.equal(needsReplan(stalled), true);
  const reset = afterReplan(stalled, 8);
  assert.equal(reset.strategy_tier, 1);
  assert.equal(reset.last_replan_turn, 8);
  assert.equal(needsReplan(reset), false);
  const early = { strategy_tier: 2, turn: 6, last_progress_turn: 5, last_replan_turn: 0 };
  assert.equal(needsReplan(early), false);
  const prompt = replanPrompt({ objective: "Ship it", results: [{ id: "x", ok: false, summary: "exit 1" }], tasks: [] });
  assert.match(prompt, /COMPLETELY NEW/);
  assert.match(prompt, /exit 1/);
  assert.ok(STALL_TURNS >= 1);
});

test("decide: write ceiling stops a runaway agent", () => {
  const state = { status: STATUS.RUNNING, turn: 2, max_turns: 20, cost_usd: 0, budget_usd: 5, writes: 50, max_writes: 50 };
  assert.equal(decideNext({ state, results: [{ id: "x", ok: true }], tasks: [] }).reason, "write-ceiling");
});

test("lease: v1 migration makes in_progress tasks reclaimable", () => {
  const progress = migrateV1([{ id: 1, subject: "a", status: TASK_STATUS.IN_PROGRESS }], { session_id: "lead" });
  assert.equal(progress[0].lease_until, 0);
  assert.equal(progress[0].owner, "lead");
});
