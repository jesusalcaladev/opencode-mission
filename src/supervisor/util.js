// Shared constants and error formatting for the supervisor mixins.

export const REGISTRY_KEY = "mission:registry";
export const MAX_NUDGE = 4000;
export const AUTO_RESUME_AGE_MS = 30_000;

export function shortError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (err && typeof err === "object") {
    const message = err.message ?? err.error?.message ?? err.type ?? err.name;
    if (typeof message === "string" && message.length > 0) return message.slice(0, 300);
    try {
      return JSON.stringify(err).slice(0, 300);
    } catch {
      return "unknown error";
    }
  }
  return String(err);
}
