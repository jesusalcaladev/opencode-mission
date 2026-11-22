// Mission workspace bootstrap.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as state from "./state.js";
const {
  FILES,
  VERSION,
  TASK_STATUS,
  initialState,
  parseFrontmatter,
  objectiveOf,
  DEFAULT_MAX_TURNS,
  DEFAULT_BUDGET_USD,
} = state;
import { migrateV1 } from "./lease.js";
import {
  missionDir,
  fileExists,
  readText,
  writeTextAtomic,
  writeJsonAtomic,
  readJson,
  readList,
} from "./persistence.js";

export async function ensureMission(root, options = {}) {
  const dir = missionDir(root);
  await mkdir(path.join(dir, FILES.evidence), { recursive: true });

  const missionPath = path.join(dir, FILES.mission);
  if (!(await fileExists(missionPath))) {
    const objective = options.objective ?? "Improve this workspace until all criteria pass.";
    await writeTextAtomic(
      missionPath,
      `---\nid: ${options.id ?? "mission"}\nmax_turns: ${options.maxTurns ?? DEFAULT_MAX_TURNS}\nbudget_usd: ${options.budgetUsd ?? DEFAULT_BUDGET_USD}\n---\n${objective}\n`
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
      tasks: [
        { id: 1, subject: "Make all checks green", status: TASK_STATUS.PENDING, blocked_by: [] },
      ],
    });
  }
  const journalPath = path.join(dir, FILES.journal);
  if (!(await fileExists(journalPath))) await writeTextAtomic(journalPath, "# Journal\n\n");
  const roadmapPath = path.join(dir, FILES.roadmap);
  if (!(await fileExists(roadmapPath))) await writeTextAtomic(roadmapPath, "# Roadmap\n\n");
  const improvementsPath = path.join(dir, FILES.improvements);
  if (!(await fileExists(improvementsPath)))
    await writeTextAtomic(improvementsPath, "# Improvements\n\n");

  const statePath = path.join(dir, FILES.state);
  if (!(await fileExists(statePath))) await writeJsonAtomic(statePath, initialState());

  // v2 files. They are created only when absent so an existing mission is
  // migrated in place instead of having its evidence rewritten.
  const charterPath = path.join(dir, FILES.charter);
  if (!(await fileExists(charterPath))) {
    await writeTextAtomic(
      charterPath,
      `# Charter\n\nObjective: ${objectiveOf(await readText(missionPath))}\n\nCompletion is defined ONLY by criteria.json. All tasks must be verified by the harness.\n`
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
  if (Number.isFinite(meta.handoff_every_turns))
    state.handoff_every_turns = meta.handoff_every_turns;
  if (Number.isFinite(meta.max_wallclock_min)) state.max_wallclock_min = meta.max_wallclock_min;
  if (Number.isFinite(meta.lease_ms) && meta.lease_ms >= 1000) state.lease_ms = meta.lease_ms;
  if (meta.continuous_improvement === true || meta.continuous_improvement === "true")
    state.continuous_improvement = true;
  if (meta.continuous_improvement === false || meta.continuous_improvement === "false")
    state.continuous_improvement = false;
  if (Number.isFinite(meta.max_improve_cycles)) state.max_improve_cycles = meta.max_improve_cycles;
  if (Number.isFinite(meta.max_clean_audit_rounds))
    state.max_clean_audit_rounds = meta.max_clean_audit_rounds;
  if (typeof meta.min_impact === "string") state.min_impact = meta.min_impact;
  const numericMeta = [
    "hard_budget_usd",
    "extension_turns",
    "extension_budget_usd",
    "extension_writes",
    "max_extensions",
    "goal_audits",
    "max_goal_audits",
    "worker_timeout_ms",
  ];
  for (const key of numericMeta) if (Number.isFinite(meta[key])) state[key] = meta[key];
  for (const key of ["auto_extend", "goal_audit", "needs_research", "research"]) {
    if (meta[key] === true || meta[key] === "true") state[key] = true;
    if (meta[key] === false || meta[key] === "false") state[key] = false;
  }
  state.isolation = typeof meta.isolation === "string" ? meta.isolation : "none";
  await writeJsonAtomic(statePath, state);

  return {
    dir,
    missionPath,
    roadmapPath,
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
