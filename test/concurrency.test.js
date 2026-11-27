import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { ensureMission, loadState, saveState } from "../src/mission.js";

function fakeCtx() {
  const store = new Map();
  return {
    storage: { get: async (k) => store.get(k), set: async (k, v) => store.set(k, v) },
    session: {
      context: async () => [],
      prompt: async () => {},
      create: async () => ({ id: "session" }),
      get: async () => null,
      wait: async () => {},
      synthetic: async () => {},
      switchModel: async () => {},
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
  };
}

test("serialize gives each concurrent write a unique turn and no lost updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-concurrency-"));
  try {
    await ensureMission(root, { objective: "concurrency" });
    const sup = new Supervisor(fakeCtx());
    const observed = await Promise.all(
      Array.from({ length: 25 }, () =>
        sup.serialize(root, async () => {
          const state = await loadState(root);
          state.writes = (Number(state.writes) || 0) + 1;
          await saveState(root, state);
          return state.writes;
        })
      )
    );
    assert.deepEqual(
      [...observed].sort((a, b) => a - b),
      Array.from({ length: 25 }, (_, i) => i + 1)
    );
    assert.equal((await loadState(root)).writes, 25);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("warn journals best-effort failures and is safe when journaling fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-warn-"));
  try {
    await ensureMission(root, { objective: "warn" });
    const sup = new Supervisor(fakeCtx());
    await sup.warn(root, "tool failed", new Error("boom"));
    const journal = await sup.d.readFile(path.join(root, ".mission", "journal.md"), "utf8");
    assert.match(journal, /tool failed: (Error: )?boom/);
    sup.journal = async () => {
      throw new Error("journal down");
    };
    await sup.warn(root, "second failure", new Error("boom 2"));
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
