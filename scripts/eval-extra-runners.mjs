// Additional eval runners: disk context, host supervisor and model rotation.

import { execFile } from "node:child_process";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { Supervisor } from "../src/supervisor.js";
import {
  loadState,
  loadTasks,
  missionDir,
  saveProgress,
  saveState,
  scoreCase,
  writeTextAtomic,
} from "../src/mission.js";
import { exists, fakeCtx, prepareMission, rootDir } from "./eval-context.mjs";

export async function runContextCase(testCase, base) {
  const root = await prepareMission(base, testCase);
  const ctx = fakeCtx(base, testCase);
  const sup = new Supervisor(ctx, { enableWorkers: false, enableRoles: false });
  await sup.start("lead", root);
  const state = await loadState(root);
  const stored = testCase.policy?.state ?? {};
  Object.assign(state, stored);
  await saveState(root, state);
  if (testCase.policy?.progress) await saveProgress(root, testCase.policy.progress);
  await writeTextAtomic(
    path.join(missionDir(root), "memory.md"),
    String(stored.memoryText ?? "discarded approach: monolith")
  );
  const task = (await loadTasks(root))[0] ?? null;
  const brief = await sup.buildWorkerBrief(root, await loadState(root), task);
  const prompt = sup.d.workerPrompt({
    task,
    objective: String(testCase.objective ?? "eval"),
    workspace: root,
    progress: testCase.policy?.progress ?? [],
  });
  const markers = testCase.expectText ?? {};
  const actual = {
    status: "context",
    brief_has_facts: brief.includes(String(markers.facts ?? "does-not-exist")),
    brief_has_memory: brief.includes(String(markers.memory ?? "does-not-exist")),
    brief_has_verify: Boolean(task?.verify) && brief.includes(`Verify: ${task.verify}`),
    prompt_has_retry: /RETRY CONTEXT/.test(prompt),
    journal: brief,
    prompts: prompt,
  };
  const scored = scoreCase(testCase.expect ?? {}, actual);
  sup.dispose();
  return { id: testCase.id, ...scored, ...actual };
}

export async function runHostRestartCase(testCase, base) {
  const exec = promisify(execFile);
  const root = await prepareMission(base, testCase);
  const dir = path.join(root, ".mission");
  const wake = path.join(dir, "WAKE");
  await writeFile(wake, "eval\n", "utf8");
  const old = new Date(Date.now() - 600_000);
  await utimes(wake, old, old);
  if (testCase.policy?.stop) await writeFile(path.join(dir, "STOP"), "", "utf8");
  if (testCase.policy?.pause) await writeFile(path.join(dir, "PAUSE"), "", "utf8");
  if (testCase.policy?.seedRestart)
    await writeFile(
      path.join(dir, "host-restart.json"),
      JSON.stringify(testCase.policy.seedRestart),
      "utf8"
    );
  const script = path.join(rootDir, "scripts", "mission-host-supervisor.mjs");
  const { stdout } = await exec(process.execPath, [
    script,
    "--missions-root",
    base,
    "--command",
    testCase.command,
    "--max",
    String(testCase.max ?? 3),
    "--wake-age-ms",
    "1000",
    "--backoff-ms",
    "1000",
  ]);
  const report = JSON.parse(stdout.trim());
  const marker = path.join(root, "restarted.txt");
  const actual = {
    status: "host-restart",
    restart_marker: await exists(marker),
    restart_attempts:
      Number((await readJsonFile(path.join(dir, "host-restart.json")))?.attempts) || 0,
    restarts: Number(report.restarts) || 0,
    prompts: stdout,
  };
  const scored = scoreCase(testCase.expect ?? {}, actual);
  return { id: testCase.id, ...scored, ...actual };
}

export async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function runDoctorCase(testCase, base) {
  const exec = promisify(execFile);
  const root = await prepareMission(base, testCase);
  const script = path.join(rootDir, "scripts", "mission-doctor.mjs");
  const { stdout } = await exec(process.execPath, [script, "--json", root]);
  const report = JSON.parse(stdout.trim());
  const scored = scoreCase(testCase.expect ?? {}, {
    status: "doctor",
    doctor_ok: Array.isArray(report.problems) && report.problems.length === 0,
    prompts: stdout,
  });
  return {
    id: testCase.id,
    ...scored,
    status: "doctor",
    doctor_ok: scored.pass,
    problems: report.problems,
  };
}

export async function runRotationCase(testCase, base) {
  const ctx = fakeCtx(base, testCase);
  const sup = new Supervisor(ctx, { missionsRoot: base });
  await sup.rotateModel("lead", "quota 429 rate limit");
  const scored = scoreCase(testCase.expect ?? {}, {
    status: "rotation",
    switched_count: ctx.switched.length,
    model_id: String(ctx.switched[0]?.id ?? ""),
  });
  sup.dispose();
  return {
    id: testCase.id,
    ...scored,
    status: "rotation",
    switched_count: ctx.switched.length,
    model_id: String(ctx.switched[0]?.id ?? ""),
  };
}
