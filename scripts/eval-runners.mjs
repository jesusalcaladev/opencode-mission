// Eval runners: each mode drives the real Supervisor or an external helper.
// All IO is bounded to the temp directory created by runCase.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Supervisor } from "../src/supervisor.js";
import {
  loadState,
  loadTasks,
  missionDir,
  queueStats,
  saveState,
  scoreCase,
  writeTextAtomic,
} from "../src/mission.js";
import { exists, fakeCtx, prepareMission } from "./eval-context.mjs";
import {
  runContextCase,
  runDoctorCase,
  runHostRestartCase,
  runRotationCase,
} from "./eval-extra-runners.mjs";

export async function runMission(testCase, base, maxTurns) {
  const root = await prepareMission(base, testCase);
  const ctx = fakeCtx(base, testCase);
  const sup = new Supervisor(ctx, {
    missionsRoot: base,
    enableWorkers: testCase.settings?.enableWorkers !== false,
    enableRoles: testCase.settings?.enableRoles !== false,
    maxWorkers: testCase.settings?.maxWorkers ?? 3,
  });
  await sup.start("lead", root);
  if (testCase.policy?.verdict) {
    const seeded = await loadState(root);
    seeded.last_verdict = testCase.policy.verdict;
    await saveState(root, seeded);
  }
  if (testCase.mode !== "wake") {
    for (let i = 0; i < maxTurns + 2; i += 1) {
      if ((await loadState(root)).status !== "running") break;
      await sup.handleIdle("lead");
    }
  }
  if (testCase.mode === "wake") {
    await writeTextAtomic(path.join(missionDir(root), "WAKE"), "eval\n");
    const state = await loadState(root);
    state.last_prompt_at = Date.now() - 600_000;
    await saveState(root, state);
    sup.registry.push({ sessionID: "lead", root, updated_at: Date.now() });
    sup.bind("lead", root, true);
    await sup.wakeStalled();
  }
  const state = await loadState(root);
  const tasks = await loadTasks(root);
  const checks = Array.isArray(state.last_checks) ? state.last_checks : [];
  const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8").catch(() => "");
  const wakeExists = await exists(path.join(missionDir(root), "WAKE"));
  const globalExists = await exists(path.join(base, "GLOBAL_MEMORY.md"));
  const absentFile = testCase.policy?.expect_absent;
  const workspaceClean = absentFile ? !(await exists(path.join(root, absentFile))) : true;
  const costUsd = Number(state.cost_usd) || 0;
  const tokens = Number(state.tokens) || 0;
  const scored = scoreCase(testCase.expect ?? {}, {
    status: state.status,
    finish_reason: state.finish_reason ?? "",
    checks_green: checks.filter((c) => c.ok).length,
    checks_red: checks.filter((c) => !c.ok).length,
    checks_total: checks.length,
    tasks_done: tasks.filter((t) => t.status === "completed").length,
    tasks_pending: tasks.filter((t) => t.status !== "completed").length,
    turns: state.turn,
    review_attempts: state.review_attempts ?? 0,
    refused: checks.some((c) => c.refused === true),
    wake_exists: wakeExists,
    global_exists: globalExists,
    workspace_clean: workspaceClean,
    cost_usd: costUsd,
    tokens,
    journal,
    prompts: ctx.prompts.join("\n"),
  });
  sup.dispose();
  return {
    id: testCase.id,
    ...scored,
    status: state.status,
    finish_reason: state.finish_reason ?? "",
    checks_green: checks.filter((c) => c.ok).length,
    checks_red: checks.filter((c) => !c.ok).length,
    checks_total: checks.length,
    tasks_done: tasks.filter((t) => t.status === "completed").length,
    tasks_pending: tasks.filter((t) => t.status !== "completed").length,
    turns: state.turn,
    review_attempts: state.review_attempts ?? 0,
    refused: checks.some((c) => c.refused === true),
    wake_exists: wakeExists,
    global_exists: globalExists,
    workspace_clean: workspaceClean,
    cost_usd: costUsd,
    tokens,
  };
}

export async function runQueueCase(testCase, base) {
  const ctx = fakeCtx(base, testCase);
  const sup = new Supervisor(ctx, {
    missionsRoot: base,
    parallelSlots: testCase.options?.parallelSlots ?? 8,
    maxWorkers: testCase.options?.maxWorkers ?? 3,
  });
  for (const entry of testCase.queue ?? [])
    await sup.enqueueMission(entry.objective, entry.priority);
  await sup.runQueue();
  const stats = queueStats(await sup.loadQueue());
  const scored = scoreCase(testCase.expect ?? {}, {
    status: "queue",
    running: stats.running,
    pending: stats.pending,
    prompts: ctx.prompts.join("\n"),
  });
  sup.dispose();
  return {
    id: testCase.id,
    ...scored,
    status: "queue",
    running: stats.running,
    pending: stats.pending,
    finished: stats.done,
  };
}

export async function runCase(testCase, maxTurns = 24) {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-eval-"));
  const started = Date.now();
  try {
    const runners = {
      queue: () => runQueueCase(testCase, base),
      rotation: () => runRotationCase(testCase, base),
      "host-restart": () => runHostRestartCase(testCase, base),
      context: () => runContextCase(testCase, base),
      doctor: () => runDoctorCase(testCase, base),
      "retry-context": () => runContextCase(testCase, base),
      mission: () => runMission(testCase, base, maxTurns),
      wake: () => runMission(testCase, base, maxTurns),
    };
    const result = await (runners[testCase.mode] ?? runners.mission)();
    return { ...result, ms: Date.now() - started };
  } catch (err) {
    return {
      id: testCase.id,
      pass: false,
      reasons: [`runner error: ${err?.stack ?? String(err)}`],
      ms: Date.now() - started,
    };
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}
