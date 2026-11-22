// Pure mission state machine and durable state helpers.
// No OpenCode imports here: everything in this file is testable with node --test.

import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";

export const VERSION = 1;
export const STATUS = Object.freeze({
  RUNNING: "running",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  ABORTED: "aborted",
});

export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_BUDGET_USD = 5;
export const DEFAULT_STALL_AFTER_TURNS = 2;

export const FILES = Object.freeze({
  dir: ".mission",
  mission: "mission.md",
  criteria: "criteria.json",
  tasks: "tasks.json",
  state: "state.json",
  journal: "journal.md",
  stop: "STOP",
  evidence: "evidence",
});

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

function initialState() {
  return {
    version: VERSION,
    status: STATUS.RUNNING,
    turn: 0,
    cost_usd: 0,
    max_turns: DEFAULT_MAX_TURNS,
    budget_usd: DEFAULT_BUDGET_USD,
    stall_after_turns: DEFAULT_STALL_AFTER_TURNS,
    best_green: 0,
    last_progress_turn: 0,
    strategy_tier: 1,
    last_verdict: null,
    last_checks: [],
    session_id: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    finish_reason: null,
    failures: 0,
    max_failures: 3,
    handoff_every_turns: 0,
    last_handoff_turn: 0,
    max_wallclock_min: 0,
    last_prompt_at: 0,
    test_hashes: null,
    last_commit: null,
    worktree_root: "",
    worktree_branch: "",
    history: [],
  };
}

function parseFrontmatter(text) {
  const out = {};
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!match) return out;
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

export function objectiveOf(missionText) {
  return (missionText ?? "")
    .replace(/^---[\s\S]*?---\r?\n/, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)?.trim() ?? "(no objective)";
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
      tasks: [{ id: 1, subject: "Make all checks green", status: "pending", blocked_by: [] }],
    });
  }
  const journalPath = path.join(dir, FILES.journal);
  if (!(await fileExists(journalPath))) {
    await writeTextAtomic(journalPath, `# Journal\n\n`);
  }
  const statePath = path.join(dir, FILES.state);
  if (!(await fileExists(statePath))) {
    await writeJsonAtomic(statePath, initialState());
  }

  const state = await readJson(statePath, initialState());
  const meta = parseFrontmatter(await readFile(missionPath, "utf8"));
  if (typeof meta.id === "string" && meta.id) state.id = meta.id;
  if (Number.isFinite(meta.max_turns)) state.max_turns = meta.max_turns;
  if (Number.isFinite(meta.budget_usd)) state.budget_usd = meta.budget_usd;
  if (Number.isFinite(meta.stall_after_turns)) state.stall_after_turns = meta.stall_after_turns;
  if (Number.isFinite(meta.max_failures)) state.max_failures = meta.max_failures;
  if (Number.isFinite(meta.handoff_every_turns)) state.handoff_every_turns = meta.handoff_every_turns;
  if (Number.isFinite(meta.max_wallclock_min)) state.max_wallclock_min = meta.max_wallclock_min;
  state.isolation = typeof meta.isolation === "string" ? meta.isolation : "none";
  await writeJsonAtomic(statePath, state);

  return { dir, missionPath, criteriaPath, tasksPath, journalPath, statePath, stopPath: path.join(dir, FILES.stop) };
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
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

export async function saveTasks(root, tasks) {
  await writeJsonAtomic(path.join(missionDir(root), FILES.tasks), { version: VERSION, tasks });
}

