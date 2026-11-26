// Optional soft sandbox for criteria commands. No external binaries required:
// each check runs in a disposable copy of the workspace with a minimal env.
// Default is "none" so existing trusted criteria keep working unchanged.

export const SANDBOX_MODES = ["none", "copy"];
export const SANDBOX_SKIP = [".git", ".mission", "node_modules", "dist", "build"];

export function sandboxMode(state = {}, check = null) {
  if (check && SANDBOX_MODES.includes(check.sandbox)) return check.sandbox;
  return state?.sandbox === "copy" ? "copy" : "none";
}

export function sanitizeEnv(env = {}, home = "") {
  const allow = ["PATH", "LANG", "LC_ALL", "TERM", "NODE_PATH"];
  const out = {};
  for (const key of allow) if (typeof env[key] === "string") out[key] = env[key];
  if (home) out.HOME = home;
  out.CI = "1";
  out.MISSION_SANDBOX = "1";
  return out;
}

export function isSandboxedPath(file = "") {
  const parts = String(file).split(/[\\/]/);
  return parts.some((part) => SANDBOX_SKIP.includes(part));
}
