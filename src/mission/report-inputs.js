// Durable inputs for the mission report, plus dependency diffing. Reading only:
// no mission file is modified here.

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  loadCriteria,
  loadImprovements,
  loadMemory,
  loadProgress,
  loadState,
  loadSummary,
  loadTasks,
  missionDir,
  readText,
} from "./persistence.js";
import { objectiveOf } from "./state.js";

/// `workspace` is where the code lives (it differs from `root` only for a
/// worktree-isolated mission); mission files always live under `root`.
export async function collectReportInputs(root, workspace = root) {
  const dir = missionDir(root);
  const [
    state,
    tasks,
    progress,
    criteria,
    missionText,
    memory,
    summary,
    improvements,
    research,
    blueprint,
  ] = await Promise.all([
    loadState(root),
    loadTasks(root),
    loadProgress(root),
    loadCriteria(root),
    readText(path.join(dir, "mission.md"), ""),
    loadMemory(root),
    loadSummary(root),
    loadImprovements(root),
    readText(path.join(root, "research", "report.md"), ""),
    readText(path.join(dir, "blueprint.md"), ""),
  ]);
  const discovery = await readdir(path.join(dir, "discovery"), { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
    )
    .catch(() => []);
  return {
    root,
    objective: objectiveOf(missionText),
    state,
    tasks,
    progress,
    criteria,
    memory,
    summary,
    improvements,
    research,
    blueprint,
    discovery,
    depsAfter: dependencySnapshot(await readText(path.join(workspace, "package.json"), "")),
    depsBefore:
      state.deps_baseline && typeof state.deps_baseline === "object" ? state.deps_baseline : null,
  };
}

export function dependencySnapshot(text) {
  if (!String(text ?? "").trim()) return null;
  try {
    const pkg = JSON.parse(String(text ?? ""));
    const out = {};
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, version] of Object.entries(pkg?.[key] ?? {}))
        out[name] = String(version).slice(0, 40);
    }
    return out;
  } catch {
    return null;
  }
}

export function diffDependencies(before = null, after = null) {
  if (!before) return { added: [], removed: [], changed: [] };
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, version] of Object.entries(after ?? {})) {
    if (!(name in before)) added.push(`${name}@${version}`);
    else if (before[name] !== version) changed.push(`${name} ${before[name]} → ${version}`);
  }
  for (const name of Object.keys(before ?? {})) if (!(name in (after ?? {}))) removed.push(name);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
