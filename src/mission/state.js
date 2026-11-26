// Pure mission state: constants, defaults and task normalization.
// No IO, no OpenCode: every function here is testable with node --test.

export const VERSION = 2;
export const STATUS = Object.freeze({
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  ABORTED: "aborted",
});

export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_STALL_AFTER_TURNS = 2;
export const DEFAULT_MAX_TASK_ATTEMPTS = 3;
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

// Journal settings. The journal is append-only in the hot path; rotation keeps
// long-running missions from growing it without bound.
export const JOURNAL_HEADER = "# Journal\n\n";
export const JOURNAL_MAX_LINE_CHARS = 2000;
export const JOURNAL_MAX_BYTES = 512 * 1024;
export const JOURNAL_KEEP_ARCHIVES = 3;
export const JOURNAL_TAIL_CHARS = 4000;
export const JOURNAL_MEMORY_CHARS = 12000;

export const FILES = Object.freeze({
  dir: ".mission",
  charter: "charter.md",
  mission: "mission.md",
  criteria: "criteria.json",
  tasks: "tasks.json",
  state: "state.json",
  journal: "journal.md",
  memory: "memory.md",
  summary: "summary.md",
  progress: "progress.json",
  improvements: "improvements.md",
  roadmap: "roadmap.md",
  extend: "EXTEND",
  stop: "STOP",
  pause: "PAUSE",
  evidence: "evidence",
  research: "research",
  metrics: "metrics.json",
});

export const initialState = () => ({
  version: VERSION,
  status: STATUS.RUNNING,
  turn: 0,
  cost_usd: 0,
  max_turns: DEFAULT_MAX_TURNS,
  budget_usd: DEFAULT_BUDGET_USD,
  hard_budget_usd: 0,
  max_tokens: 0,
  tokens: 0,
  auto_extend: false,
  extension_turns: 8,
  extension_budget_usd: 5,
  extension_writes: 50,
  stall_after_turns: DEFAULT_STALL_AFTER_TURNS,
  best_green: 0,
  last_progress_turn: 0,
  strategy_tier: 1,
  stall_turns: 0,
  last_verdict: null,
  last_checks: [],
  session_id: null,
  started_at: new Date().toISOString(),
  finished_at: null,
  finish_reason: null,
  failures: 0,
  max_failures: 3,
  handoff_every_turns: 0,
  last_handoff_turn: 0,
  max_wallclock_min: 0,
  lease_ms: 300000,
  extensions: 0,
  max_extensions: 3,
  chain_index: 0,
  chain_total: 0,
  stage: "investigate",
  review_attempts: 0,
  stage_reports: {},
  facts: [],
  check_cache: null,
  active_improve_id: 0,
  improve_revert_sha: "",
  continuous_improvement: true,
  improve_cycles: 0,
  max_improve_cycles: 5,
  min_impact: "medium",
  clean_audit_rounds: 0,
  max_clean_audit_rounds: 2,
  max_writes: 0,
  writes: 0,
  last_replan_turn: 0,
  last_prompt_at: 0,
  test_hashes: null,
  last_commit: null,
  worktree_root: "",
  worktree_branch: "",
  history: [],
  agent_runs: [],
  prompt_ledger: [],
  handoffs: [],
  metrics: {},
  last_checks_at: 0,
  phase: "implement",
  paused: false,
  goal_audit: false,
  max_goal_audits: 3,
  goal_audits: 0,
  worker_timeout_ms: 1800000,
  needs_research: false,
  research: false,
  never_give_up: false,
  max_task_attempts: DEFAULT_MAX_TASK_ATTEMPTS,
  max_review_attempts: DEFAULT_MAX_REVIEW_ATTEMPTS,
  mutation_checks: false,
  strict_checks: false,
  global_memory: false,
  model_rotation: [],
  check_baseline: {},
  cost_extra_usd: 0,
});

export function parseFrontmatter(text) {
  const out = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

export function objectiveOf(missionText) {
  return (
    (missionText ?? "")
      .replace(/^---[\s\S]*?---\r?\n/, "")
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "(no objective)"
  );
}

export function normalizeTask(task, index = 0) {
  const files = Array.isArray(task?.files) ? task.files.filter((f) => typeof f === "string") : [];
  const blocked = Array.isArray(task?.blocked_by)
    ? task.blocked_by.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0)
    : [];
  const status = ["pending", "in_progress", "completed", "failed"].includes(task?.status)
    ? task.status
    : TASK_STATUS.PENDING;
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task.id) > 0 ? Number(task.id) : index + 1,
    subject: String(task?.subject ?? `Task ${index + 1}`).slice(0, 160),
    status,
    verify: typeof task?.verify === "string" ? task.verify : "",
    files,
    blocked_by: blocked.map(Number),
  };
}
