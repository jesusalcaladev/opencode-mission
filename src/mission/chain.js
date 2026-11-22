// Mission chaining — pure decisions for long unattended runs.
// A roadmap is a markdown checklist. When a mission finishes, the harness picks
// the next item and starts it with the previous mission's distilled memory.
// No IO, no model, no OpenCode here.

export const DEFAULT_MAX_EXTENSIONS = 3;
export const EXTEND_TURNS = 8;
export const EXTEND_MINUTES = 30;
export const EXTEND_WRITES = 50;
export const EXTEND_BUDGET_USD = 5;
export const CAMPAIGN_EXTEND_TURNS = 20;
export const CAMPAIGN_EXTEND_WRITES = 200;

export function parseRoadmap(text) {
  const items = [];
  let index = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const match = /^\s*-\s+\[([ xX])\]\s*(.+?)\s*$/.exec(raw);
    if (!match) continue;
    index += 1;
    const body = match[2];
    const idMatch = /^(?:id\s*:\s*([a-z0-9_-]+)\s*[|:-]\s*)?(.+)$/i.exec(body);
    items.push({
      id: idMatch?.[1] ?? `item-${index}`,
      title: (idMatch?.[2] ?? body).trim(),
      done: match[1].toLowerCase() === "x",
    });
  }
  return items;
}

export function nextItem(items) {
  return items.find((item) => !item.done) ?? null;
}

export function markItemDone(text, id) {
  const lines = String(text ?? "").split(/\r?\n/);
  let changed = false;
  const out = lines.map((line) => {
    if (changed) return line;
    const match = /^\s*-\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (!match || match[1].toLowerCase() === "x") return line;
    const itemId = parseRoadmap(line)[0]?.id;
    if (itemId !== id) return line;
    changed = true;
    return line.replace(/\[[ xX]\]/, "[x]");
  });
  return out.join("\n");
}

export const EXTENDABLE_REASONS = new Set(["budget", "max-turns", "write-ceiling", "deadline"]);

export function chainDecision({
  decision,
  extendRequested = false,
  extensions = 0,
  maxExtensions = DEFAULT_MAX_EXTENSIONS,
  next = null,
}) {
  if (decision?.type !== "stop") return { type: "work" };
  if (!EXTENDABLE_REASONS.has(decision.reason)) return { type: "stop", reason: decision.reason };
  if (extendRequested && extensions < maxExtensions) {
    return { type: "extend", reason: decision.reason };
  }
  if (next && decision.reason === "budget") {
    // A finished mission may start the next one even without an extension;
    // the caller decides which workspace owns the remaining budget.
    return { type: "stop", reason: decision.reason };
  }
  return { type: "stop", reason: decision.reason };
}

export function applyExtension(state, extension = {}) {
  return {
    ...state,
    extensions: (state.extensions ?? 0) + 1,
    max_turns: (state.max_turns ?? 16) + (extension.turns ?? EXTEND_TURNS),
    max_wallclock_min:
      (state.max_wallclock_min ?? 0) > 0
        ? state.max_wallclock_min + (extension.minutes ?? EXTEND_MINUTES)
        : 0,
    max_writes:
      (state.max_writes ?? 0) > 0 ? state.max_writes + (extension.writes ?? EXTEND_WRITES) : 0,
  };
}

const NEVER_EXTEND = new Set([
  "stop-file",
  "paused",
  "blocked",
  "hard-budget",
  "test-erosion",
  "review-high",
  "stalled",
  "not-running",
  "deadline",
]);

/// Campaign mode: a budget ceiling is a window, not a stop, as long as the
/// harness has seen verified progress recently and hard caps are not reached.
export function autoExtendDecision({ decision, state = {}, progress = false, now = Date.now() }) {
  if (decision?.type !== "stop") return { type: "work" };
  const reason = decision.reason ?? "";
  if (NEVER_EXTEND.has(reason)) return { type: "stop", reason };
  if (!EXTENDABLE_REASONS.has(reason)) return { type: "stop", reason };
  if (state.auto_extend !== true) return { type: "stop", reason };
  if ((state.extensions ?? 0) >= (state.max_extensions ?? DEFAULT_MAX_EXTENSIONS)) {
    return { type: "stop", reason: "extension-limit" };
  }
  const hardBudget = Number(state.hard_budget_usd) || 0;
  if (hardBudget > 0 && Number(state.cost_usd) >= hardBudget)
    return { type: "stop", reason: "hard-budget" };
  if (Number.isFinite(state.max_wallclock_min) && state.max_wallclock_min > 0 && state.started_at) {
    const deadline = Date.parse(state.started_at) + state.max_wallclock_min * 60_000;
    if (Number.isFinite(deadline) && now >= deadline) return { type: "stop", reason: "deadline" };
  }
  if (!progress) return { type: "stop", reason: "stalled" };
  return { type: "extend", reason };
}

export function applyAutoExtension(state) {
  const next = { ...state };
  next.extensions = (state.extensions ?? 0) + 1;
  next.max_turns =
    (state.max_turns ?? 16) + (Number(state.extension_turns) || CAMPAIGN_EXTEND_TURNS);
  if ((state.max_writes ?? 0) > 0) {
    next.max_writes = state.max_writes + (Number(state.extension_writes) || CAMPAIGN_EXTEND_WRITES);
  }
  const hardBudget = Number(state.hard_budget_usd) || 0;
  const budgetStep = Number(state.extension_budget_usd) || EXTEND_BUDGET_USD;
  const nextBudget = (Number(state.budget_usd) || 0) + budgetStep;
  next.budget_usd = hardBudget > 0 ? Math.min(nextBudget, hardBudget) : nextBudget;
  return next;
}
