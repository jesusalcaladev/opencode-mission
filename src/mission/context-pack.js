// One bounded, pure context pack shared by the lead brief and every subagent
// brief. Dynamic state always comes from disk; nothing is copied from chat
// history. Limits are explicit so a worker never gets an unbounded prompt.

export const CONTEXT_LIMITS = Object.freeze({
  instructions: 6000,
  facts: 2000,
  memory: 4000,
  summary: 1000,
  journal: 3000,
  requirements: 3000,
  checks: 2000,
  total: 20_000,
});

export const WORKER_LIMITS = Object.freeze({
  instructions: 1500,
  facts: 600,
  memory: 1200,
  summary: 400,
  journal: 800,
  requirements: 600,
  checks: 600,
  total: 6000,
});

export function clip(value, max) {
  const text = String(value ?? "").trim();
  const cap = Math.max(0, Number(max) || 0);
  if (!cap) return "";
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

export function taskAttemptLine(progress = [], task = null) {
  if (!task) return "";
  const entry = progress.find((p) => Number(p?.id) === Number(task.id));
  if (!entry) return "";
  const attempts = Number(entry.attempts) || 0;
  const error = String(entry.last_error ?? "").slice(0, 200);
  if (attempts === 0 && !error) return "";
  return `Task #${task.id} attempt ${attempts + 1}${error ? ` · previous error: ${error}` : ""}${
    attempts > 0 ? " · do NOT repeat the discarded approach" : ""
  }`;
}

export function relevantChecks(results = [], task = null) {
  const list = Array.isArray(results) ? results : [];
  if (!task?.verify) return list.slice(0, 4);
  const own = list.filter((r) => r?.id === task.verify);
  const red = list.filter((r) => r?.id !== task.verify && !r?.ok).slice(0, 2);
  return [...own, ...red];
}

export function relevantRequirements(requirements = [], task = null) {
  const list = Array.isArray(requirements) ? requirements : [];
  if (!task?.verify) return list.slice(0, 5);
  const linked = list.filter((r) => (r?.checks ?? []).includes(task.verify));
  return linked.length ? linked.slice(0, 4) : list.slice(0, 3);
}

export function buildContextPack({
  state = {},
  memory = "",
  summary = "",
  facts = [],
  journal = "",
  instructions = "",
  results = [],
  requirements = [],
  progress = [],
  task = null,
  limits = CONTEXT_LIMITS,
  role = "lead",
} = {}) {
  const cap = { ...CONTEXT_LIMITS, ...(limits ?? {}) };
  const checks = relevantChecks(results, task)
    .map((r) => `- ${r.id}: ${r.ok ? "green" : "red"} ${String(r.summary ?? "").slice(0, 100)}`)
    .join("\n");
  const reqs = relevantRequirements(requirements, task)
    .map((r) => `- ${r.id}: ${String(r.text ?? "").slice(0, 160)} [${(r.checks ?? []).join(",")}]`)
    .join("\n");
  const attempt = taskAttemptLine(progress, task);
  const sections = [
    [
      "PROJECT INSTRUCTIONS (AGENTS.md / CLAUDE.md)",
      clip(instructions, cap.instructions) || "(none found)",
    ],
    [
      "DURABLE FACTS",
      clip(
        Array.isArray(facts)
          ? facts.map((f) => `- ${f?.subject ?? ""}: ${f?.text ?? ""}`).join("\n")
          : facts,
        cap.facts
      ) || "(none)",
    ],
    ["DISTILLED MEMORY", clip(memory, cap.memory) || "(empty)"],
    ["SUMMARY", clip(summary, cap.summary) || "(empty)"],
    ["RECENT JOURNAL", clip(String(journal).slice(-cap.journal), cap.journal) || "(empty)"],
    [
      "REQUIREMENTS (completion requires every one covered by a green check)",
      reqs || "(none declared)",
    ],
    ["CHECKS", checks || "(none run yet)"],
  ];
  if (attempt) sections.push(["TASK HISTORY", clip(attempt, 400)]);
  if (role !== "lead" && state?.strategy_tier > 1)
    sections.push([
      "STRATEGY",
      `tier ${state.strategy_tier}: change the approach, do not repeat it.`,
    ]);
  let text = sections.map(([heading, body]) => `${heading}\n${body}`).join("\n\n");
  text = clip(text, cap.total);
  return `MISSION CONTEXT (${role} · from durable state)\n${text}`;
}
