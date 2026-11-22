// Pure-ish read model for the Mission Control TUI.
// Runs in the TUI process: only reads durable files written by the supervisor.
// No OpenTUI, no Solid, no network. Everything here is testable with node --test.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectTask } from "../mission/decide.js";
import { STATUS, TASK_STATUS, JOURNAL_TAIL_CHARS } from "../mission/state.js";
import { readJournalTail } from "../mission.js";
import { metricsFromState, metricsLines } from "../mission/metrics.js";

export const cacheDir = () =>
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

import { discoverRoots } from "./registry.js";

const ratio = (a, b) => (b > 0 ? a / b : 0);
export function computeProgress(checks, tasks, requirements) {
  const checksGreen = checks.filter((c) => c.ok).length;
  const tasksDone = tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
  const reqCovered = requirements.filter((r) => r.covered).length;
  const checksRatio = ratio(checksGreen, checks.length);
  const tasksRatio = ratio(tasksDone, tasks.length);
  const reqRatio = ratio(reqCovered, requirements.length);
  const weighted =
    checks.length > 0 || tasks.length > 0 || requirements.length > 0
      ? checksRatio * 0.6 + tasksRatio * 0.3 + reqRatio * 0.1
      : 0;
  return {
    checksGreen,
    checksTotal: checks.length,
    tasksDone,
    tasksTotal: tasks.length,
    reqCovered,
    reqTotal: requirements.length,
    pct: Math.max(0, Math.min(100, Math.round(weighted * 100))),
    checksPct: Math.round(checksRatio * 100),
    tasksPct: Math.round(tasksRatio * 100),
    reqPct: Math.round(reqRatio * 100),
  };
}

function normalizeChecks(state) {
  const checks = Array.isArray(state?.last_checks) ? state.last_checks : [];
  return checks.map((c) => ({
    id: String(c?.id ?? "check"),
    ok: Boolean(c?.ok),
    summary: String(c?.summary ?? "").slice(0, 160),
    ms: Number(c?.ms) || 0,
    evidence: String(c?.evidence ?? ""),
  }));
}

function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((t, i) => ({
    id: Number(t?.id) || i + 1,
    subject: String(t?.subject ?? `Task ${i + 1}`).slice(0, 160),
    status: ["pending", "in_progress", "completed", "failed"].includes(t?.status)
      ? t.status
      : TASK_STATUS.PENDING,
    verify: String(t?.verify ?? ""),
    files: Array.isArray(t?.files) ? t.files : [],
    blocked_by: Array.isArray(t?.blocked_by) ? t.blocked_by : [],
  }));
}

function normalizeAgents(state, progress) {
  const out = [];
  const byID = new Map();
  const runs = Array.isArray(state?.agent_runs) ? state.agent_runs : [];
  for (const run of runs) {
    if (!run || run.status === "done" || run.status === "failed") continue;
    const entry = {
      sessionID: String(run.sessionID ?? ""),
      role: String(run.role ?? "agent"),
      taskId: Number(run.taskId) || 0,
      status: String(run.status ?? "running"),
      started_at: Number(run.started_at) || 0,
      last_heartbeat: Number(run.last_heartbeat) || 0,
      model: String(run.model ?? ""),
    };
    out.push(entry);
    byID.set(entry.sessionID, entry);
  }
  for (const p of Array.isArray(progress) ? progress : []) {
    if (!p || p.status !== TASK_STATUS.IN_PROGRESS) continue;
    const sid = String(p.owner ?? "");
    if (!sid || byID.has(sid)) continue;
    out.push({
      sessionID: sid,
      role: "worker",
      taskId: Number(p.id) || 0,
      status: "running",
      started_at: Number(p.lease_until || 0) - Number(state?.lease_ms || 300000),
      last_heartbeat: Number(p.last_heartbeat) || 0,
      model: "",
    });
  }
  return out.slice(0, 16);
}

export function normalizeRequirements(criteria, checks) {
  const raw = Array.isArray(criteria?.requirements) ? criteria.requirements : [];
  const byID = new Map(checks.map((c) => [c.id, c]));
  return raw.slice(0, 24).map((r, i) => {
    const ids = Array.isArray(r?.checks) ? r.checks.map(String) : [];
    const covered = ids.length > 0 && ids.every((id) => Boolean(byID.get(id)?.ok));
    return {
      id: String(r?.id ?? `req-${i + 1}`),
      text: String(r?.text ?? `Requirement ${i + 1}`).slice(0, 140),
      checks: ids,
      covered,
    };
  });
}

function objectiveOf(missionText) {
  return (
    (missionText ?? "")
      .replace(/^---[\s\S]*?---\r?\n/, "")
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "(no objective)"
  );
}

export async function loadMission(root) {
  const dir = path.join(root, ".mission");
  const [state, tasksData, progressData, criteria, missionText, journal, research] =
    await Promise.all([
      readJson(path.join(dir, "state.json"), {}),
      readJson(path.join(dir, "tasks.json"), {}),
      readJson(path.join(dir, "progress.json"), {}),
      readJson(path.join(dir, "criteria.json"), {}),
      readText(path.join(dir, "mission.md")),
      readJournalTail(root, JOURNAL_TAIL_CHARS),
      readText(path.join(root, "research", "report.md")),
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
  const progressMetrics = computeProgress(checks, tasks, requirements);
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
    turn_pct: maxTurns > 0 ? Math.round(ratio(turn, maxTurns) * 100) : 0,
    active: status === STATUS.RUNNING || status === STATUS.PAUSED,
    updatedAt: now,
  };
}

export async function loadTuiModel({ missionsRoot, maxMissions = 12 } = {}) {
  const pointer = await readPointer();
  const roots = await discoverRoots(missionsRoot, maxMissions);
  const snapshots = await Promise.all(roots.map((root) => loadMission(root).catch(() => null)));
  const missions = snapshots
    .filter(Boolean)
    .map((s) => ({
      root: s.root,
      id: s.id,
      objective: s.objective,
      status: s.status,
      pct: s.pct,
      statusColor: s.status,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => {
      const priority = (s) =>
        s.status === STATUS.RUNNING ? 2 : s.status === STATUS.PAUSED ? 1 : 0;
      return priority(b) - priority(a) || b.updatedAt - a.updatedAt;
    });
  const snapshot = pointer?.root
    ? (snapshots.find((s) => s && s.root === pointer.root) ?? missions[0] ?? null)
    : (missions.find((m) => m.status === STATUS.RUNNING) ?? missions[0] ?? null);
  return { snapshot, missions, updatedAt: Date.now() };
}
