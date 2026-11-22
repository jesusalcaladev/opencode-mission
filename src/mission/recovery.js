// Pure recovery helpers: prompt deduplication, handoff lineage and stale cleanup.
// A crash or a duplicate event must never produce two prompts for one boundary.

export const LEDGER_LIMIT = 80;
export const DEDUPE_WINDOW_MS = 8000;

export function promptKey(kind, sessionID, extra = "") {
  return `${String(kind ?? "prompt")}:${String(sessionID ?? "")}:${String(extra ?? "")}`;
}

export function isDuplicatePrompt(state, key, now = Date.now(), windowMs = DEDUPE_WINDOW_MS) {
  const ledger = Array.isArray(state?.prompt_ledger) ? state.prompt_ledger : [];
  return ledger.some((entry) => entry?.key === key && now - Number(entry.at ?? 0) < windowMs);
}

export function recordPrompt(state, { key, kind, sessionID, extra = "" }, now = Date.now()) {
  const id = key ?? promptKey(kind, sessionID, extra);
  const ledger = Array.isArray(state?.prompt_ledger)
    ? state.prompt_ledger.slice(-(LEDGER_LIMIT - 1))
    : [];
  return [
    ...ledger,
    { key: id, kind: String(kind ?? "prompt"), sessionID: String(sessionID ?? ""), at: now },
  ];
}

export function recordHandoff(state, from, to, turn) {
  const handoffs = Array.isArray(state?.handoffs) ? state.handoffs.slice(-39) : [];
  return [
    ...handoffs,
    { from: String(from ?? ""), to: String(to ?? ""), turn: Number(turn) || 0, at: Date.now() },
  ];
}

export function recoverLeases(progress, now = Date.now()) {
  return (Array.isArray(progress) ? progress : []).map((p) => {
    const leaseUntil = Number(p?.lease_until) || 0;
    if (p?.status !== "in_progress" || leaseUntil <= now) return p;
    return {
      ...p,
      status: "in_progress",
      lease_until: leaseUntil,
      last_error: "lease survived restart; awaiting heartbeat",
    };
  });
}

export function pruneRegistry(entries, validRoots, limit = 30) {
  const roots = new Set(validRoots ?? []);
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry.root === "string" && roots.has(entry.root))
    .sort((a, b) => Number(b.updated_at) - Number(a.updated_at))
    .slice(0, limit);
}
