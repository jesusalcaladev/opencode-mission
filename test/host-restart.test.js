import test from "node:test";
import assert from "node:assert/strict";
import {
  restartBackoff,
  hostRestartDecision,
  HOST_RESTART_FILE,
} from "../src/mission/host-restart.js";

test("restartBackoff doubles with a hard cap", () => {
  assert.equal(restartBackoff(1, 1000), 1000);
  assert.equal(restartBackoff(2, 1000), 2000);
  assert.equal(restartBackoff(3, 1000), 4000);
  assert.equal(restartBackoff(20, 1000), 900_000);
});

test("hostRestartDecision respects every hard guard", () => {
  const now = 1_000_000;
  const running = { status: "running" };
  assert.equal(hostRestartDecision({ state: { status: "complete" }, now }).reason, "not-running");
  assert.equal(hostRestartDecision({ state: running, stopFile: true, now }).reason, "stop-file");
  assert.equal(hostRestartDecision({ state: running, pauseFile: true, now }).reason, "paused");
  assert.equal(
    hostRestartDecision({ state: running, wakeAgeMs: 1000, now }).reason,
    "wake-not-stale"
  );
  assert.equal(HOST_RESTART_FILE, "host-restart.json");

  const due = hostRestartDecision({ state: running, wakeAgeMs: 200_000, now, maxRestarts: 3 });
  assert.equal(due.restart, true);
  assert.equal(due.attempts, 1);
  assert.equal(due.next_at, now + 60_000);

  const capped = hostRestartDecision({
    state: running,
    wakeAgeMs: 200_000,
    now,
    restart: { attempts: 3, window_start: now - 1000 },
    maxRestarts: 3,
  });
  assert.equal(capped.reason, "restart-limit");

  const waiting = hostRestartDecision({
    state: running,
    wakeAgeMs: 200_000,
    now,
    restart: { attempts: 1, window_start: now - 1000, next_at: now + 30_000 },
    maxRestarts: 3,
  });
  assert.equal(waiting.reason, "backoff");

  const freshWindow = hostRestartDecision({
    state: running,
    wakeAgeMs: 200_000,
    now,
    restart: { attempts: 5, window_start: now - 10_000_000, next_at: now + 999_999 },
    maxRestarts: 3,
  });
  assert.equal(freshWindow.reason, "new-window");
  assert.equal(freshWindow.attempts, 1);
});
