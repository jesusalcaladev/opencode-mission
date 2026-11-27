// Pure-ish read model for the Mission Control TUI.
// Runs in the TUI process: only reads durable files written by the supervisor.
// No OpenTUI, no Solid, no network. Everything here is testable with node --test.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectTask } from "../mission/decide.js";
import { STATUS, JOURNAL_TAIL_CHARS } from "../mission/state.js";
import { readJournalTail } from "../mission.js";
import { forecastBudget } from "../mission/forecast.js";
import { QUEUE_FILE } from "../mission/queue.js";
import {
  computeProgress,
  normalizeChecks,
  normalizeTasks,
  normalizeAgents,
  normalizeRequirements,
  ratio,
  objectiveOf,
} from "./normalize.js";
export { computeProgress, normalizeRequirements } from "./normalize.js";
import { metricsFromState, metricsLines } from "../mission/metrics.js";

export const cacheDir = () =>
  process.env.OPENCODE_MISSION_CACHE_DIR ??
  path.join(os.homedir?.() ?? process.env.HOME ?? "", ".cache", "opencode-mission");
export const pointerPath = () => path.join(cacheDir(), "current.json");
export const registryPath = () => path.join(cacheDir(), "missions.json");

const readText = (file, fallback = "") => readFile(file, "utf8").catch(() => fallback);

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readPointer() {
  const data = await readJson(pointerPath(), null);
  return data && typeof data.root === "string" ? data : null;
}

export async function readRegistry() {
  const data = await readJson(registryPath(), []);
  return Array.isArray(data) ? data.filter((e) => e && typeof e.root === "string") : [];
}

import { discoverRoots, isMissionRoot } from "./registry.js";

export async function loadMission(root) {
  const dir = path.join(root, ".mission");
  const [state, tasksData, progressData, criteria, missionText, journal, research, hostRestart] =
    await Promise.all([
      readJson(path.join(dir, "state.json"), {}),
      readJson(path.join(dir, "tasks.json"), {}),
      readJson(path.join(dir, "progress.json"), {}),
      readJson(path.join(dir, "criteria.json"), {}),
      readText(path.join(dir, "mission.md")),
      readJournalTail(root, JOURNAL_TAIL_CHARS),
      readText(path.join(root, "research", "report.md")),
      readJson(path.join(dir, "host-restart.json"), {}),
    ]);
  const hasState = state && typeof state === "object" && Object.keys(state).length > 0;
  const checks = normalizeChecks(state);
  const tasks = normalizeTasks(tasksData?.tasks);
  const progress = Array.isArray(progressData)
    ? progressData
    : Array.isArray(progressData?.tasks)
      ? progressData.tasks
      : [];
  const requirements = normalizeRequirements(criteria, checks);
  const progressMetrics = computeProgress(
    checks,
    tasks,
    requirements,
    Number(state?.progress_pct) || 0
  );
  const next = selectTask(tasks);
  const started = Number(state?.started_at ? Date.parse(state.started_at) : 0) || 0;
  const now = Date.now();
  const turn = Number(state?.turn) || 0;
  const maxTurns = Number(state?.max_turns) || 0;
  const cost = Number(state?.cost_usd) || 0;
  const budget = Number(state?.budget_usd) || 0;
  const hardBudget = Number(state?.hard_budget_usd) || 0;
  const history = Array.isArray(state?.history) ? state.history.slice(-40) : [];
  const status = hasState ? String(state.status ?? STATUS.RUNNING) : "idle";
  const forecast = forecastBudget(state, now);

  return {
    root,
    id: String(state?.id ?? path.basename(root)),
    objective: objectiveOf(missionText),
    status,
    phase: String(state?.phase ?? state?.stage ?? ""),
    stage: String(state?.stage ?? ""),
    strategy_tier: Number(state?.strategy_tier) || 1,
    stall_turns: Number(state?.stall_turns) || 0,
    sessionID: String(state?.session_id ?? ""),
    turn,
    max_turns: maxTurns,
    writes: Number(state?.writes) || 0,
    max_writes: Number(state?.max_writes) || 0,
    cost_usd: cost,
    budget_usd: budget,
    hard_budget_usd: hardBudget,
    extensions: Number(state?.extensions) || 0,
    max_extensions: Number(state?.max_extensions) || 0,
    chain_index: Number(state?.chain_index) || 0,
    chain_total: Number(state?.chain_total) || 0,
    improve_cycles: Number(state?.improve_cycles) || 0,
    max_improve_cycles: Number(state?.max_improve_cycles) || 0,
    started_at: started,
    finished_at: state?.finished_at ? Date.parse(state.finished_at) || 0 : 0,
    finish_reason: String(state?.finish_reason ?? ""),
    last_checks_at: Number(state?.last_checks_at) || 0,
    worktree_branch: String(state?.worktree_branch ?? ""),
    auto_extend: Boolean(state?.auto_extend),
    paused: Boolean(state?.paused),
    checks,
    tasks,
    requirements,
    agents: normalizeAgents(state, progress),
    history,
    metrics: metricsFromState(state),
    metrics_lines: metricsLines(state.metrics),
    prompt_backlog: Array.isArray(state?.prompt_ledger) ? state.prompt_ledger.slice(-6) : [],
    handoffs: Array.isArray(state?.handoffs) ? state.handoffs.slice(-6) : [],
    journal: journal.trim().slice(-3000),
    research: research.trim().slice(0, 3000),
    nextTask: next ? { id: next.id, subject: next.subject } : null,
    ...progressMetrics,
    elapsed_ms:
      started && status === STATUS.RUNNING
        ? now - started
        : started && state?.finished_at
          ? (Date.parse(state.finished_at) || now) - started
          : 0,
    budget_pct: budget > 0 ? Math.round(ratio(cost, budget) * 100) : 0,
    tokens: Number(state?.tokens) || 0,
    max_tokens: Number(state?.max_tokens) || 0,
    token_pct:
      Number(state?.max_tokens) > 0
        ? Math.round(ratio(Number(state?.tokens) || 0, Number(state?.max_tokens)) * 100)
        : 0,
    forecast_cost_usd: forecast.forecast_cost_usd,
    forecast_tokens: forecast.forecast_tokens,
    forecast_minutes: forecast.forecast_minutes,
    forecast_confidence: forecast.confidence,
    over_hard_budget: forecast.over_hard_budget,
    over_token_budget: forecast.over_token_budget,
    host_restarts: Number(hostRestart?.attempts) || 0,
    host_restart_error: String(hostRestart?.last_error ?? ""),
    turn_pct: maxTurns > 0 ? Math.round(ratio(turn, maxTurns) * 100) : 0,
    active: status === STATUS.RUNNING || status === STATUS.PAUSED,
    updatedAt: now,
  };
}

