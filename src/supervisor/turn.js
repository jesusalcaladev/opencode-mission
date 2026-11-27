// THE main turn loop, isolated from the coordinator shell. Every decision
// still flows through this.d and the harness-owned state on disk.

export const turn = {
  async handleIdle(sessionID) {
    const root = this.rootFor(sessionID);
    if (
      !root ||
      this.busy.has(sessionID) ||
      this.workers.has(sessionID) ||
      this.knownWorkers.has(sessionID)
    )
      return;
    this.busy.add(sessionID);
    try {
      let state = await this.d.loadState(root);
      if (state.status === this.d.STATUS.PAUSED || (await this.d.pauseRequested(root))) {
        if (state.status !== this.d.STATUS.PAUSED) {
          state.status = this.d.STATUS.PAUSED;
          state.paused = true;
          await this.saveStateSafe(root, state);
          await this.journal(root, "paused at idle boundary (PAUSE file)");
        }
        return;
      }
      if (state.status !== this.d.STATUS.RUNNING) return;
      const workRoot = this.effectiveRoot(root, state);

      const integrity = await this.d.checkTestIntegrity(workRoot, state.test_hashes);
      state.test_hashes = integrity.current;
      if (!integrity.ok) {
        await this.journal(root, `test integrity refused progress: ${integrity.reason}`);
        await this.finish(root, sessionID, state, "aborted", "test-erosion", integrity.reason);
        return;
      }

      let progress = await this.d.loadProgress(root);
      if (progress.length === 0) {
        const stored = await this.d.loadTasks(root);
        if (stored.length > 0) {
          progress = this.d.fromTasks(stored);
          await this.saveProgressSafe(root, progress);
        }
      }
      await this.reclaimExpiredLeases(root, progress, state);

      await this.updateMissionCost(root, state, sessionID);
      let { results, tasks, baseline } = await this.verify(root, workRoot);
      // verify() persists the deploy evidence and task checkpoints through the
      // serialize queue; reload it before deciding, or the later save of this
      // in-memory state would drop it and the mission could never complete.
      const afterVerify = await this.d.loadState(root);
      state.deploy = afterVerify.deploy ?? state.deploy;
      state.check_baseline = baseline;
      if (await this.maybeSplitStuckTask(root, state, tasks)) {
        ({ results, tasks, baseline } = await this.verify(root, workRoot));
        state.check_baseline = baseline;
      }
      const criteria = await this.d.loadCriteria(root);
      state.last_checks_at = Date.now();
      state.history = this.d.appendHistory(state, { results, tasks });
      await this.recordProgress(root, state, results, tasks);

      // A change that breaks verification is undone automatically; the mission
      // continues from the last known-good checkpoint.
      await this.revertBrokenImprovement(root, workRoot, state, results);

      let anyProgress = this.recordTurn(state, results, tasks);
      const verdict = state.last_verdict;
      state.last_verdict = null;
      let decision = await this.resolveStopDecision(
        root,
        state,
        await this.buildDecision(root, state, { results, tasks, verdict, criteria })
      );

      await this.journalTurn(root, state, results, tasks, decision);
      await this.publishRegistry(
        root,
        state,
        this.d.objectiveOf(await this.readMission(root).catch(() => ""))
      );
      state.phase = state.stage ?? state.phase;
      await this.serialize(root, () => this.d.saveMetrics(root, state.metrics));
      await this.saveStateSafe(root, state);
      await this.compactMemory(root, state).catch(async (err) => {
        await this.journal(root, `memory compaction failed: ${this.d.shortError(err)}`).catch(
          () => {}
        );
      });

      if (decision.type === "continue" || decision.type === "replan") {
        const replanned = await this.maybeReplan(
          root,
          state,
          results,
          tasks,
          decision.type === "replan"
        );
        if (replanned) {
          state.metrics = this.d.recordMetric(state.metrics, "replans", 1);
          ({ results, tasks, baseline } = await this.verify(root, workRoot));
          state.check_baseline = baseline;
          await this.recordProgress(root, state, results, tasks);
          decision = await this.buildDecision(root, state, { results, tasks });
          await this.journalTurn(root, state, results, tasks, decision, "after replan");
        }
      }
      // A forced re-plan from a blocked verdict is a retry instruction, not a
      // terminal state: keep the turn alive even when no new plan was produced.
      if (decision.type === "replan") decision = { type: "continue", reason: decision.reason };

      decision = await this.runRolePipeline(sessionID, root, state, tasks, results, decision);

      if (decision.type === "continue" && this.enableWorkers) {
        const outcome = await this.runWorkers(sessionID, root, state, tasks, workRoot);
        if (outcome.ran) {
          state = await this.d.loadState(root);
          // Workers may have finished after the turn's initial cost snapshot.
          await this.updateMissionCost(root, state, sessionID);
          ({ results, tasks, baseline } = await this.verify(root, workRoot));
          state.check_baseline = baseline;
          await this.recordProgress(root, state, results, tasks);
          anyProgress = this.recordTurn(state, results, tasks, false) || anyProgress;
          decision = await this.buildDecision(root, state, { results, tasks });
          await this.journalTurn(root, state, results, tasks, decision, "after workers");
        }
      }

      if (decision.type === "complete" || decision.type === "stop") {
        state.unblock = decision.unblock ?? "";
        await this.finish(
          root,
          sessionID,
          state,
          decision.type === "complete"
            ? this.d.STATUS.COMPLETE
            : decision.reason === "blocked"
              ? this.d.STATUS.BLOCKED
              : this.d.STATUS.ABORTED,
          decision.reason ?? "all criteria green",
          verdict?.summary ?? ""
        );
        return;
      }

      if (anyProgress) {
        const owned = [...new Set(tasks.flatMap((task) => task.files ?? []))];
        const commit = await this.serialize(root, () =>
          this.d.gitCommit(
            workRoot,
            `mission(${state.id ?? "mission"}): turn ${state.turn} — verified progress`,
            owned
          )
        );
        if (commit.ok) {
          state.last_commit = commit.sha;
          await this.journal(root, `checkpoint committed: ${commit.sha ?? commit.reason}`);
        } else {
          await this.journal(root, `checkpoint commit skipped: ${commit.reason}`);
        }
      }

      const targetSession = await this.maybeHandoff(sessionID, root, state);
      // Do NOT stamp last_prompt_at here: a failed or duplicate nudge would
      // reset the rescue clock and blind every recovery layer.
      await this.saveStateSafe(root, state);
      // A handoff can change `state.session_id`; republish so the TUI rebinds.
      await this.publishRegistry(
        root,
        state,
        this.d.objectiveOf(await this.readMission(root).catch(() => ""))
      );
      await this.refreshBrief(targetSession, root, results).catch(async (err) => {
        await this.journal(root, `brief refresh failed: ${this.d.shortError(err)}`).catch(() => {});
      });

      const nudge = this.buildNudge({ sessionID, targetSession, state, results, tasks });
      if (!(await this.deliverNudge(root, sessionID, targetSession, state, nudge))) {
        await this.rollbackHandoff(sessionID, targetSession, root);
        return;
      }
      await this.finalizeHandoff(sessionID, targetSession, root, state);
      await this.serialize(root, async () => {
        const delivered = await this.d.loadState(root);
        delivered.last_prompt_at = Date.now();
        await this.saveStateSafe(root, delivered);
      });
    } catch (err) {
      await this.recoverFromError(sessionID, err);
    } finally {
      this.busy.delete(sessionID);
    }
  },
};