export async function readJournalTail(root, maxChars = 3000) {
  const text = await readFile(path.join(missionDir(root), FILES.journal), "utf8").catch(() => "");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export async function appendJournal(root, line) {
  const file = path.join(missionDir(root), FILES.journal);
  const stamp = new Date().toISOString().slice(0, 19);
  await writeTextAtomic(file, `${await readFile(file, "utf8").catch(() => "# Journal\n\n")}[${stamp}] ${line}\n`);
}

export async function stopRequested(root) {
  return fileExists(path.join(missionDir(root), FILES.stop));
}

// A task is ready when every id in blocked_by is already completed.
export function selectTask(tasks) {
  const open = tasks.filter((t) => t.status !== "completed");
  if (open.length === 0) return null;
  const ready = open.find((t) =>
    (t.blocked_by ?? []).every((id) => {
      const blocker = tasks.find((x) => x.id === id);
      return blocker && blocker.status === "completed";
    }),
  );
  return ready ?? open[0];
}

// Tasks with a `verify` check id are completed by the HARNESS when that check is green.
// Iterate to a fixed point so chains (1 -> 2 -> 3) settle in one pass.
export function applyTaskResults(tasks, results) {
  const out = tasks.map((t) => ({ ...t }));
  let changed = false;
  for (let pass = 0; pass < out.length + 1; pass += 1) {
    let changedThisPass = false;
    for (const task of out) {
      if (task.status === "completed") continue;
      if (task.verify) {
        const result = results.find((r) => r.id === task.verify);
        if (!result || !result.ok) continue;
      }
      const blocked = (task.blocked_by ?? []).some((id) => {
        const b = out.find((x) => x.id === id);
        return !b || b.status !== "completed";
      });
      if (blocked) continue;
      task.status = "completed";
      changed = true;
      changedThisPass = true;
    }
    if (!changedThisPass) break;
  }
  return { tasks: out, changed };
}

export function nextStrategy(tier, progressMade) {
  return progressMade ? Math.max(1, tier - 1) : Math.min(3, tier + 1);
}

// THE RULE. The harness decides termination; the model only supplies a verdict.
export function decideNext({ state, results, tasks, verdict, stopFile, now = Date.now() }) {
  if (stopFile) return { type: "stop", reason: "stop-file" };
  if (state.status !== STATUS.RUNNING) return { type: "stop", reason: "not-running" };
  if (Number.isFinite(state.max_wallclock_min) && state.max_wallclock_min > 0 && state.started_at) {
    const deadline = Date.parse(state.started_at) + state.max_wallclock_min * 60_000;
    if (Number.isFinite(deadline) && now >= deadline) return { type: "stop", reason: "deadline" };
  }
  if (Number.isFinite(state.budget_usd) && state.budget_usd > 0 && state.cost_usd >= state.budget_usd) {
    return { type: "stop", reason: "budget" };
  }
  if (state.turn >= state.max_turns) return { type: "stop", reason: "max-turns" };
  if (verdict?.status === "blocked") {
    return { type: "stop", reason: "blocked", unblock: verdict.unblock ?? "" };
  }
  const green = results.length > 0 && results.every((r) => r.ok);
  if (green && tasks.every((t) => t.status === "completed")) return { type: "complete" };
  return { type: "continue", green };
}

export function buildBrief({ root, missionText, state, tasks, journal, results }) {
  const task = selectTask(tasks);
  const green = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.summary ?? "failed"}`);
  const lines = [
    "MISSION BRIEF (harness-owned — this text is not a suggestion from the model)",
    `Id: ${state.id ?? "mission"}`,
    `Objective: ${objectiveOf(missionText)}`,
    `Workspace: ${root}`,
    "",
    "RULES",
    "1. Use mission_write to create or edit files; use your read/glob tools to inspect.",
    "2. Call mission_check after every change. It runs the real criteria and returns per-check results.",
    '3. Call mission_verdict(status="met", summary=...) ONLY after mission_check reports every check green. A red check always beats your verdict.',
    '4. If the mission is genuinely impossible, call mission_verdict(status="blocked", summary=..., what_would_unblock=...). This stops the mission.',
    "5. Do not stop after writing files. Keep working until the checks are green.",
    "",
    `Next task: ${task ? `#${task.id} ${task.subject}` : "none — all tasks complete"}`,
    `Checks: ${green}/${results.length} green${failed.length ? ` · failing: ${failed.join("; ")}` : ""}`,
    `Turn ${state.turn}/${state.max_turns} · cost $${state.cost_usd.toFixed(2)}/$${state.budget_usd.toFixed(2)} · strategy tier ${state.strategy_tier}`,
    "",
    "JOURNAL (tail)",
    journal.trim() || "(empty)",
  ];
  return lines.join("\n");
}
