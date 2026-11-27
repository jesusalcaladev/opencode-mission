// Supervisor turn helpers extracted from the main loop.
// All dependencies are reached through this.d (set by the Supervisor).

export const decisions = {
  /// Single place that assembles decide() inputs. Keeping stop/pause files and
  /// the baseline together prevents the three turn-time decision sites from
  /// drifting apart.
  async buildDecision(root, state, { results, tasks, verdict = null, criteria = null } = {}) {
    const [stopFile, pauseFile, loaded] = await Promise.all([
      this.d.stopRequested(root),
      this.d.pauseRequested(root),
      criteria ? Promise.resolve(null) : this.d.loadCriteria(root),
    ]);
    return this.d.decideNext({
      state,
      results,
      tasks,
      verdict,
      stopFile,
      pauseFile,
      criteria: criteria ?? loaded,
      baseline: state.check_baseline ?? {},
    });
  },

  taskAttemptLimit(state) {
    return this.d.attemptLimit(state);
  },

  async reclaimExpiredLeases(root, progress, state = null, now = Date.now()) {
    const overdue = this.d.expired(progress, now);
    if (overdue.length === 0) return;
    const limit = this.taskAttemptLimit(state);
    for (const id of overdue) this.d.fail(progress, id, "lease expired", now, limit);
    const stored = await this.d.loadTasks(root);
    for (const task of stored) {
      if (overdue.includes(task.id)) {
        task.status = this.d.retryable(progress, task.id, limit)
          ? this.d.TASK_STATUS.PENDING
          : this.d.TASK_STATUS.FAILED;
      }
    }
    await this.saveTasksSafe(root, stored);
    await this.saveProgressSafe(root, progress);
    await this.journal(
      root,
      `leases expired: ${overdue.map((id) => `#${id}`).join(", ")} → reclaimed`
    );
  },

  async resolveStopDecision(root, state, decision) {
    if (decision.type !== "stop") return decision;

    const auto = this.d.autoExtendDecision({
      decision,
      state,
      progress: this.d.recentProgress(state, state.stall_after_turns ?? 3),
    });
    if (auto.type === "extend") {
      Object.assign(state, this.d.applyAutoExtension(state));
      state.metrics = this.d.recordMetric(state.metrics, "extensions", 1);
      await this.journal(
        root,
        `auto-extended ${state.extensions}/${state.max_extensions} after ${auto.reason} · turns ${state.max_turns} · budget $${state.budget_usd.toFixed(2)}`
      );
      if (state.never_give_up)
        await this.notify("budget-extension", `Relentless mission extended after ${auto.reason}.`);
      return { type: "continue" };
    }

    const roadmap = this.d.parseRoadmap(await this.d.loadRoadmap(root));
    const chain = this.d.chainDecision({
      decision,
      extendRequested: await this.d.extendRequested(root),
      extensions: state.extensions ?? 0,
      maxExtensions: state.max_extensions ?? this.d.DEFAULT_MAX_EXTENSIONS,
      next: this.d.nextItem(roadmap),
    });
    if (chain.type === "extend" && (await this.d.consumeExtend(root))) {
      Object.assign(state, this.d.applyExtension(state));
      state.metrics = this.d.recordMetric(state.metrics, "extensions", 1);
      await this.journal(
        root,
        `budget extended ${state.extensions}/${state.max_extensions ?? this.d.DEFAULT_MAX_EXTENSIONS} after ${chain.reason}`
      );
      return { type: "continue" };
    }
    return decision;
  },

  async revertBrokenImprovement(root, workRoot, state, results) {
    if (!state.active_improve_id || this.d.allGreen(results) || !state.improve_revert_sha) return;
    const reverted = await this.d.gitRevert(workRoot, state.improve_revert_sha);
    const note = reverted.ok
      ? `improve #${state.active_improve_id} reverted: ${state.improve_revert_sha}`
      : `improve #${state.active_improve_id} revert failed: ${reverted.reason}`;
    await this.journal(root, note);
    if (reverted.ok) {
      const reopened = await this.d.loadTasks(root);
      const target = reopened.find((task) => task.id === state.active_improve_id);
      if (target) target.status = this.d.TASK_STATUS.FAILED;
      await this.saveTasksSafe(root, reopened);
    }
    state.active_improve_id = 0;
    state.improve_revert_sha = "";
    await this.saveStateSafe(root, state);
  },

  async maybeHandoff(sessionID, root, state) {
    let targetSession = sessionID;
    const due =
      state.handoff_every_turns > 0 &&
      state.turn - (state.last_handoff_turn ?? 0) >= state.handoff_every_turns;
    if (!due) return targetSession;
    try {
      const created = await this.ctx.session.create({
        title: `mission ${state.id ?? "mission"} · turn ${state.turn}`,
        location: { directory: this.ctx.location.directory },
      });
      const newID = created?.id ?? created?.data?.id;
      if (!newID) return targetSession;
      targetSession = newID;
      state.last_handoff_turn = state.turn;
      state.session_id = newID;
      state.handoffs = this.d.recordHandoff(state, sessionID, newID, state.turn);
      state.metrics = this.d.recordMetric(state.metrics, "handoffs", 1);
      await this.journal(root, `context handoff ${sessionID} → ${newID}`);
      this.unbind(sessionID);
      this.bind(newID, root);
      await this.persistBinding(newID, root);
      await this.ctx.session
        .synthetic({ sessionID, text: `[MISSION HANDOFF] Continuing in session ${newID}.` })
        .catch((err) => this.warn(root, "handoff notice failed", err));
    } catch (err) {
      await this.journal(root, `handoff failed, staying in session: ${this.d.shortError(err)}`);
      targetSession = sessionID;
    }
    return targetSession;
  },

  buildNudge({ sessionID, targetSession, state, results, tasks }) {
    const failing = results
      .filter((r) => !r.ok)
      .map((r) => `- ${r.id}: ${r.summary}`)
      .join("\n");
    const task = this.d.selectTask(tasks);
    const strategyNote =
      state.strategy_tier >= 2
        ? `STRATEGY TIER ${state.strategy_tier}: no verified progress. Re-read the criteria and CHANGE the approach; do not repeat the same edit.`
        : "Continue the mission. Do not stop after writing files.";
    const handoffNote =
      targetSession !== sessionID
        ? "[FRESH CONTEXT] You are in a new session. The journal on disk is your memory."
        : "";
    const relentlessNote = state.never_give_up
      ? "NEVER GIVE UP: blocked verdicts trigger a re-plan, reviews trigger rework, and failed tasks are retried. Only STOP/PAUSE, hard budget, wall-clock or test erosion can end this mission."
      : "";
    return [
      `[MISSION SUPERVISOR · turn ${state.turn}/${state.max_turns}]`,
      handoffNote,
      relentlessNote,
      `Harness re-ran the criteria: ${results.filter((r) => r.ok).length}/${results.length} green.`,
      failing ? `Failing checks:\n${failing}` : "All checks green; finishing verification.",
      task ? `Next task: #${task.id} ${task.subject}` : "All tasks complete.",
      strategyNote,
      "Use mission_write / mission_check. Call mission_verdict only when every check is green.",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, this.d.MAX_NUDGE);
  },

  async deliverNudge(root, sessionID, targetSession, state, nudge) {
    const key = this.d.promptKey("nudge", targetSession, String(state.turn));
    if (this.d.isDuplicatePrompt(state, key)) return false;
    state.prompt_ledger = this.d.recordPrompt(state, {
      key,
      kind: "nudge",
      sessionID: targetSession,
    });
    await this.saveStateSafe(root, state);
    try {
      await this.ctx.session.prompt({ sessionID: targetSession, text: nudge, delivery: "queue" });
      return true;
    } catch (err) {
      // A transient delivery error must not abort a mission that is healthy on
      // disk. The rescue timer will re-admit it after the quiet window.
      await this.journal(
        root,
        `nudge delivery failed: ${this.d.shortError(err)}; rescue timer will retry`
      ).catch(() => {});
      return false;
    }
  },
};