/**
 * Choose the mission a terminal should display.
 *
 * The pointer and the registry are shared, process-global files: whichever
 * mission was started last used to win everywhere. A session must instead see
 * only its own mission. When a sessionID is supplied and that session has no
 * mission we return null (the sidebar shows its empty state), never another
 * terminal's work. The global pointer is consulted only when there is no
 * active session at all, e.g. the dashboard opened from the home screen.
 */
export function selectSnapshot({ sessionID, pointer, registry = [], snapshots = [] } = {}) {
  const full = snapshots.filter(Boolean);
  const byRoot = new Map(full.map((s) => [path.resolve(s.root), s]));

  if (sessionID) {
    const owned = registry
      .filter((e) => e && e.sessionID === sessionID && typeof e.root === "string")
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    for (const entry of owned) {
      const match = byRoot.get(path.resolve(entry.root));
      if (match) return match;
    }
    // Older missions may predate the registry; their state still names the lead.
    return full.find((s) => s.sessionID === sessionID) ?? null;
  }

  if (pointer?.root) {
    const match = byRoot.get(path.resolve(pointer.root));
    if (match) return match;
  }
  return full.find((s) => s.status === STATUS.RUNNING) ?? full[0] ?? null;
}

export async function loadTuiModel({ missionsRoot, maxMissions = 12, sessionID } = {}) {
  const pointer = await readPointer();
  const registry = await readRegistry();
  const roots = await discoverRoots(missionsRoot, maxMissions);
  const queueRoot = missionsRoot ?? (pointer?.root ? path.dirname(pointer.root) : null);
  const queueData = queueRoot ? await readJson(path.join(queueRoot, QUEUE_FILE), []) : [];
  const queue = (Array.isArray(queueData) ? queueData : []).slice(0, 12).map((e) => ({
    id: String(e?.id ?? ""),
    objective: String(e?.objective ?? "").slice(0, 100),
    priority: Number(e?.priority) || 0,
    status: String(e?.status ?? "pending"),
  }));

  // The active session's workspace must never be dropped by the discovery cap.
  const ownRoots = [
    ...(sessionID
      ? registry
          .filter((e) => e && e.sessionID === sessionID && typeof e.root === "string")
          .map((e) => path.resolve(e.root))
      : []),
    ...(pointer?.root ? [path.resolve(pointer.root)] : []),
    ...registry
      .filter((e) => e?.status === STATUS.RUNNING && e?.root)
      .slice(0, 3)
      .map((e) => path.resolve(e.root)),
  ];
  const allRoots = [...new Set([...ownRoots, ...roots])];

  // Defense in depth: a workspace can be deleted between discovery and load.
  // Never render a mission whose files are no longer on disk.
  const snapshots = await Promise.all(
    allRoots.map(async (root) =>
      (await isMissionRoot(root)) ? loadMission(root).catch(() => null) : null
    )
  );
  const full = snapshots.filter(Boolean);
  const missions = full
    .map((s) => ({
      root: s.root,
      id: s.id,
      objective: s.objective,
      status: s.status,
      pct: s.pct,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => {
      const priority = (s) =>
        s.status === STATUS.RUNNING ? 2 : s.status === STATUS.PAUSED ? 1 : 0;
      return priority(b) - priority(a) || b.updatedAt - a.updatedAt;
    })
    .slice(0, maxMissions);
  const snapshot = selectSnapshot({ sessionID, pointer, registry, snapshots: full });
  return { snapshot, missions, queue, updatedAt: Date.now() };
}
