// Quality guards that decide whether a green check actually proves work.

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
