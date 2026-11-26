// Historical budget forecast from the mission's own durable telemetry.
// Conservative: no data means no prediction, never an optimistic guess.

export function forecastBudget(state = {}, now = Date.now()) {
  const turn = Math.max(0, Number(state.turn) || 0);
  const cost = Math.max(0, Number(state.cost_usd) || 0);
  const tokens = Math.max(0, Number(state.tokens) || 0);
  const maxTurns = Math.max(0, Number(state.max_turns) || 0);
  const started = Number(state.started_at ? Date.parse(state.started_at) : 0) || 0;
  const minutes = started > 0 && now > started ? (now - started) / 60_000 : 0;
  const remaining = maxTurns > 0 ? Math.max(0, maxTurns - turn) : 0;
  const perTurnCost = turn > 0 ? cost / turn : 0;
  const perTurnTokens = turn > 0 ? tokens / turn : 0;
  const history = Array.isArray(state.history) ? state.history.length : 0;
  return {
    per_turn_cost_usd: perTurnCost,
    per_turn_tokens: perTurnTokens,
    per_minute_cost_usd: minutes > 0 ? cost / minutes : 0,
    remaining_turns: maxTurns > 0 ? remaining : null,
    forecast_cost_usd: maxTurns > 0 ? cost + perTurnCost * remaining : 0,
    forecast_tokens: maxTurns > 0 ? tokens + perTurnTokens * remaining : 0,
    forecast_minutes:
      perTurnCost > 0 && minutes > 0 ? (remaining * minutes) / Math.max(1, turn) : 0,
    confidence: history >= 6 ? "medium" : history >= 2 ? "low" : "none",
    over_hard_budget:
      Number(state.hard_budget_usd) > 0 &&
      cost + perTurnCost * remaining > Number(state.hard_budget_usd),
    over_token_budget:
      Number(state.max_tokens) > 0 && tokens + perTurnTokens * remaining > Number(state.max_tokens),
  };
}
