// Pure TUI normalization helpers. No IO, no OpenTUI, no Solid.
import { TASK_STATUS } from "../mission/state.js";

export const ratio = (a, b) => (b > 0 ? a / b : 0);
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

export function normalizeChecks(state) {
  const checks = Array.isArray(state?.last_checks) ? state.last_checks : [];
  return checks.map((c) => ({
    id: String(c?.id ?? "check"),
    ok: Boolean(c?.ok),
    summary: String(c?.summary ?? "").slice(0, 160),
    ms: Number(c?.ms) || 0,
    evidence: String(c?.evidence ?? ""),
  }));
}

export function normalizeTasks(tasks) {
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

export function normalizeAgents(state, progress) {
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

export function objectiveOf(missionText) {
  return (
    (missionText ?? "")
      .replace(/^---[\s\S]*?---\r?\n/, "")
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "(no objective)"
  );
}
