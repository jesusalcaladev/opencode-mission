// End-of-mission report: what was done, how it was proven, what was used and
// what is left. `collectReportInputs` (report-inputs.js) reads durable files;
// this builder is pure, so `npm run report` can regenerate the same document.

import { diffDependencies } from "./report-inputs.js";
import { isTaskVerified } from "./progress.js";

export { collectReportInputs, dependencySnapshot, diffDependencies } from "./report-inputs.js";

export const REPORT_FILE = "MISSION_REPORT.md";

const clip = (value, max) => {
  const text = String(value ?? "").trim();
  const cap = Math.max(0, Number(max) || 0);
  return text.length > cap ? `${text.slice(0, Math.max(0, cap - 1))}…` : text;
};
const cell = (value, max = 80) =>
  clip(String(value ?? "").replace(/\r?\n/g, " "), max).replace(/\|/g, "\\|");
const ms = (value) => {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1000) return `${n}ms`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const money = (n) => `$${Math.max(0, Number(n) || 0).toFixed(2)}`;

export function buildMissionReport(input = {}) {
  const {
    root = "",
    objective = "(no objective)",
    state = {},
    tasks = [],
    progress = [],
    criteria = {},
    memory = "",
    summary = "",
    improvements = "",
    research = "",
    blueprint = "",
    discovery = [],
    git = {},
    depsBefore = null,
    depsAfter = {},
  } = input;

  const checks = Array.isArray(state.last_checks) ? state.last_checks : [];
  const commands = new Map((criteria?.checks ?? []).map((check) => [check.id, check]));
  const green = checks.filter((check) => check.ok).length;
  const leases = new Map((progress ?? []).map((entry) => [Number(entry?.id), entry]));
  const done = tasks.filter((task) => isTaskVerified(task, checks)).length;
  const requirements = Array.isArray(criteria?.requirements) ? criteria.requirements : [];
  const covered = requirements.filter((req) => {
    const ids = (req?.checks ?? []).map(String);
    return (
      ids.length > 0 && ids.every((id) => checks.find((check) => check.id === id)?.ok === true)
    );
  }).length;
  const started = state.started_at ? Date.parse(state.started_at) : 0;
  const finished = state.finished_at ? Date.parse(state.finished_at) : 0;
  const duration = started && finished ? finished - started : 0;
  const deps = diffDependencies(depsBefore, depsAfter);
  const lines = [];

  lines.push(`# Mission report — ${clip(objective, 90)}`);
  lines.push("");
  lines.push(
    `- **Status:** ${state.status ?? "unknown"}${state.finish_reason ? ` (${state.finish_reason})` : ""}`
  );
  lines.push(`- **Workspace:** ${root}`);
  lines.push(
    `- **Run:** ${duration ? ms(duration) : "unknown"} · ${Number(state.turn) || 0} turns · ${money(state.cost_usd)} of ${money(state.budget_usd)} · ${Number(state.tokens) || 0} tokens`
  );
  lines.push(
    `- **Result:** ${green}/${checks.length} checks green · ${done}/${tasks.length} tasks verified · ${covered}/${requirements.length} requirements covered`
  );
  lines.push(
    `- **Autonomy:** ${state.autonomy ?? "standard"}${state.never_give_up ? " (never give up)" : ""} · stage ${state.phase ?? state.stage ?? "—"} · strategy tier ${state.strategy_tier ?? 1}`
  );
  if (git?.head) lines.push(`- **Commit:** ${git.head}${git.branch ? ` on ${git.branch}` : ""}`);
  lines.push("");

  lines.push("## What was done");
  if (tasks.length === 0) lines.push("No tasks were recorded.");
  else {
    lines.push("| # | Stage | Status | Attempts | Time | Task |");
    lines.push("| - | ----- | ------ | -------- | ---- | ---- |");
    for (const task of tasks.slice(0, 60)) {
      const lease = leases.get(Number(task.id)) ?? {};
      const time =
        Number(lease.finished_at) > 0 && Number(lease.started_at) > 0
          ? ms(Number(lease.finished_at) - Number(lease.started_at))
          : "—";
      lines.push(
        `| ${task.id} | ${cell(task.stage || task.milestone || "—", 14)} | ${cell(task.status, 12)} | ${Number(lease.attempts) || 0} | ${time} | ${cell(task.subject, 70)} |`
      );
    }
    if (tasks.length > 60) lines.push(`| … | | | | | ${tasks.length - 60} more tasks |`);
  }
  lines.push("");

  lines.push("## How it was verified");
  lines.push(
    "The harness re-ran every criterion itself; a model verdict was never accepted over a red check."
  );
  if (checks.length === 0) lines.push("No check results were recorded.");
  else {
    lines.push("| Check | Result | Time | Command |");
    lines.push("| ----- | ------ | ---- | ------- |");
    for (const check of checks.slice(0, 30)) {
      const command = commands.get(check.id);
      lines.push(
        `| ${cell(check.id, 24)} | ${check.ok ? "green" : "red"} | ${ms(check.ms)} | \`${cell(command?.cmd ?? "—", 90)}\` |`
      );
    }
  }
  if (requirements.length > 0) {
    lines.push("");
    lines.push("Requirements:");
    for (const req of requirements.slice(0, 20)) {
      const ok = (req.checks ?? []).every((id) => checks.find((c) => c.id === id)?.ok === true);
      lines.push(
        `- ${ok ? "[x]" : "[ ]"} ${cell(req.text || req.id, 120)} (${(req.checks ?? []).join(", ")})`
      );
    }
  }
  lines.push("");

  lines.push("## Deployment");
  if (state.sizing?.big)
    lines.push(
      `- **Plan target:** ${state.sizing.minChecks}-${state.sizing.targetChecks} checks · ${state.sizing.minTasks}-${state.sizing.targetTasks} tasks (large mission)`
    );
  const deploy = state.deploy ?? {};
  lines.push(
    `- **Verified:** ${deploy.verified === true ? "yes" : "no"}${deploy.lastCommit?.sha ? ` · checkpoint ${deploy.lastCommit.sha}` : ""}`
  );
  const commits = Object.entries(deploy.commits ?? {});
  if (commits.length) {
    lines.push("- **Task checkpoints:**");
    for (const [id, info] of commits.slice(0, 40))
      lines.push(`  - #${id} ${info?.sha || info?.reason || "—"}`);
  }
  lines.push("");

  lines.push("## Engineering loop");
  lines.push(
    `- Recon agents: ${state.recon_agents ?? discovery.length} (${discovery.join(", ") || "none recorded"})`
  );
  if (blueprint) {
    const firstLine = blueprint
      .split(/\r?\n/)
      .find((line) => line.trim() && !line.startsWith("```"));
    lines.push(`- Blueprint: \`.mission/blueprint.md\` — ${cell(firstLine ?? "", 120)}`);
  } else lines.push("- Blueprint: none (single-pass plan)");
  const runs = Array.isArray(state.agent_runs) ? state.agent_runs : [];
  if (runs.length > 0) {
    const roles = new Map();
    for (const run of runs) {
      const key = String(run?.role ?? "agent");
      const entry = roles.get(key) ?? { count: 0 };
      entry.count += 1;
      roles.set(key, entry);
    }
    lines.push(
      `- Agents: ${[...roles.entries()].map(([role, entry]) => `${role}×${entry.count}`).join(", ")}`
    );
  }
  if (state.metrics && typeof state.metrics === "object") {
    const m = state.metrics;
    lines.push(
      `- Effort: ${m.turns ?? 0} turns · ${m.checksRun ?? 0} check runs · ${m.agentsSpawned ?? 0} agents spawned · ${m.reviews ?? 0} reviews · ${m.improvements ?? 0} improvements · ${m.replans ?? 0} re-plans`
    );
  }
  if (summary) lines.push(`- Memory summary: ${cell(summary, 160)}`);
  lines.push("");

  lines.push("## Files changed");
  if (git?.stat) lines.push("```text", clip(git.stat, 2000), "```");
  else lines.push("No git diff was available (not a repository, or a clean tree).");
  lines.push("");

  lines.push("## Dependencies");
  if (!depsBefore) lines.push("No dependency baseline was captured.");
  else if (deps.added.length + deps.removed.length + deps.changed.length === 0)
    lines.push("No dependency changes.");
  else {
    if (deps.added.length) lines.push(`- Added: ${deps.added.join(", ")}`);
    if (deps.removed.length) lines.push(`- Removed: ${deps.removed.join(", ")}`);
    if (deps.changed.length) lines.push(`- Changed: ${deps.changed.join(", ")}`);
  }
  lines.push("");

  if (research) {
    lines.push("## Research");
    lines.push(clip(research, 1200));
    lines.push("");
  }

  lines.push("## Decisions and constraints");
  lines.push(memory ? clip(memory, 1800) : "(no distilled memory)");
  lines.push("");

  lines.push("## Evidence");
  lines.push("- Per-check stdout/stderr/exit code: `.mission/evidence/`");
  lines.push("- Journal: `.mission/journal.md`");
  if (discovery.length) lines.push("- Recon reports: `.mission/discovery/`");
  if (blueprint) lines.push("- Blueprint: `.mission/blueprint.md`");
  lines.push("");

  lines.push("## Next steps");
  lines.push(improvements.trim() ? clip(improvements, 1200) : "No follow-up backlog was recorded.");
  lines.push("");

  return `${lines.join("\n").trim()}\n`;
}
