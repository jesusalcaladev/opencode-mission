// Token accounting for providers that do not report a dollar cost. `max_tokens`
// is a hard ceiling (like hard_budget_usd), never auto-extended.

export function tokensFromContext(messages = []) {
  if (!Array.isArray(messages)) return null;
  let input = 0;
  let output = 0;
  let seen = false;
  for (const item of messages) {
    const info = item?.info ?? item;
    if (info?.role !== "assistant") continue;
    const usage = info.tokens ?? info.usage?.tokens ?? info.usage;
    if (!usage) continue;
    const i = Number(usage.input ?? usage.inputTokens ?? usage.prompt ?? 0);
    const o = Number(usage.output ?? usage.outputTokens ?? usage.completion ?? 0);
    if (Number.isFinite(i) || Number.isFinite(o)) {
      input += Number.isFinite(i) ? i : 0;
      output += Number.isFinite(o) ? o : 0;
      seen = true;
    }
  }
  return seen ? { input, output, total: input + output } : null;
}

export function applyTokens(state, observed) {
  const current = Number(state?.tokens) || 0;
  if (!observed || !Number.isFinite(observed.total)) return current;
  return Math.max(current, observed.total);
}

export function mergeTokenEntries(entries = []) {
  let total = 0;
  for (const entry of entries) {
    const value = Number(entry?.tokens);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}
