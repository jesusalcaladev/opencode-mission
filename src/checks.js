// Criteria runner: parallel execution, workspace fingerprint caching, evidence.
// The model's verdict is never trusted over a red check.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { missionDir, FILES } from "./mission.js";
import { sandboxMode, sanitizeEnv, isSandboxedPath } from "./mission/sandbox.js";
import { safeCheckCmd } from "./planner/prompt.js";

const MAX_OUTPUT = 64 * 1024;
const SKIP = new Set([
  ".git",
  ".mission",
  "node_modules",
  "zig-cache",
  ".zig-cache",
  "zig-out",
  "dist",
  "build",
]);

export function evaluateExpect(expect, { code, stdout }) {
  const spec = String(expect ?? "exit0");
  if (spec.startsWith("contains:") && spec.length > 9) {
    return code === 0 && stdout.includes(spec.slice(9));
  }
  return code === 0;
}

export function runCommand(cmd, cwd, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra, timedOut: code === 124 });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, "\n[timed out]");
    }, timeoutMs);
    const collect = (chunk, key) => {
      const text = chunk.toString("utf8");
      if (key === "stdout") stdout = (stdout + text).slice(0, MAX_OUTPUT);
      else stderr = (stderr + text).slice(0, MAX_OUTPUT);
    };
    child.stdout.on("data", (c) => collect(c, "stdout"));
    child.stderr.on("data", (c) => collect(c, "stderr"));
    child.on("error", (err) => finish(127, `\n${err.message}`));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/// A cheap fingerprint of the workspace: file paths + mtimes, ignoring build noise.
/// Used to skip criteria that cannot have changed since the last verified run.
export async function workspaceStamp(root) {
  const hash = createHash("sha256");
  let entries = [];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return "missing";
  }
  const files = entries
    .filter((e) => e.isFile() && !e.name.split(path.sep).some((part) => SKIP.has(part)))
    .map((e) => path.join(e.parentPath ?? root, e.name));
  files.sort();
  for (const file of files.slice(0, 20_000)) {
    try {
      const info = await stat(file);
      hash.update(path.relative(root, file));
      hash.update(String(info.mtimeMs));
      hash.update(String(info.size));
    } catch {
      // A file deleted during the scan is a change; the next stamp will differ.
    }
  }
  return hash.digest("hex");
}

export function criteriaSignature(checks) {
  return createHash("sha256")
    .update(JSON.stringify((checks ?? []).map((c) => [c.id, c.cmd, c.expect, c.timeout_ms])))
    .digest("hex");
}

/// Optional soft sandbox: run the command in a disposable workspace copy with
/// a minimal environment, so a criterion cannot mutate the real project or
/// read credentials. node_modules is symlinked to keep test runners working.
async function withSandbox(root, mode, fn) {
  if (mode !== "copy") return fn(root, process.env);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mission-check-"));
  try {
    await cp(root, tmp, {
      recursive: true,
      filter: (source) => !isSandboxedPath(path.relative(root, source)),
    });
    const modules = path.join(root, "node_modules");
    const isDir = await stat(modules)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (isDir) await symlink(modules, path.join(tmp, "node_modules"), "dir").catch(() => {});
    return await fn(tmp, sanitizeEnv(process.env, tmp));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runChecks(root, criteria, options = {}) {
  const checks = Array.isArray(criteria?.checks) ? criteria.checks : [];
  if (checks.length === 0) return [];
  const evidenceDir = path.join(missionDir(root), FILES.evidence);
  await mkdir(evidenceDir, { recursive: true });

  const stamp = options.stamp ?? (await workspaceStamp(root));
  const signature = criteriaSignature(checks);
  const cache = options.cache;
  if (
    cache &&
    cache.stamp === stamp &&
    cache.signature === signature &&
    Array.isArray(cache.results) &&
    cache.results.length === checks.length
  ) {
    return cache.results;
  }

  const limit = Math.max(1, options.maxParallel ?? 3);
  const results = new Array(checks.length);
  let next = 0;
  async function worker() {
    while (next < checks.length) {
      const index = next++;
      const check = checks[index];
      const started = Date.now();
      if (options.strict === true && !safeCheckCmd(check?.cmd)) {
        results[index] = {
          id: String(check?.id ?? index),
          ok: false,
          exit: 127,
          ms: 0,
          summary: "refused: unsafe or vacuous check command (strict_checks)",
          evidence: "",
          refused: true,
        };
        continue;
      }
      const attempts = Math.max(0, Math.min(2, Number(check.retries) || 0)) + 1;
      let run = null;
      let ok = false;
      const mode = sandboxMode({ sandbox: options.sandbox }, check);
      await withSandbox(root, mode, async (cwd, env) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          run = await runCommand(
            check.cmd,
            cwd,
            Number.isFinite(check.timeout_ms) ? check.timeout_ms : 30000,
            env
          );
          ok = evaluateExpect(check.expect, run);
          if (ok) break;
        }
      });
      const summary = (run.stdout.trim() || run.stderr.trim() || `exit ${run.code}`)
        .split("\n")[0]
        .slice(0, 200);
      const evidence = path.join(evidenceDir, `${check.id}.txt`);
      await writeFile(
        evidence,
        `[check] ${check.id}\n[cmd] ${check.cmd}\n[exit] ${run.code}\n[ms] ${Date.now() - started}\n[attempts] ${attempts}\n[expect] ${check.expect ?? "exit0"}\n[ok] ${ok}\n\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`,
        "utf8"
      );
      results[index] = {
        id: check.id,
        ok,
        exit: run.code,
        ms: Date.now() - started,
        summary,
        evidence: path.relative(root, evidence),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, checks.length) }, () => worker()));
  return results;
}
