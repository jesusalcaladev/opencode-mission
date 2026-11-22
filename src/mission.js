// Durable mission state and the compatibility facade for the pure modules.
// Pure decisions live in src/mission/{state,decide,memory,lease}.js; this file
// adds filesystem persistence and the v1 -> v2 migration.

import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";

import {
  VERSION,
  STATUS,
  TASK_STATUS,
  FILES,
  DEFAULT_MAX_TURNS,
  DEFAULT_BUDGET_USD,
  DEFAULT_STALL_AFTER_TURNS,
  initialState,
  parseFrontmatter,
  objectiveOf,
  normalizeTask,
} from "./mission/state.js";
import { selectTask, applyTaskResults, nextStrategy, decideNext } from "./mission/decide.js";
import { buildBrief, distill, MEMORY_BUDGET } from "./mission/memory.js";
import {
  migrateV1,
  fromTasks,
  toTasks,
  claim,
  renew,
  release,
  fail,
  expired,
  isLeased,
  retryable,
  LEASE_MS,
  MAX_ATTEMPTS,
} from "./mission/lease.js";

export {
  VERSION,
  STATUS,
  TASK_STATUS,
  FILES,
  DEFAULT_MAX_TURNS,
  DEFAULT_BUDGET_USD,
  DEFAULT_STALL_AFTER_TURNS,
  initialState,
  parseFrontmatter,
  objectiveOf,
  selectTask,
  applyTaskResults,
  nextStrategy,
  decideNext,
  buildBrief,
  distill,
  MEMORY_BUDGET,
  migrateV1,
  fromTasks,
  toTasks,
  claim,
  renew,
  release,
  fail,
  expired,
  isLeased,
  retryable,
  LEASE_MS,
  MAX_ATTEMPTS,
};

export function missionDir(root) {
  return path.join(root, FILES.dir);
}

export async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

const readText = (file, fallback = "") => readFile(file, "utf8").catch(() => fallback);

async function readList(file) {
  const data = await readJson(file, null);
  return Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
}

