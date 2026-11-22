// Durable filesystem layer for missions.
import { readFile, writeFile, mkdir, rename, access, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { FILES, VERSION, initialState, normalizeTask } from "./state.js";
import { metricsFromState } from "./metrics.js";

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

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  // A unique suffix is required: two writers can reach this function in the
  // same millisecond, and sharing a temp name makes one rename fail with
  // ENOENT after the other one has already moved the file away.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(file, value) {
  await writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(file, text) {
  await writeAtomic(file, text);
}

export const readText = (file, fallback = "") => readFile(file, "utf8").catch(() => fallback);

export async function readList(file) {
  const data = await readJson(file, null);
  return Array.isArray(data?.tasks) ? data.tasks : Array.isArray(data) ? data : [];
}

export async function loadState(root) {
  return readJson(path.join(missionDir(root), FILES.state), initialState());
}
export async function saveState(root, state) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.state), state);
}
export async function loadMetrics(root) {
  return metricsFromState(await readJson(path.join(missionDir(root), FILES.metrics), {}));
}
export async function saveMetrics(root, metrics) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.metrics), metricsFromState({ metrics }));
}

export async function loadCriteria(root) {
  const data = await readJson(path.join(missionDir(root), FILES.criteria), { checks: [] });
  return Array.isArray(data?.checks) ? data : { checks: [] };
}
export async function saveCriteria(root, criteria) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.criteria), criteria);
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
export async function stopRequested(root) {
  return fileExists(path.join(missionDir(root), FILES.stop));
}

export async function pauseRequested(root) {
  return fileExists(path.join(missionDir(root), FILES.pause));
}

export async function consumePause(root) {
  const file = path.join(missionDir(root), FILES.pause);
  if (!(await fileExists(file))) return false;
  await unlink(file);
  return true;
}
export async function loadRoadmap(root) {
  return readText(path.join(missionDir(root), FILES.roadmap));
}
export async function loadImprovements(root) {
  return readText(path.join(missionDir(root), FILES.improvements));
}
export async function saveImprovements(root, text) {
  await writeTextAtomic(path.join(missionDir(root), FILES.improvements), text);
}
export async function saveRoadmap(root, text) {
  await writeTextAtomic(path.join(missionDir(root), FILES.roadmap), text);
}
export async function extendRequested(root) {
  return fileExists(path.join(missionDir(root), FILES.extend));
}
export async function consumeExtend(root) {
  const file = path.join(missionDir(root), FILES.extend);
  if (!(await fileExists(file))) return false;
  await unlink(file);
  return true;
}
