// Pure decision layer. One place owns termination and task completion;
// the supervisor only feeds it evidence.

import { STATUS, TASK_STATUS } from "./state.js";

export function selectTask(tasks) {
  const open = tasks.filter((t) => t.status !== TASK_STATUS.COMPLETED);
  if (open.length === 0) return null;
  const ready = open.find((t) =>
    (t.blocked_by ?? []).every((id) => {
      const blocker = tasks.find((x) => x.id === id);
      return blocker && blocker.status === TASK_STATUS.COMPLETED;
    })
  );
  return ready ?? open[0];
}

export function applyTaskResults(tasks, results) {
  const out = tasks.map((t) => ({ ...t }));
  let changed = false;
  for (let pass = 0; pass < out.length + 1; pass += 1) {
    let changedThisPass = false;
    for (const task of out) {
      if (task.status === TASK_STATUS.COMPLETED) continue;
      if (task.verify) {
        const result = results.find((r) => r.id === task.verify);
        if (!result || !result.ok) continue;
      }
      const blocked = (task.blocked_by ?? []).some((id) => {
        const b = out.find((x) => x.id === id);
        return !b || b.status !== TASK_STATUS.COMPLETED;
      });
      if (blocked) continue;
      task.status = TASK_STATUS.COMPLETED;
      changed = true;
      changedThisPass = true;
    }
    if (!changedThisPass) break;
  }
  return { tasks: out, changed };
}

export function nextStrategy(tier, progressMade) {
  return progressMade ? Math.max(1, tier - 1) : Math.min(3, tier + 1);
}

export function allGreen(results) {
  return Array.isArray(results) && results.length > 0 && results.every((r) => Boolean(r.ok));
}

/// A requirement is covered only when every check it names is green.
/// An empty requirement is never implicitly covered.
export function requirementsMet(criteria, results) {
  const requirements = Array.isArray(criteria?.requirements) ? criteria.requirements : [];
  if (requirements.length === 0) return true;
  const byID = new Map((Array.isArray(results) ? results : []).map((r) => [r.id, Boolean(r.ok)]));
  return requirements.every((req) => {
    const ids = Array.isArray(req?.checks) ? req.checks.map(String) : [];
    return ids.length > 0 && ids.every((id) => byID.get(id) === true);
  });
}

export function decideNext({
  state,
  results,
  tasks,
  verdict,
  stopFile,
  pauseFile,
  criteria,
  now = Date.now(),
}) {
  if (stopFile) return { type: "stop", reason: "stop-file" };
  if (pauseFile) return { type: "stop", reason: "paused" };
  if (state.status !== STATUS.RUNNING) return { type: "stop", reason: "not-running" };
  if (
    Number.isFinite(state.hard_budget_usd) &&
    state.hard_budget_usd > 0 &&
    state.cost_usd >= state.hard_budget_usd
  ) {
    return { type: "stop", reason: "hard-budget" };
  }
  if (Number.isFinite(state.max_wallclock_min) && state.max_wallclock_min > 0 && state.started_at) {
    const deadline = Date.parse(state.started_at) + state.max_wallclock_min * 60_000;
    if (Number.isFinite(deadline) && now >= deadline) return { type: "stop", reason: "deadline" };
  }
  if (
    Number.isFinite(state.budget_usd) &&
    state.budget_usd > 0 &&
    state.cost_usd >= state.budget_usd
  ) {
    return { type: "stop", reason: "budget" };
  }
  if (state.turn >= state.max_turns) return { type: "stop", reason: "max-turns" };
  if (
    Number.isFinite(state.max_writes) &&
    state.max_writes > 0 &&
    (state.writes ?? 0) >= state.max_writes
  ) {
    return { type: "stop", reason: "write-ceiling" };
  }
  if (verdict?.status === "blocked")
    return { type: "stop", reason: "blocked", unblock: verdict.unblock ?? "" };
  const green = results.length > 0 && results.every((r) => r.ok);
  const requirementsOk = requirementsMet(criteria, results);
  if (green && requirementsOk && tasks.every((t) => t.status === TASK_STATUS.COMPLETED))
    return { type: "complete" };
  return { type: "continue", green, requirementsOk };
}
