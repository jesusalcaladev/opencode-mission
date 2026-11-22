// Pure mission state: constants, defaults and task normalization.
// No IO, no OpenCode: every function here is testable with node --test.

export const VERSION = 2;
export const STATUS = Object.freeze({
  RUNNING: "running",
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
  evidence: "evidence",
});

export const initialState = () => ({
  version: VERSION,
  status: STATUS.RUNNING,
  turn: 0,
  cost_usd: 0,
  max_turns: DEFAULT_MAX_TURNS,
  budget_usd: DEFAULT_BUDGET_USD,
  stall_after_turns: DEFAULT_STALL_AFTER_TURNS,
  best_green: 0,
  last_progress_turn: 0,
  strategy_tier: 1,
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
  return (missionText ?? "")
    .replace(/^---[\s\S]*?---\r?\n/, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)?.trim() ?? "(no objective)";
}

export function normalizeTask(task, index = 0) {
  const files = Array.isArray(task?.files) ? task.files.filter((f) => typeof f === "string") : [];
  const blocked = Array.isArray(task?.blocked_by)
    ? task.blocked_by.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0)
    : [];
  const status = ["pending", "in_progress", "completed", "failed"].includes(task?.status) ? task.status : TASK_STATUS.PENDING;
  return {
    id: Number.isFinite(Number(task?.id)) && Number(task.id) > 0 ? Number(task.id) : index + 1,
    subject: String(task?.subject ?? `Task ${index + 1}`).slice(0, 160),
    status,
    verify: typeof task?.verify === "string" ? task.verify : "",
    files,
    blocked_by: blocked.map(Number),
  };
}
