// Monotonic re-plan rules, kept separate from plan normalization so both
// modules stay under the architecture size cap.

export function validateMonotonic(nextPlan, previousChecks = [], previousTasks = []) {
  const errors = [];
  const nextById = new Map((nextPlan?.checks ?? []).map((c) => [c.id, c]));
  for (const old of previousChecks) {
    const next = nextById.get(old.id);
    if (!next) {
      errors.push(`re-plan dropped existing check ${old.id}`);
      continue;
    }
    if ((old.cmd && next.cmd !== old.cmd) || (old.expect && next.expect !== old.expect))
      errors.push(`re-plan weakened existing check ${old.id}`);
  }
  const nextTasks = new Map((nextPlan?.tasks ?? []).map((t) => [t.id, t]));
  for (const old of previousTasks) {
    if (old.status !== "completed") continue;
    if (!nextTasks.has(old.id)) errors.push(`re-plan dropped completed task #${old.id}`);
  }
  return { ok: errors.length === 0, errors };
}
