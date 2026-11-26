// Persistent priority queue for parallel missions. Pure functions only; the
// supervisor owns IO and session creation.

export const QUEUE_FILE = "mission-queue.json";
export const DEFAULT_PRIORITY = 0;

export function enqueue(entries = [], objective, priority = DEFAULT_PRIORITY, ts = Date.now()) {
  const text = String(objective ?? "").trim();
  if (text.length < 3) return [...entries];
  const id = `${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const list = [...entries];
  list.push({
    id,
    objective: text.slice(0, 2000),
    priority: Number.isFinite(Number(priority)) ? Math.trunc(Number(priority)) : DEFAULT_PRIORITY,
    status: "pending",
    created_at: ts,
    sessionID: null,
    attempts: 0,
    last_error: "",
  });
  return sortQueue(list);
}

export function sortQueue(entries = []) {
  return [...entries].sort(
    (a, b) =>
      (Number(b?.priority) || 0) - (Number(a?.priority) || 0) ||
      (Number(a?.created_at) || 0) - (Number(b?.created_at) || 0)
  );
}

export function runningCount(entries = []) {
  return entries.filter((e) => e?.status === "running").length;
}

export function nextBatch(entries = [], slots = 1) {
  const free = Math.max(0, Math.trunc(Number(slots) || 0));
  if (free === 0) return [];
  return sortQueue(entries)
    .filter((e) => e?.status === "pending")
    .slice(0, free);
}

export function markRunning(entries = [], batch = [], sessionIDs = []) {
  const ids = new Set(batch.map((e) => e?.id));
  return entries.map((e, i) =>
    ids.has(e?.id)
      ? { ...e, status: "running", sessionID: sessionIDs[i] ?? e.sessionID ?? null }
      : e
  );
}

export function markFinished(entries = [], id, status = "done", error = "") {
  return entries.map((e) =>
    e?.id === id
      ? {
          ...e,
          status,
          sessionID: null,
          attempts: (Number(e.attempts) || 0) + (status === "pending" ? 0 : 1),
          last_error: status === "pending" ? String(error ?? "").slice(0, 300) : "",
        }
      : e
  );
}

export function requeueDead(entries = [], aliveIDs = []) {
  const alive = new Set(aliveIDs);
  return entries.map((e) =>
    e?.status === "running" && !alive.has(e.sessionID)
      ? { ...e, status: "pending", sessionID: null, last_error: "session gone" }
      : e
  );
}

export function queueStats(entries = []) {
  const out = { pending: 0, running: 0, done: 0, failed: 0, total: entries.length };
  for (const entry of entries)
    if (Object.prototype.hasOwnProperty.call(out, entry?.status)) out[entry.status] += 1;
  return out;
}
