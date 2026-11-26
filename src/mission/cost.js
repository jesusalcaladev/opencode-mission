// Pure cost helpers. OpenCode reports cost per assistant message; a mission can
// own many sessions (lead, implementers, roles, reviewers), so the durable total
// must be merged across all of them and must never go backwards.

export function costFromContext(messages = []) {
  if (!Array.isArray(messages)) return null;
  let total = 0;
  let seen = false;
  for (const item of messages) {
    const info = item?.info ?? item;
    if (info?.role === "assistant" && Number.isFinite(info.cost)) {
      total += info.cost;
      seen = true;
    }
  }
  return seen ? total : null;
}

/// Merge per-session costs: a session's total is monotonic, so the maximum wins.
export function mergeCosts(entries = []) {
  const byID = new Map();
  for (const entry of entries) {
    const id = entry?.sessionID;
    const cost = entry?.cost;
    if (typeof id !== "string" || !id || !Number.isFinite(cost) || cost < 0) continue;
    byID.set(id, Math.max(byID.get(id) ?? 0, cost));
  }
  let total = 0;
  for (const value of byID.values()) total += value;
  return total;
}

export function applyCost(state, observed) {
  const current = Number(state?.cost_usd) || 0;
  return Number.isFinite(observed) ? Math.max(current, observed) : current;
}

export function generationCost(out) {
  if (!out || typeof out !== "object") return 0;
  const value = out.cost ?? out.usage?.cost ?? out.data?.cost ?? out.data?.usage?.cost;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function sessionIDsForMission({
  leadID = "",
  boundIDs = [],
  workerSessions = [],
  agentRuns = [],
} = {}) {
  const ids = [
    leadID,
    ...(Array.isArray(boundIDs) ? boundIDs : []),
    ...(Array.isArray(workerSessions) ? workerSessions : []),
    ...(Array.isArray(agentRuns) ? agentRuns.map((r) => r?.sessionID) : []),
  ];
  return [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(0, 400);
}
