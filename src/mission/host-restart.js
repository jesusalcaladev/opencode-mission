// Pure decision layer for the external host supervisor. It never writes state:
// an out-of-process helper only reacts to a WAKE marker that stayed stale,
// which means the in-process watchdog could not revive the session.

export const HOST_RESTART_FILE = "host-restart.json";
export const DEFAULT_RESTART_MAX = 3;
export const DEFAULT_RESTART_BACKOFF_MS = 60_000;
export const DEFAULT_RESTART_WINDOW_MS = 3_600_000;
export const DEFAULT_WAKE_AGE_MS = 120_000;

export function restartBackoff(attempt, base = DEFAULT_RESTART_BACKOFF_MS) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(
    900_000,
    Math.max(1000, Number(base) || DEFAULT_RESTART_BACKOFF_MS) * 2 ** (n - 1)
  );
}

export function hostRestartDecision({
  state = {},
  stopFile = false,
  pauseFile = false,
  wakeAgeMs = Infinity,
  restart = {},
  now = Date.now(),
  maxRestarts = DEFAULT_RESTART_MAX,
  windowMs = DEFAULT_RESTART_WINDOW_MS,
  backoffMs = DEFAULT_RESTART_BACKOFF_MS,
  minWakeAgeMs = DEFAULT_WAKE_AGE_MS,
} = {}) {
  if (state.status !== "running") return { restart: false, reason: "not-running" };
  if (stopFile) return { restart: false, reason: "stop-file" };
  if (pauseFile) return { restart: false, reason: "paused" };
  if (
    !Number.isFinite(wakeAgeMs) ||
    wakeAgeMs < Math.max(1000, Number(minWakeAgeMs) || DEFAULT_WAKE_AGE_MS)
  )
    return { restart: false, reason: "wake-not-stale" };

  const windowStart = Number(restart.window_start) || now;
  const expiredWindow = now - windowStart > Math.max(1000, Number(windowMs) || windowMs);
  const attempts = expiredWindow ? 0 : Math.max(0, Number(restart.attempts) || 0);
  const limit = Math.max(0, Number(maxRestarts) || 0);
  if (attempts >= limit) return { restart: false, reason: "restart-limit", attempts };
  if (!expiredWindow && Number(restart.next_at) > now)
    return { restart: false, reason: "backoff", attempts };

  const nextAttempt = attempts + 1;
  return {
    restart: true,
    reason: expiredWindow ? "new-window" : "stale-wake",
    attempts: nextAttempt,
    window_start: expiredWindow ? now : windowStart,
    next_at: now + restartBackoff(nextAttempt, backoffMs),
  };
}
