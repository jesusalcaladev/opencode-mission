// Durable mission memory: distill the append-only journal into a bounded,
// stable brief that is regenerated from disk on every model request.
// This is the cure for "the agent loses context after a few hours".

import { objectiveOf } from "./state.js";
import { renderFacts } from "./facts.js";
import { selectTask } from "./decide.js";

export const MEMORY_BUDGET = 4000;
export const JOURNAL_TAIL = 1200;

const WORTH_KEEPING =
  /decid|approach|discard|blocker|blocked|verified|commit|erosion|fatal|failed|retry|handoff|migrat|constraint|must not|owner/i;

function stripStamp(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export function distill({
  journal = "",
  memory = "",
  summary: _summary = "",
  maxChars = MEMORY_BUDGET,
}) {
  const kept = [];
  const seen = new Set();
  for (const raw of memory.split(/\r?\n/)) {
    const line = stripStamp(raw);
    if (!line || line.startsWith("#")) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  const lines = journal
    .split(/\r?\n/)
    .map(stripStamp)
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!WORTH_KEEPING.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.unshift(line);
    if (kept.join("\n").length > maxChars) {
      kept.shift();
      break;
    }
  }
  const text = kept.join("\n").slice(-maxChars);
  const recent = text.split(/\r?\n/).slice(0, 3).join("\n");
  return {
    memory: text,
    summary: `Memory entries: ${kept.length} · distilled from ${lines.length} journal lines\n${recent}`,
  };
}

export function buildBrief({
  root,
  missionText,
  state,
  tasks,
  journal,
  results,
  memory = "",
  summary = "",
  progress = [],
  instructions = "",
  facts = [],
  requirements = [],
  research = "",
}) {
  const task = selectTask(tasks);
  const green = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.summary ?? "failed"}`);
  const leased = progress
    .filter((p) => p.status === "in_progress" && p.lease_until > Date.now())
    .map((p) => `#${p.id}`);
  const lines = [
    "MISSION BRIEF (harness-owned — regenerated from disk, not from conversation history)",
    `Id: ${state.id ?? "mission"}`,
    `Objective: ${objectiveOf(missionText)}`,
    `Workspace: ${root}`,
    "",
    "PROJECT INSTRUCTIONS (AGENTS.md / CLAUDE.md)",
    instructions.trim().slice(0, 6000) || "(none found)",
    "",
    "RULES",
    "1. Use mission_write to create or edit files; use your read/glob tools to inspect.",
    "2. Call mission_check after every change. It runs the real criteria and returns per-check results.",
    '3. Call mission_verdict(status="met", summary=...) ONLY after mission_check reports every check green. A red check always beats your verdict.',
    '4. If the mission is genuinely impossible, call mission_verdict(status="blocked", summary=..., what_would_unblock=...). This stops the mission.',
    "5. Do not stop after writing files. Keep working until the checks are green.",
    "6. mission_task_done(id, status, summary, evidence) is the worker completion channel; it never completes a task by itself.",
    "",
    `Next task: ${task ? `#${task.id} ${task.subject}` : "none — all tasks complete"}`,
    `Workers in flight: ${leased.length ? leased.join(", ") : "none"}`,
    `Checks: ${green}/${results.length} green${failed.length ? ` · failing: ${failed.join("; ")}` : ""}`,
    `Turn ${state.turn}/${state.max_turns} · cost $${state.cost_usd.toFixed(2)}/$${state.budget_usd.toFixed(2)} · strategy tier ${state.strategy_tier}`,
    `Autonomy: ${state.autonomy ?? (state.auto_extend ? "campaign" : "standard")} · auto-extend ${state.auto_extend ? "on" : "off"} · extensions ${state.extensions ?? 0}/${state.max_extensions ?? 3}`,
    "",
    "REQUIREMENTS (completion requires every one to be covered by a green check)",
    requirements.length
      ? requirements.map((r) => `- ${r.id}: ${r.text} [${(r.checks ?? []).join(",")}]`).join("\n")
      : "(none declared)",
    "",
    "RESEARCH",
    research.trim().slice(0, 3000) || "(none)",
    "",
    "DURABLE FACTS",
    renderFacts(facts) || "(none)",
    "",
    "DISTILLED MEMORY",
    memory.trim() || "(empty)",
    "",
    "SUMMARY",
    summary.trim() || "(empty)",
    "",
    "RECENT JOURNAL",
    journal.trim().slice(-JOURNAL_TAIL) || "(empty)",
  ];
  return lines.join("\n");
}
