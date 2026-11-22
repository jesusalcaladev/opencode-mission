// Watchdog: detects verified stagnation and builds a real re-plan request.
// A prompt tweak is not a strategy change. When the harness has seen no verified
// progress for STALL_TURNS turns it asks the model for a NEW plan and applies it.
// Pure: no IO, no model, no OpenCode.

export const STALL_TURNS = 2;

export function needsReplan(state) {
  if (!state || state.strategy_tier < 2) return false;
  if (state.last_replan_turn && state.turn - state.last_replan_turn < STALL_TURNS) return false;
  return state.turn - (state.last_progress_turn ?? 0) >= STALL_TURNS;
}

export function replanPrompt({ objective, memory = "", journalTail = "", results = [], tasks = [] }) {
  const failing = results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.summary ?? "failed"}`);
  const taskLines = tasks.map((t) => `#${t.id} ${t.subject} [${t.status}] verify=${t.verify}`);
  return [
    "You are re-planning a stalled autonomous mission. Produce a COMPLETELY NEW executable JSON plan.",
    "Do NOT repeat the failed approach. Change the decomposition, the command strategy, or both.",
    "Output ONLY one JSON object:",
    '{"objective":"...","checks":[{"id":"...","cmd":"...","expect":"exit0 | contains:text","timeout_ms":30000}],"tasks":[{"id":1,"subject":"...","files":["..."],"verify":"check_id","blocked_by":[]}]}',
    "",
    `Objective: ${objective}`,
    `Failing checks: ${failing.join("; ") || "none"}`,
    `Current tasks: ${taskLines.join(" | ") || "none"}`,
    `Durable memory: ${memory.slice(0, 2000) || "(empty)"}`,
    `Recent journal: ${journalTail.slice(0, 1500) || "(empty)"}`,
  ].join("\n");
}

export function afterReplan(state, turn) {
  return {
    ...state,
    strategy_tier: 1,
    last_progress_turn: turn,
    last_replan_turn: turn,
    failures: 0,
  };
}
