// Plan settings normalization. `0` is a first-class unlimited value for effort
// ceilings; hard budget and wall-clock defaults stay protective in relentless.

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

export function normalizeSettings(raw = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const campaign = s.autonomy === "campaign";
  const relentless = s.never_give_up === true || s.autonomy === "relentless";
  return {
    autonomy: campaign ? "campaign" : relentless ? "relentless" : "standard",
    never_give_up: relentless,
    max_turns: relentless
      ? clamp(s.max_turns, 0, 100_000, 0)
      : clamp(s.max_turns, 4, 500, campaign ? 40 : 16),
    budget_usd: clamp(s.budget_usd, 0.1, 1000, 5),
    hard_budget_usd: clamp(s.hard_budget_usd, 0, 10000, campaign || relentless ? 25 : 0),
    max_tokens: clamp(s.max_tokens, 0, 100_000_000, 0),
    auto_extend: campaign || relentless ? s.auto_extend !== false : s.auto_extend === true,
    max_extensions: clamp(s.max_extensions, 0, 100_000, relentless ? 0 : campaign ? 50 : 3),
    extension_turns: clamp(s.extension_turns, 1, 200, campaign ? 20 : 8),
    extension_writes: clamp(s.extension_writes, 0, 10000, campaign ? 200 : 50),
    extension_budget_usd: clamp(s.extension_budget_usd, 0, 1000, 5),
    goal_audit: campaign || relentless ? s.goal_audit !== false : s.goal_audit === true,
    max_goal_audits: clamp(s.max_goal_audits, 0, 100_000, relentless ? 0 : 3),
    max_task_attempts: clamp(s.max_task_attempts, 0, 100, relentless ? 0 : 3),
    max_review_attempts: clamp(s.max_review_attempts, 0, 100, relentless ? 0 : 2),
    mutation_checks: s.mutation_checks === true || (relentless && s.mutation_checks !== false),
    require_e2e: s.require_e2e === true || (relentless && s.require_e2e !== false),
    strict_checks: s.strict_checks === true || (relentless && s.strict_checks !== false),
    global_memory: s.global_memory === true || (relentless && s.global_memory !== false),
    continuous_improvement: s.continuous_improvement !== false,
    max_improve_cycles: clamp(s.max_improve_cycles, 0, 100_000, relentless ? 0 : campaign ? 20 : 5),
    min_impact: ["low", "medium", "high"].includes(s.min_impact) ? s.min_impact : "medium",
    handoff_every_turns: clamp(s.handoff_every_turns, 0, 40, campaign ? 8 : 4),
    max_failures: relentless
      ? clamp(s.max_failures, 0, 100, 0)
      : clamp(s.max_failures, 1, 20, campaign ? 5 : 3),
    max_wallclock_min: clamp(s.max_wallclock_min, 0, 1440, campaign || relentless ? 480 : 0),
    lease_ms: clamp(s.lease_ms, 1000, 3_600_000, campaign ? 600000 : 300000),
    worker_timeout_ms: clamp(s.worker_timeout_ms, 1000, 7_200_000, 1_800_000),
    max_writes: clamp(s.max_writes, 0, 100_000, campaign ? 500 : 0),
    isolation: s.isolation === "worktree" ? "worktree" : "none",
  };
}
