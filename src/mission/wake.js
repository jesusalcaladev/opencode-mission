// External watchdog contract: a helper process only writes .mission/WAKE.
// The in-process supervisor is the only component that prompts the session.

export const WAKE_FILE = "WAKE";
export const WAKE_AGE_MS = 180_000;

export function needsWake(state, now = Date.now(), ageMs = WAKE_AGE_MS) {
  if (!state || state.status !== "running") return false;
  const last = Number(state.last_prompt_at);
  if (!Number.isFinite(last)) return true;
  return now - last >= Math.max(1000, ageMs);
}
