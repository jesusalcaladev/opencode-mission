#!/usr/bin/env node
// Read-only diagnostics for a mission workspace. Never modifies state.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadCriteria,
  loadProgress,
  loadState,
  loadTasks,
  missionDir,
  queueStats,
  stateProblems,
} from "../src/mission.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? process.cwd());

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const [state, tasks, progress, criteria, queue, hostRestart] = await Promise.all([
  loadState(root),
  loadTasks(root),
  loadProgress(root),
  loadCriteria(root),
  (async () => {
    for (const file of [
      path.join(root, "mission-queue.json"),
      path.join(path.dirname(root), "mission-queue.json"),
    ]) {
      const data = await readJson(file, null);
      if (Array.isArray(data)) return data;
    }
    return [];
  })(),
  readJson(path.join(missionDir(root), "host-restart.json"), {}),
]);

const now = Date.now();
const checks = Array.isArray(state.last_checks) ? state.last_checks : [];
const green = checks.filter((c) => c?.ok).length;
const stale = progress.filter(
  (p) => p?.status === "in_progress" && p.lease_until > 0 && p.lease_until <= now
);
const failed = progress.filter((p) => p?.status === "failed");
const queueData = Array.isArray(queue) ? queue : [];
const report = {
  root,
  status: state.status,
  finish_reason: state.finish_reason ?? "",
  turn: `${state.turn}/${state.max_turns}`,
  budget_usd: state.cost_usd,
  tokens: state.tokens,
  hard_budget_usd: state.hard_budget_usd,
  max_tokens: state.max_tokens,
  checks: `${green}/${checks.length} green`,
  tasks: `${tasks.length - tasks.filter((t) => t?.status !== "completed").length}/${tasks.length} done`,
  stale_leases: stale.map((p) => p.id),
  failed_tasks: failed.map((p) => p.id),
  strategy_tier: state.strategy_tier,
  extensions: `${state.extensions}/${state.max_extensions}`,
  review_attempts: state.review_attempts,
  baseline_checks: Object.keys(state.check_baseline ?? {}).length,
  declared_checks: (criteria.checks ?? []).length,
  queue: queueStats(queueData),
  host_restarts: Number(hostRestart?.attempts) || 0,
  problems: stateProblems(
    await readJson(path.join(missionDir(root), "state.json"), state).catch(() => state)
  ),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `MISSION DOCTOR · ${report.root}`,
    `status: ${report.status}${report.finish_reason ? ` (${report.finish_reason})` : ""}`,
    `turn: ${report.turn} · budget: $${report.budget_usd} · tokens: ${report.tokens}`,
    `checks: ${report.checks} · tasks: ${report.tasks} · baseline: ${report.baseline_checks}/${report.declared_checks}`,
    `tier: ${report.strategy_tier} · extensions: ${report.extensions} · reviews: ${report.review_attempts}`,
    `stale leases: ${report.stale_leases.join(",") || "none"} · failed tasks: ${report.failed_tasks.join(",") || "none"}`,
    `queue: ${report.queue.pending} pending / ${report.queue.running} running · host restarts: ${report.host_restarts}`,
    `problems: ${report.problems.length ? report.problems.join("; ") : "none"}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
