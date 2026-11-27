// Turn telemetry and status text. Extracted from workers.js so the worker
// pool file stays focused on dispatch and leases.

export const telemetry = {
  recordTurn(state, results, tasks, countTurn = true) {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    state.metrics = this.d.recordMetrics(state.metrics, {
      turns: countTurn ? 1 : 0,
      checksRun: results.length,
      checksGreen: green,
      checksRed: results.length - green,
      tasksCompleted: done,
    });
    const progress = green > (state.best_green ?? 0) || done > (state.tasks_done ?? 0);
    state.failures = 0;
    if (countTurn) state.turn += 1;
    state.last_checks = results;
    state.best_green = Math.max(state.best_green ?? 0, green);
    state.tasks_done = done;
    state.stall_turns = progress ? 0 : (state.stall_turns ?? 0) + 1;
    state.strategy_tier = this.d.nextStrategy(state.strategy_tier, progress);
    if (state.stall_turns >= 3 && state.strategy_tier < 3) {
      state.strategy_tier = 3;
      state.last_progress_turn = state.turn - 3;
    }
    if (progress) state.last_progress_turn = state.turn;
    return progress;
  },

  async journalTurn(root, state, results, tasks, decision, label = "turn") {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    await this.d.appendJournal(
      root,
      `${label} ${state.turn}: ${green}/${results.length} checks green, ${done}/${tasks.length} tasks done, tier ${state.strategy_tier}, $${state.cost_usd.toFixed(2)} → ${decision.type}${decision.reason ? `(${decision.reason})` : ""}`
    );
  },

  async sessionCost(sessionID) {
    return (await this.sessionUsage(sessionID)).cost;
  },

  async statusText(root) {
    const state = await this.d.loadState(root);
    const tasks = await this.d.loadTasks(root);
    const task = this.d.selectTask(tasks);
    const green = state.last_checks.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    const pct =
      state.last_checks.length > 0
        ? green / state.last_checks.length
        : tasks.length > 0
          ? done / tasks.length
          : 0;
    const filled = Math.max(0, Math.min(10, Math.round(pct * 10)));
    const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
    return [
      `Mission: ${root}`,
      `Progress: ${bar} ${green}/${state.last_checks.length} checks · ${done}/${tasks.length} tasks · improve cycles ${state.improve_cycles ?? 0}`,
      `Status: ${state.status} · turn ${state.turn}/${state.max_turns} · cost $${state.cost_usd.toFixed(2)}/$${state.budget_usd.toFixed(2)}`,
      `Checks: ${green}/${state.last_checks.length} green · tasks: ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`,
      `Next task: ${task ? `#${task.id} ${task.subject}` : "none"}`,
      `Strategy tier: ${state.strategy_tier} · failures: ${state.failures ?? 0} · finish reason: ${state.finish_reason ?? "none"}`,
      `Chain: ${state.chain_index ?? 0}/${state.chain_total ?? 0} · extensions: ${state.extensions ?? 0}/${state.max_extensions ?? 3}`,
      `Discovery: ${state.discovery_done ? `${state.recon_agents ?? 0} recon agent(s) + blueprint` : "off"} · report: ${state.report_path || "written on finish"}`,
      `Workspace: ${this.effectiveRoot(root, state)}${state.worktree_branch ? ` (${state.worktree_branch})` : ""}`,
    ].join("\n");
  },
};
