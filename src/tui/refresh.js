// Refresh runner for Mission Control. Pure JS (no Solid, no OpenTUI), so the
// failure modes that froze the panel are testable with node --test.
//
// Two real bugs this replaces:
//   1. A rejected `load()` broke the `setTimeout` chain forever: the sidebar and
//      dashboard stopped updating until some unrelated data event fired.
//   2. Every data event started its own overlapping load, so a slow read could
//      land after a newer one and overwrite the snapshot with older data.
//
// `run()` never rejects, never runs two loads at once, and collapses any number
// of concurrent callers into the in-flight read plus at most one trailing read.

export function createRefresher({ load, apply } = {}) {
  if (typeof load !== "function" || typeof apply !== "function")
    throw new TypeError("createRefresher requires load and apply functions");

  let inflight = null;
  let queued = false;
  let disposed = false;
  let lastError = null;
  let failures = 0;

  async function once() {
    try {
      const value = await load();
      apply(value);
      lastError = null;
      failures = 0;
      return { ok: true, value };
    } catch (error) {
      // Kept as state instead of a rejection: the caller polls, it cannot await
      // and recover from every disk hiccup.
      lastError = error;
      failures += 1;
      return { ok: false, error };
    }
  }

  // Serial by construction: no second read starts before the first applied.
  async function drain() {
    let result = await once();
    while (queued) {
      queued = false;
      result = await once();
    }
    inflight = null;
    return result;
  }

  return {
    run() {
      if (disposed) return Promise.resolve({ ok: false, skipped: true });
      if (inflight) {
        queued = true;
        return inflight;
      }
      inflight = drain();
      return inflight;
    },
    dispose() {
      disposed = true;
      queued = false;
    },
    state() {
      return { busy: Boolean(inflight), queued, disposed, failures, lastError };
    },
  };
}

/// Re-arms a timer forever. A rejecting `tick` never ends the loop.
export function startPolling({ tick, delay, isStopped = () => false, setTimer, clearTimer }) {
  let timer = null;
  let stopped = false;
  const next = () => {
    if (stopped || isStopped()) return;
    const value = typeof delay === "function" ? delay() : delay;
    const ms = Math.max(50, Number(value) || 1000);
    timer = setTimer(async () => {
      timer = null;
      try {
        await tick();
      } catch {
        // The next pass retries; a failed read must never stop the loop.
      }
      next();
    }, ms);
    timer?.unref?.();
  };
  next();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  };
}
