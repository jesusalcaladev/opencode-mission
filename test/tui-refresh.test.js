import test from "node:test";
import assert from "node:assert/strict";
import { createRefresher, startPolling } from "../src/tui/refresh.js";

const deferred = () => {
  const box = {};
  const promise = new Promise((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value) => box.resolve(value) };
};

test("refresher: requires load and apply", () => {
  assert.throws(() => createRefresher({}), /requires load and apply/);
  assert.throws(() => createRefresher({ load: () => ({}) }), /requires load and apply/);
});

test("refresher: a failed load never stops the next refresh", async () => {
  let calls = 0;
  const applied = [];
  const refresher = createRefresher({
    load: async () => {
      calls += 1;
      if (calls === 1) throw new Error("EACCES: cache not readable");
      return { value: calls };
    },
    apply: (value) => applied.push(value),
  });
  const first = await refresher.run();
  assert.equal(first.ok, false);
  assert.match(String(refresher.state().lastError.message), /EACCES/);
  const second = await refresher.run();
  assert.equal(second.ok, true);
  assert.deepEqual(applied, [{ value: 2 }]);
  assert.equal(refresher.state().failures, 0);
  refresher.dispose();
});

test("refresher: concurrent runs collapse into one load plus one trailing pass", async () => {
  let loads = 0;
  const gate = deferred();
  const refresher = createRefresher({
    load: async () => {
      loads += 1;
      if (loads === 1) await gate.promise;
      return { loads };
    },
    apply: () => {},
  });
  const a = refresher.run();
  const b = refresher.run();
  const c = refresher.run();
  assert.equal(a, b, "callers share the in-flight promise");
  assert.equal(c, b);
  gate.resolve();
  await a;
  assert.equal(loads, 2, "three calls collapse to the in-flight read plus one trailing read");
  refresher.dispose();
});

test("refresher: loads never overlap, so snapshots are applied in order", async () => {
  const slow = deferred();
  let active = 0;
  let maxActive = 0;
  const applied = [];
  const refresher = createRefresher({
    load: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (applied.length === 0) await slow.promise;
        return { id: `snap-${applied.length}` };
      } finally {
        active -= 1;
      }
    },
    apply: (value) => applied.push(value.id),
  });
  const first = refresher.run();
  const second = refresher.run();
  slow.resolve();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1, "two reads at once could land out of order");
  assert.deepEqual(applied, ["snap-0", "snap-1"]);
  refresher.dispose();
});

test("refresher: apply errors are reported, not thrown", async () => {
  const refresher = createRefresher({
    load: async () => ({}),
    apply: () => {
      throw new Error("store is gone");
    },
  });
  const result = await refresher.run();
  assert.equal(result.ok, false);
  assert.match(String(refresher.state().lastError.message), /store is gone/);
  refresher.dispose();
});

test("refresher: dispose stops applying and short-circuits runs", async () => {
  let applied = 0;
  const refresher = createRefresher({
    load: async () => ({}),
    apply: () => {
      applied += 1;
    },
  });
  refresher.dispose();
  const result = await refresher.run();
  assert.equal(result.skipped, true);
  assert.equal(applied, 0);
});

test("polling: a rejecting tick keeps the loop alive", async () => {
  const runs = [];
  const box = {};
  const done = new Promise((resolve) => {
    box.resolve = resolve;
  });
  const stop = startPolling({
    tick: async () => {
      runs.push(runs.length + 1);
      if (runs.length === 1) throw new Error("transient read failure");
      if (runs.length === 3) box.resolve();
    },
    delay: 5,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle),
  });
  await done;
  stop();
  assert.ok(runs.length >= 3, "the loop must keep ticking after a failed pass");
});

test("polling: stops immediately when told to", async () => {
  let ticks = 0;
  const stop = startPolling({
    tick: async () => {
      ticks += 1;
    },
    delay: 5,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle),
  });
  stop();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ticks, 0);
});

test("polling: a stop during a slow tick prevents the next pass", async () => {
  let ticks = 0;
  const box = {};
  const started = new Promise((resolve) => {
    box.resolve = resolve;
  });
  const stop = startPolling({
    tick: async () => {
      ticks += 1;
      box.resolve();
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    delay: () => 5,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle),
  });
  await started;
  stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ticks, 1, "the loop must not re-arm after stop()");
});

test("polling: isStopped prevents any tick", async () => {
  let ticks = 0;
  const stop = startPolling({
    tick: async () => {
      ticks += 1;
    },
    delay: 5,
    isStopped: () => true,
    setTimer: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer: (handle) => clearTimeout(handle),
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.equal(ticks, 0);
});
