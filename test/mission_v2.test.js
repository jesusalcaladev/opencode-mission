import test from "node:test";
import assert from "node:assert/strict";

import { STATUS, TASK_STATUS, parseFrontmatter, objectiveOf, normalizeTask } from "../src/mission/state.js";
import { decideNext, applyTaskResults } from "../src/mission/decide.js";
import { distill, buildBrief } from "../src/mission/memory.js";
import { fromTasks, migrateV1, claim, release, fail, expired, retryable, MAX_ATTEMPTS } from "../src/mission/lease.js";

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

test("lease: v1 migration makes in_progress tasks reclaimable", () => {
  const progress = migrateV1([{ id: 1, subject: "a", status: TASK_STATUS.IN_PROGRESS }], { session_id: "lead" });
  assert.equal(progress[0].lease_until, 0);
  assert.equal(progress[0].owner, "lead");
});
