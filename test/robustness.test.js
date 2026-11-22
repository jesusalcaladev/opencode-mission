import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";

import { Supervisor } from "../src/supervisor.js";
import { allGreen } from "../src/mission/decide.js";
import { ensureMission, loadState, writeJsonAtomic } from "../src/mission.js";

const emptyCtx = () => ({
  storage: { get: async () => [], set: async () => {} },
  session: {
    create: async () => ({ id: "role_1" }),
    prompt: async () => {},
    wait: async () => {},
    synthetic: async () => {},
  },
  model: { list: async () => [], default: async () => null },
  location: { directory: "/tmp" },
});

test("atomic writes: concurrent writers to one file never collide or leak temp files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-atomic-"));
  const file = path.join(root, "value.json");
  try {
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeJsonAtomic(file, { i })));
    const value = JSON.parse(await readFile(file, "utf8"));
    assert.equal(typeof value.i, "number");
    const leftovers = (await readdir(root)).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialize: external callers queue while nested callers stay reentrant", async () => {
  const sup = new Supervisor(emptyCtx());
  const events = [];
  let active = 0;
  let maxActive = 0;
  const work = (id, nested) =>
    sup.serialize("/mission", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (nested) await sup.serialize("/mission", async () => events.push("nested"));
      active -= 1;
      events.push(`end:${id}`);
    });
  try {
    await Promise.all([work("a", true), work("b", false), work("c", false)]);
    assert.equal(maxActive, 1);
    assert.ok(events.indexOf("nested") > events.indexOf("start:a"));
    assert.ok(events.indexOf("nested") < events.indexOf("end:a"));
    assert.equal(sup.stateQueue.size, 0);
  } finally {
    sup.dispose();
  }
});

test("allGreen requires at least one green check", () => {
  assert.equal(allGreen([{ id: "a", ok: true }]), true);
  assert.equal(
    allGreen([
      { id: "a", ok: true },
      { id: "b", ok: false },
    ]),
    false
  );
  assert.equal(allGreen([]), false);
});

test("mission registry stays bounded across many bindings", async () => {
  const sup = new Supervisor(emptyCtx());
  try {
    for (let i = 0; i < 45; i += 1) await sup.persistBinding(`session-${i}`, `/tmp/mission-${i}`);
    assert.equal(sup.registry.length, 30);
    assert.ok(sup.registry.some((e) => e.sessionID === "session-44"));
    assert.ok(!sup.registry.some((e) => e.sessionID === "session-0"));
  } finally {
    sup.dispose();
  }
});

test("state writes from parallel tools never lose an update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-parallel-"));
  const sup = new Supervisor(emptyCtx());
  sup.bind("lead", root);
  try {
    await ensureMission(root, { id: "parallel-tools" });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        sup.toolFact("lead", { kind: "note", subject: `subject-${i}`, text: `value-${i}` })
      )
    );
    const state = await loadState(root);
    assert.equal(state.facts.length, 50);
    for (let i = 0; i < 50; i += 1) {
      assert.ok(state.facts.some((f) => f.subject === `subject-${i}` && f.text === `value-${i}`));
    }
  } finally {
    sup.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed role dispatch cleans up and records a failed run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-role-"));
  try {
    await ensureMission(root, { id: "role-cleanup" });
    const ctx = emptyCtx();
    ctx.session.prompt = async () => {
      throw new Error("delivery exploded");
    };
    const sup = new Supervisor(ctx);
    sup.bind("lead", root);
    try {
      const report = await sup.dispatchRoleStage("lead", root, "reviewer", "review it");
      assert.equal(report, undefined);
      assert.equal(sup.workers.has("role_1"), false);
      assert.equal(sup.knownWorkers.has("role_1"), false);
      const state = await loadState(root);
      const run = (state.agent_runs ?? []).find((r) => r.sessionID === "role_1");
      assert.equal(run?.status, "failed");
    } finally {
      sup.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
