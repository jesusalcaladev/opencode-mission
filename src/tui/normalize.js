// Pure TUI normalization helpers. No IO, no OpenTUI, no Solid.
import { TASK_STATUS } from "../mission/state.js";
import { computeProgress as sharedProgress, ratio } from "../mission/progress.js";

export { ratio };
export function computeProgress(checks, tasks, requirements, floor = 0, deploy = null) {
  return sharedProgress(checks, tasks, requirements, floor, deploy);
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

/// Tasks are split across two durable files: tasks.json owns the plan and
/// progress.json owns the lease (owner, attempts, start/finish timestamps,
/// status). The TUI used to read timings from tasks.json only, where they never
/// exist, so every task showed "attempts 0" and no duration even while workers
/// were running. Merge both views, with progress winning for lease state.
export function normalizeTasks(tasks, progress = []) {
  const leased = new Map((Array.isArray(progress) ? progress : []).map((p) => [Number(p?.id), p]));
  return (Array.isArray(tasks) ? tasks : []).map((t, i) => {
    const id = Number(t?.id) || i + 1;
    const lease = leased.get(id) ?? {};
    const status = ["pending", "in_progress", "completed", "failed"].includes(lease.status)
      ? lease.status
      : ["pending", "in_progress", "completed", "failed"].includes(t?.status)
        ? t.status
        : TASK_STATUS.PENDING;
    const started_at = Number(lease.started_at) || Number(t?.started_at) || 0;
    const finished_at = Number(lease.finished_at) || Number(t?.finished_at) || 0;
    return {
      id,
      subject: String(t?.subject ?? `Task ${i + 1}`).slice(0, 160),
      status,
      verify: String(t?.verify ?? ""),
      files: Array.isArray(t?.files) ? t.files : [],
      blocked_by: Array.isArray(t?.blocked_by) ? t.blocked_by : [],
      milestone: String(t?.milestone ?? ""),
      stage: String(t?.stage ?? t?.milestone ?? ""),
      attempts: Number(lease.attempts) || 0,
      owner: String(lease.owner ?? ""),
      last_error: String(lease.last_error ?? "").slice(0, 200),
      started_at,
      finished_at,
      duration_ms: finished_at > 0 && started_at > 0 ? finished_at - started_at : 0,
    };
  });
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
