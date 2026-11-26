// Deterministic fake OpenCode context + case execution for the eval CLI.
// No network, no paid models, no writes outside a temp directory.

import { access, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { Supervisor } from "../src/supervisor.js";
import {
  ensureMission,
  loadState,
  loadTasks,
  missionDir,
  queueStats,
  saveState,
  scoreCase,
  writeTextAtomic,
} from "../src/mission.js";

export const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function fakeCtx(base, testCase) {
  const store = new Map();
  const prompts = [];
  const created = [];
  const switched = [];
  let index = 0;
  let wrote = false;
  const policy = testCase.policy ?? {};
  const root = path.join(base, "mission");
  const writeFiles = async () => {
    if (wrote || !policy.write) return;
    wrote = true;
    for (const [file, content] of Object.entries(policy.write)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), String(content), "utf8");
    }
  };
  return {
    prompts,
    created,
    switched,
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => store.set(key, value),
    },
    session: {
      create: async () => {
        const id = `session-${index++}`;
        created.push(id);
        return { id };
      },
      prompt: async ({ text }) => {
        prompts.push(String(text));
        if (/\[MISSION (?:SUPERVISOR|WORKER|COORDINATOR)/.test(String(text))) await writeFiles();
      },
      context: async () => [
        { info: { role: "assistant", cost: 0.01, tokens: { input: 10, output: 5 } } },
      ],
      get: async ({ sessionID }) => ({
        id: sessionID,
        outcome: "complete",
        time: { idle: 10, busy: 0 },
      }),
      wait: async () => {},
      synthetic: async () => {},
      switchModel: async ({ model }) => switched.push(model),
    },
    model: {
      default: async () => null,
      list: async () => [
        { providerID: "eval", id: "free-1", cost: [{ output: 0 }] },
        { providerID: "eval", id: "free-2", cost: [{ output: 0 }] },
      ],
    },
    event: { subscribe: async function* () {} },
    location: { directory: root },
  };
}

async function prepareMission(base, testCase) {
  const root = path.join(base, "mission");
  if (testCase.fixture) {
    await cp(path.resolve(rootDir, testCase.fixture), root, { recursive: true });
  } else {
    await ensureMission(root, { objective: testCase.objective ?? testCase.id });
    await writeTextAtomic(
      path.join(missionDir(root), "criteria.json"),
      JSON.stringify({ version: 1, checks: testCase.criteria ?? [] })
    );
    await writeTextAtomic(
      path.join(missionDir(root), "tasks.json"),
      JSON.stringify({ version: 1, tasks: testCase.tasks ?? [] })
    );
    await writeTextAtomic(
      path.join(missionDir(root), "mission.md"),
      `---\n---\n${testCase.objective ?? testCase.id}\n`
    );
  }
  const state = await loadState(root);
  Object.assign(state, testCase.settings ?? {});
  state.last_prompt_at = Date.now() - 600_000;
  await saveState(root, state);
  return root;
}

async function runMission(testCase, base, maxTurns) {
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

async function runHostRestartCase(testCase, base) {
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
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
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

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function runRotationCase(testCase, base) {
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

async function runQueueCase(testCase, base) {
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
