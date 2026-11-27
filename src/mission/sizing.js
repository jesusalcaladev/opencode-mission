// Pure mission sizing. A big objective must not be planned as two generic
// build checks and three tasks: the harness derives a target from the objective
// and from recon proposals, then the planner is repaired up to that target.

const BIG_WORDS =
  /\b(todo|completo|completa|entero|entera|mejora|mejorar|implementa|construye|plataforma|sistema|engine|application|app|server|api|framework|library|cli|dashboard|ui|dux|calidad|proyecto|producto)\b/i;

export const BIG_TARGETS = Object.freeze({
  minChecks: 15,
  minTasks: 20,
  targetChecks: 24,
  targetTasks: 32,
});
export const SMALL_TARGETS = Object.freeze({
  minChecks: 1,
  minTasks: 1,
  targetChecks: 8,
  targetTasks: 6,
});

export function objectiveWords(objective = "") {
  return String(objective ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Decide whether an objective deserves a large plan.
 * Explicit flags win; otherwise word count, broad-intent wording, and the
 * amount of evidence produced by recon are combined.
 */
export function isBigObjective({ objective = "", options = {}, proposals = {} } = {}) {
  if (options.big || options.bigMission || options.big === true) return true;
  if (options.big === false) return false;
  const words = objectiveWords(objective);
  const checks = Array.isArray(proposals.checks) ? proposals.checks.length : 0;
  const tasks = Array.isArray(proposals.tasks) ? proposals.tasks.length : 0;
  if (checks >= 8 || tasks >= 6) return true;
  if (words >= 24 && BIG_WORDS.test(objective)) return true;
  return words >= 14 && BIG_WORDS.test(objective) && /\b(y|and|con|para|de)\b/i.test(objective);
}

export function missionSizing(input = {}) {
  const big = isBigObjective(input);
  return { big, ...(big ? BIG_TARGETS : SMALL_TARGETS) };
}
