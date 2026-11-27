// Quality guards that decide whether a green check actually proves work.

/// A "done" report is credible when its own check is green AND either the
/// check transitioned from red or the worker actually wrote files. This stops
/// a pre-existing green suite from being claimed as completed work.
export function credibleReport({
  status = "done",
  verify = "",
  check = null,
  baseline = {},
  writes = 0,
} = {}) {
  if (status !== "done") return true;
  if (!verify) return true;
  if (!check?.ok) return false;
  const wasGreenFromStart = Object.prototype.hasOwnProperty.call(baseline ?? {}, verify)
    ? baseline[verify] === true
    : true;
  return !(wasGreenFromStart && (Number(writes) || 0) === 0);
}

export function mutationSettings(state = {}) {
  if (state.mutation_checks === false) return false;
  return state.mutation_checks === true || state.never_give_up === true;
}

/// A check is vacuous when it stays green after the task's owned files are
/// removed. Standard missions skip this; relentless missions enable it by
/// default because they promise verified work, not just a green command.
export function mutationDecision({ mutatedOk = false, files = [], enabled = true } = {}) {
  if (!enabled || !Array.isArray(files) || files.length === 0)
    return { ok: true, reason: "skipped" };
  if (mutatedOk === true) return { ok: false, reason: "vacuous-check" };
  return { ok: true, reason: "check-fails-without-implementation" };
}
