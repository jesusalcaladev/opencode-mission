// Criteria runner: executes the mission's checks with a timeout and writes evidence.
// This is the harness side of "done": the model's verdict is never trusted over a red check.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { missionDir, FILES } from "./mission.js";

const MAX_OUTPUT = 64 * 1024;

export function evaluateExpect(expect, { code, stdout }) {
  const spec = String(expect ?? "exit0");
  if (spec.startsWith("contains:")) {
    const needle = spec.slice("contains:".length);
    return code === 0 && stdout.includes(needle);
  }
  return code === 0;
}

export function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);

    const collect = (chunk, key) => {
      if (settled) return;
      const text = chunk.toString("utf8");
      if (key === "stdout") {
        stdout = (stdout + text).slice(0, MAX_OUTPUT);
      } else {
        stderr = (stderr + text).slice(0, MAX_OUTPUT);
      }
    };
    child.stdout.on("data", (c) => collect(c, "stdout"));
    child.stderr.on("data", (c) => collect(c, "stderr"));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
    });
  });
}

export async function runChecks(root, criteria) {
  const evidenceDir = path.join(missionDir(root), FILES.evidence);
  await mkdir(evidenceDir, { recursive: true });
  const checks = Array.isArray(criteria?.checks) ? criteria.checks : [];
  const results = [];

  for (const check of checks) {
    const timeoutMs = Number.isFinite(check.timeout_ms) ? check.timeout_ms : 30000;
    const started = Date.now();
    const run = await runCommand(check.cmd, root, timeoutMs);
    const ms = Date.now() - started;
    const ok = evaluateExpect(check.expect, run);
    const evidence = path.join(evidenceDir, `${check.id}.txt`);
    await writeFile(
      evidence,
      `[check] ${check.id}\n[cmd] ${check.cmd}\n[exit] ${run.code}\n[ms] ${ms}\n[expect] ${check.expect ?? "exit0"}\n[ok] ${ok}\n\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}\n`,
      "utf8",
    );
    const summary = (run.stdout.trim() || run.stderr.trim() || `exit ${run.code}`).split("\n")[0].slice(0, 200);
    results.push({
      id: check.id,
      ok,
      exit: run.code,
      ms,
      summary,
      evidence: path.relative(root, evidence),
    });
  }
  return results;
}
