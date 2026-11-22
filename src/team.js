// Pure scheduling of parallel workers. Tasks with disjoint file lists and no
// unfinished dependencies can run in the same wave; the rest wait.

export function wavesFor(tasks, maxWorkers = 3) {
  const pending = tasks.map((t) => ({ ...t, blocked_by: [...(t.blocked_by ?? [])] }));
  const done = new Set();
  const waves = [];
  let guard = 0;

  while (pending.length && guard < tasks.length + 1) {
    guard += 1;
    const wave = [];
    const used = new Set();
    for (const task of pending) {
      if (wave.length >= maxWorkers) break;
      if (!task.blocked_by.every((id) => done.has(id) || !pending.some((p) => p.id === id)))
        continue;
      const files = Array.isArray(task.files) ? task.files : [];
      const keys = files.length ? files : [`__task_${task.id}`];
      if (keys.some((k) => used.has(k))) continue;
      wave.push(task);
      keys.forEach((k) => used.add(k));
    }
    if (!wave.length) break;
    waves.push(wave);
    for (const task of wave) {
      done.add(task.id);
      const i = pending.findIndex((t) => t.id === task.id);
      if (i >= 0) pending.splice(i, 1);
    }
  }
  return waves;
}

export function workerPrompt({ task, objective, workspace }) {
  const files = Array.isArray(task.files) ? task.files : [];
  return [
    `[MISSION WORKER · task #${task.id}]`,
    `Mission objective: ${objective}`,
    `Workspace: ${workspace}`,
    `YOUR TASK: ${task.subject}`,
    files.length
      ? `Files you own: ${files.join(", ")}`
      : "Files you own: (not declared — stay inside the workspace)",
    "",
    "RULES",
    "- Do ONLY this task. Another worker owns the other tasks.",
    "- Use mission_write to create/edit files. Do not run the global checks; the lead verifies them.",
    "- Do not touch files outside the workspace and do not create a mission verdict.",
    `- Call mission_heartbeat(id=${task.id}) every couple of minutes so your lease is not reclaimed while you work.`,
    `- When finished, call mission_task_done(id=${task.id}, status="done"|"failed", summary="what you did", evidence=["paths/checked"]). A failed report releases the lease so the task can be retried.`,
  ].join("\n");
}

export function workerBrief({ task, objective, workspace }) {
  const files = Array.isArray(task.files) ? task.files : [];
  return [
    "MISSION WORKER BRIEF (harness-owned)",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    `Assigned task: #${task.id} ${task.subject}`,
    `Owned files: ${files.join(", ") || "(undeclared)"}`,
    "Finish by calling mission_task_done. The lead agent verifies criteria and owns completion.",
  ].join("\n");
}

export function investigatorPrompt({ objective, workspace }) {
  return [
    "[MISSION INVESTIGATOR]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "Read-only stage. Do NOT write or edit files.",
    "Map the relevant files, current behavior and constraints. Call mission_report(role='investigator', text='...') with a concise findings summary before you finish.",
  ].join("\n");
}

export function splitPrompt({ objective, task, attempts = 2 }) {
  return [
    "A task in an autonomous mission is stuck. Split it into 2..5 smaller, independently verifiable subtasks.",
    "Output ONLY one JSON object:",
    '{"tasks":[{"subject":"imperative","files":["relative/path"],"verify":"existing-check-id"}]}',
    "Rules: ids are assigned by the harness; files must be disjoint between subtasks; verify MUST name an existing check id.",
    "Do NOT invent new checks. Do NOT change the objective. Make each subtask small enough to finish in one turn.",
    `Objective: ${objective}`,
    `Stuck task #${task.id}: ${task.subject} (attempts=${attempts}, files=${(task.files ?? []).join(",") || "undeclared"}, verify=${task.verify ?? ""})`,
  ].join("\n");
}

export function researcherPrompt({ objective, workspace, question = "" }) {
  return [
    "[MISSION RESEARCHER]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    question ? `Research question: ${question}` : "",
    "",
    "Read-only for code. You may use mission_web_search, mission_web_fetch, mission_image_search, mission_image_generate and mission_research_note.",
    "Find authoritative sources. Cite every claim with a URL. Download at least one relevant image when images are enabled.",
    "Write a concise report with sections: Findings, Sources, Images, Recommendation, Open Questions.",
    "Call mission_report(role='researcher', text='...') with the report before you finish.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function integratorPrompt({ objective, workspace, checks = [] }) {
  return [
    "[MISSION INTEGRATOR]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "All task workers have finished. You may write ANY file in the workspace except .mission/.",
    "Run mission_check. Fix cross-module breakage, integration errors and missing glue until every check is green.",
    "Do not weaken tests and do not create a verdict. Call mission_log when you finish.",
    `Checks: ${checks.map((c) => c.id).join(", ") || "none"}`,
  ].join("\n");
}

export function goalAuditorPrompt({
  objective,
  workspace,
  requirements = [],
  checks = [],
  journalTail = "",
}) {
  return [
    "[MISSION GOAL AUDITOR]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "Read-only. Decide whether the OBJECTIVE is actually fulfilled, not merely whether tests pass.",
    "Compare the requirements below with the files and the evidence on disk. Look for missing behavior, stubs, incomplete features and shallow checks.",
    "For every gap emit one line starting with 'GAP:':",
    "GAP: requirement=<id> check=<check-id-or-empty> files=a.js,b.js <what is missing>",
    "If the objective is fully fulfilled, write 'NO GAPS'.",
    `Requirements: ${requirements.map((r) => `${r.id}: ${r.text} [${(r.checks ?? []).join(",")}]`).join(" | ") || "none"}`,
    `Checks: ${checks.map((c) => `${c.id}:${c.ok ? "green" : "red"}`).join(", ") || "none"}`,
    `Recent journal: ${String(journalTail).slice(0, 1200)}`,
    "Call mission_report(role='goal-auditor', text='...') before you finish.",
  ].join("\n");
}

export function reviewerPrompt({ objective, workspace, checks = [] }) {
  return [
    "[MISSION REVIEWER]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "Read-only stage. Do NOT write or edit files.",
    "Review the diff and the files named in the checks. Look for wrong behavior, regressions, debug leftovers and weakened tests.",
    "Every finding MUST be a line starting with 'SEVERITY: high', 'SEVERITY: medium' or 'SEVERITY: low'.",
    `Checks to consider: ${checks.map((c) => c.id).join(", ") || "none"}`,
    "Call mission_report(role='reviewer', text='...') with your findings before you finish. If there are no problems, write 'SEVERITY: low — no blocking findings'.",
  ].join("\n");
}

export function reportsText(reports) {
  const lines = Object.entries(reports ?? {}).map(
    ([id, report]) => `- task #${id}: ${report.summary ?? "no summary"}`
  );
  return lines.length ? `Worker reports:\n${lines.join("\n")}` : "No worker reports.";
}
