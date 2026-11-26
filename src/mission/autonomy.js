// Pure helpers for long-horizon campaign mode.

export const HISTORY_LIMIT = 200;

/// Zero is a first-class "unlimited" value for effort ceilings.
export function effortLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : fallback;
}

export function recentProgress(state, window = 3) {
  const turn = Number(state?.turn) || 0;
  const last = Number(state?.last_progress_turn ?? turn);
  const green = Number(state?.best_green) || 0;
  const done = Number(state?.tasks_done) || 0;
  return turn - last <= Math.max(1, window) && (green > 0 || done > 0);
}

export function appendHistory(state, { results = [], tasks = [], ts = Date.now() } = {}) {
  const green = results.filter((r) => r.ok).length;
  const done = tasks.filter((t) => t.status === "completed").length;
  const entry = {
    turn: Number(state?.turn) || 0,
    green,
    done,
    cost: Number(state?.cost_usd) || 0,
    ts,
  };
  const history = Array.isArray(state?.history) ? state.history.slice(-(HISTORY_LIMIT - 1)) : [];
  return [...history, entry];
}

export function campaignSettings(plan) {
  const s = plan?.settings ?? {};
  const relentless = s.never_give_up === true || s.autonomy === "relentless";
  return {
    autonomy: s.autonomy ?? "standard",
    never_give_up: relentless || s.never_give_up === true,
    max_turns: s.max_turns ?? (relentless ? 0 : 40),
    max_wallclock_min: s.max_wallclock_min ?? 480,
    budget_usd: s.budget_usd ?? 5,
    hard_budget_usd: s.hard_budget_usd ?? 25,
    auto_extend: s.auto_extend ?? true,
    max_extensions: s.max_extensions ?? (relentless ? 0 : 50),
    extension_turns: s.extension_turns ?? 20,
    extension_writes: s.extension_writes ?? 200,
    extension_budget_usd: s.extension_budget_usd ?? 5,
    max_writes: s.max_writes ?? (relentless ? 0 : 500),
    max_failures: s.max_failures ?? (relentless ? 0 : 5),
    max_task_attempts: s.max_task_attempts ?? (relentless ? 0 : 3),
    max_review_attempts: s.max_review_attempts ?? (relentless ? 0 : 2),
    strict_checks: s.strict_checks ?? relentless,
    global_memory: s.global_memory ?? relentless,
    handoff_every_turns: s.handoff_every_turns ?? 8,
    lease_ms: s.lease_ms ?? 600000,
    worker_timeout_ms: s.worker_timeout_ms ?? 1800000,
    max_improve_cycles: s.max_improve_cycles ?? (relentless ? 0 : 20),
    min_impact: s.min_impact ?? "medium",
    goal_audit: s.goal_audit ?? true,
    max_goal_audits: s.max_goal_audits ?? (relentless ? 0 : 3),
    continuous_improvement: s.continuous_improvement ?? true,
    isolation: s.isolation ?? "none",
  };
}
