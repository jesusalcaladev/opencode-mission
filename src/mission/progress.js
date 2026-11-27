// Single source of truth for mission progress. Shared by the supervisor (which
// persists the floor) and the TUI (which renders it), so the bar cannot disagree
// with the harness or jump backwards after a re-plan.

import { TASK_STATUS } from "./state.js";

export const ratio = (a, b) => (b > 0 ? a / b : 0);

export function isTaskVerified(task = {}, results = []) {
  if (task.status !== TASK_STATUS.COMPLETED) return false;
  if (!task.verify) return true;
  const check = results.find((r) => r?.id === task.verify);
  return Boolean(check?.ok);
}

export function computeProgress(checks = [], tasks = [], requirements = [], floor = 0) {
  const green = checks.filter((c) => c?.ok).length;
  const done = tasks.filter((t) => isTaskVerified(t, checks)).length;
  const covered = requirements.filter((r) => r?.covered).length;
  const checkRatio = ratio(green, checks.length);
  const taskRatio = ratio(done, tasks.length);
  const reqRatio = ratio(covered, requirements.length);
  const weighted =
    checks.length > 0 || tasks.length > 0 || requirements.length > 0
      ? checkRatio * 0.6 + taskRatio * 0.3 + reqRatio * 0.1
      : 0;
  const raw = Math.round(weighted * 100);
  const minimum = Math.max(0, Math.min(100, Number(floor) || 0));
  return {
    checksGreen: green,
    checksTotal: checks.length,
    tasksDone: done,
    tasksTotal: tasks.length,
    reqCovered: covered,
    reqTotal: requirements.length,
    checksPct: Math.round(checkRatio * 100),
    tasksPct: Math.round(taskRatio * 100),
    reqPct: Math.round(reqRatio * 100),
    raw_pct: raw,
    pct: Math.max(minimum, Math.min(100, raw)),
  };
}
