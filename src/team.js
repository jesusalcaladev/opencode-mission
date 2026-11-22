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
      if (!task.blocked_by.every((id) => done.has(id) || !pending.some((p) => p.id === id))) continue;
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
    files.length ? `Files you own: ${files.join(", ")}` : "Files you own: (not declared — stay inside the workspace)",
    '',
    "RULES",
    "- Do ONLY this task. Another worker owns the other tasks.",
    "- Use mission_write to create/edit files. Do not run the global checks; the lead verifies them.",
    "- Do not touch files outside the workspace and do not create a mission verdict.",
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

export function reportsText(reports) {
  const lines = Object.entries(reports ?? {}).map(([id, report]) => `- task #${id}: ${report.summary ?? "no summary"}`);
  return lines.length ? `Worker reports:\n${lines.join("\n")}` : "No worker reports.";
}