export async function ensureMission(root, options = {}) {
  const dir = missionDir(root);
  await mkdir(path.join(dir, FILES.evidence), { recursive: true });

  const missionPath = path.join(dir, FILES.mission);
  if (!(await fileExists(missionPath))) {
    const objective = options.objective ?? "Improve this workspace until all criteria pass.";
    await writeTextAtomic(
      missionPath,
      `---\nid: ${options.id ?? "mission"}\nmax_turns: ${options.maxTurns ?? DEFAULT_MAX_TURNS}\nbudget_usd: ${options.budgetUsd ?? DEFAULT_BUDGET_USD}\n---\n${objective}\n`,
    );
  }
  const criteriaPath = path.join(dir, FILES.criteria);
  if (!(await fileExists(criteriaPath))) {
    await writeJsonAtomic(criteriaPath, {
      version: VERSION,
      checks: [{ id: "build", cmd: "node --test", expect: "exit0", timeout_ms: 30000 }],
    });
  }
  const tasksPath = path.join(dir, FILES.tasks);
  if (!(await fileExists(tasksPath))) {
    await writeJsonAtomic(tasksPath, {
      version: VERSION,
      tasks: [{ id: 1, subject: "Make all checks green", status: TASK_STATUS.PENDING, blocked_by: [] }],
    });
  }
  const journalPath = path.join(dir, FILES.journal);
  if (!(await fileExists(journalPath))) await writeTextAtomic(journalPath, "# Journal\n\n");

  const statePath = path.join(dir, FILES.state);
  if (!(await fileExists(statePath))) await writeJsonAtomic(statePath, initialState());

  // v2 files. They are created only when absent so an existing mission is
  // migrated in place instead of having its evidence rewritten.
  const charterPath = path.join(dir, FILES.charter);
  if (!(await fileExists(charterPath))) {
    await writeTextAtomic(
      charterPath,
      `# Charter\n\nObjective: ${objectiveOf(await readText(missionPath))}\n\nCompletion is defined ONLY by criteria.json. All tasks must be verified by the harness.\n`,
    );
  }
  const memoryPath = path.join(dir, FILES.memory);
  if (!(await fileExists(memoryPath))) await writeTextAtomic(memoryPath, "");
  const summaryPath = path.join(dir, FILES.summary);
  if (!(await fileExists(summaryPath))) await writeTextAtomic(summaryPath, "");
  const progressPath = path.join(dir, FILES.progress);
  if (!(await fileExists(progressPath))) {
    const oldTasks = await readList(tasksPath);
    const oldState = await readJson(statePath, initialState());
    const progress = oldTasks.length ? migrateV1(oldTasks, oldState) : [];
    await writeJsonAtomic(progressPath, { version: VERSION, tasks: progress });
  }

  const state = await readJson(statePath, initialState());
  const meta = parseFrontmatter(await readText(missionPath));
  if (typeof meta.id === "string" && meta.id) state.id = meta.id;
  if (Number.isFinite(meta.max_turns)) state.max_turns = meta.max_turns;
  if (Number.isFinite(meta.budget_usd)) state.budget_usd = meta.budget_usd;
  if (Number.isFinite(meta.stall_after_turns)) state.stall_after_turns = meta.stall_after_turns;
  if (Number.isFinite(meta.max_failures)) state.max_failures = meta.max_failures;
  if (Number.isFinite(meta.handoff_every_turns)) state.handoff_every_turns = meta.handoff_every_turns;
  if (Number.isFinite(meta.max_wallclock_min)) state.max_wallclock_min = meta.max_wallclock_min;
  state.isolation = typeof meta.isolation === "string" ? meta.isolation : "none";
  await writeJsonAtomic(statePath, state);

  return {
    dir,
    missionPath,
    criteriaPath,
    tasksPath,
    journalPath,
    statePath,
    memoryPath,
    summaryPath,
    charterPath,
    progressPath,
    stopPath: path.join(dir, FILES.stop),
  };
}

export async function loadState(root) {
  return readJson(path.join(missionDir(root), FILES.state), initialState());
}
export async function saveState(root, state) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.state), state);
}
export async function loadCriteria(root) {
  const data = await readJson(path.join(missionDir(root), FILES.criteria), { checks: [] });
  return Array.isArray(data?.checks) ? data : { checks: [] };
}
export async function loadTasks(root) {
  const data = await readJson(path.join(missionDir(root), FILES.tasks), { tasks: [] });
  return Array.isArray(data?.tasks) ? data.tasks.map(normalizeTask) : [];
}
export async function saveTasks(root, tasks) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.tasks), { version: VERSION, tasks });
}
export async function loadProgress(root) {
  const data = await readJson(path.join(missionDir(root), FILES.progress), { tasks: [] });
  return Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
}
export async function saveProgress(root, tasks) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.progress), { version: VERSION, tasks });
}
export async function loadMemory(root) {
  return readText(path.join(missionDir(root), FILES.memory));
}
export async function saveMemory(root, text) {
  await writeTextAtomic(path.join(missionDir(root), FILES.memory), text);
}
export async function loadSummary(root) {
  return readText(path.join(missionDir(root), FILES.summary));
}
export async function saveSummary(root, text) {
  await writeTextAtomic(path.join(missionDir(root), FILES.summary), text);
}
export async function readJournalTail(root, maxChars = 3000) {
  const text = await readText(path.join(missionDir(root), FILES.journal));
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
export async function readJournal(root) {
  return readText(path.join(missionDir(root), FILES.journal));
}
export async function appendJournal(root, line) {
  const file = path.join(missionDir(root), FILES.journal);
  const stamp = new Date().toISOString().slice(0, 19);
  await writeTextAtomic(file, `${await readText(file, "# Journal\n\n")}[${stamp}] ${line}\n`);
}
export async function stopRequested(root) {
  return fileExists(path.join(missionDir(root), FILES.stop));
}
