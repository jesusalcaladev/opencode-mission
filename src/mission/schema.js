// State schema guard. A truncated or hand-edited state.json must degrade to
// safe defaults instead of crashing the supervisor on undefined fields.

import { initialState, STATUS } from "./state.js";

const NUMERIC = [
  "turn",
  "cost_usd",
  "max_turns",
  "budget_usd",
  "hard_budget_usd",
  "max_tokens",
  "tokens",
  "writes",
  "max_writes",
  "failures",
  "max_failures",
  "extensions",
  "max_extensions",
  "best_green",
  "progress_pct",
  "tasks_done",
  "stall_turns",
  "strategy_tier",
  "last_replan_turn",
  "last_progress_turn",
  "last_prompt_at",
  "last_checks_at",
  "last_write_at",
  "review_attempts",
  "recon_agents",
  "goal_audits",
  "max_goal_audits",
  "improve_cycles",
  "max_improve_cycles",
  "clean_audit_rounds",
  "max_clean_audit_rounds",
  "handoff_every_turns",
  "last_handoff_turn",
  "chain_index",
  "chain_total",
  "lease_ms",
  "worker_timeout_ms",
  "max_task_attempts",
  "max_review_attempts",
];

const ARRAYS = [
  "last_checks",
  "review_fingerprints",
  "history",
  "agent_runs",
  "prompt_ledger",
  "handoffs",
  "worker_sessions",
  "facts",
  "model_rotation",
];

const OBJECTS = [
  "stage_reports",
  "task_reports",
  "metrics",
  "check_cache",
  "check_baseline",
  "test_hashes",
  "sizing",
  "deploy",
];

// Optional object-valued keys where `null` means "not captured yet" and must not
// be normalized to `{}` (an empty dependency baseline would report every package
// as newly installed).
const NULLABLE_OBJECTS = ["deps_baseline", "sizing", "deploy"];

export function stateProblems(raw = {}) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["state is not an object"];
  for (const key of NUMERIC) {
    if (raw[key] === undefined) continue;
    if (!Number.isFinite(Number(raw[key]))) problems.push(`${key} is not a finite number`);
  }
  for (const key of ARRAYS)
    if (raw[key] !== undefined && !Array.isArray(raw[key])) problems.push(`${key} is not an array`);
  for (const key of OBJECTS)
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== "object" || raw[key] === null || Array.isArray(raw[key]))
    )
      problems.push(`${key} is not an object`);
  if (raw.status !== undefined && !Object.values(STATUS).includes(raw.status))
    problems.push(`unknown status ${raw.status}`);
  return problems;
}

export function normalizeState(raw = {}) {
  const base = initialState();
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = { ...base, ...source };
  for (const key of NUMERIC) {
    if (out[key] === undefined) out[key] = base[key];
    const value = Number(out[key]);
    out[key] = Number.isFinite(value) ? value : base[key];
  }
  for (const key of ARRAYS) if (!Array.isArray(out[key])) out[key] = [];
  for (const key of OBJECTS)
    if (!out[key] || typeof out[key] !== "object" || Array.isArray(out[key])) out[key] = {};
  for (const key of NULLABLE_OBJECTS) {
    if (out[key] === undefined) out[key] = base[key];
    else if (out[key] !== null && (typeof out[key] !== "object" || Array.isArray(out[key])))
      out[key] = null;
  }
  if (!Object.values(STATUS).includes(out.status)) out.status = base.status;
  return out;
}
