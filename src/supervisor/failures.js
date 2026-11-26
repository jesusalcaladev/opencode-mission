// Failure mixin: dedupe failed turns, backoff, model rotation, and the
// relentless failure-ceiling reset. Kept apart from registry/recovery flow.

export const failures = {
  async handleFailure(sessionID, error) {
    const root = this.rootFor(sessionID);
    if (!root) return;
    if (this.workers.has(sessionID) || this.knownWorkers.has(sessionID)) {
      const progress = await this.d.loadProgress(root);
      const missionState = await this.d.loadState(root);
      const worker = this.workers.get(sessionID);
      const owned =
        progress.find((p) => p.owner === sessionID) ??
        (worker ? progress.find((p) => p.id === worker.taskId) : null);
      if (owned) {
        this.d.fail(
          progress,
          owned.id,
          this.d.shortError(error),
          Date.now(),
          this.taskAttemptLimit(missionState)
        );
        await this.saveProgressSafe(root, progress);
        await this.journal(
          root,
          `worker failure on task #${owned.id}: ${this.d.shortError(error)} → lease released for retry`
        );
      }
      return;
    }
    const state = await this.d.loadState(root);
    if (state.status !== this.d.STATUS.RUNNING || this.busy.has(sessionID)) return;

    // OpenCode can emit both `failed` and `interrupted` for one turn. Count
    // only one failure per short window so a single error cannot abort a mission.
    const now = Date.now();
    if (state.last_failure_at && now - state.last_failure_at < 1500) return;
    state.last_failure_at = now;

    const message = this.d.shortError(error);
    state.failures = (state.failures ?? 0) + 1;
    state.metrics = this.d.recordMetric(state.metrics, "failures", 1);
    await this.journal(
      root,
      `execution failure ${state.failures}/${state.max_failures}: ${message}`
    );
    const limit = this.d.effortLimit(state.max_failures, 3);
    if (limit > 0 && state.failures >= limit) {
      if (!state.never_give_up) {
        await this.finish(
          root,
          sessionID,
          state,
          "aborted",
          "repeated-execution-failure",
          `after ${state.failures} failures: ${message}`
        );
        return;
      }
      await this.journal(
        root,
        `relentless: failure ceiling (${state.failures}) reached — rotating model and retrying`
      );
      await this.notify(
        "failure-reset",
        `Relentless mission hit ${state.failures} failures; retrying.`
      );
      state.failures = 0;
      state.metrics = this.d.recordMetric(state.metrics, "failuresReset", 1);
    }

    this.lastRotation = state.model_rotation ?? [];
    state.model_rotation =
      (await this.rotateModel(sessionID, message)) ?? state.model_rotation ?? [];
    state.last_prompt_at = Date.now();
    await this.saveStateSafe(root, state);

    const delayMs = Math.min(2000 * 2 ** (state.failures - 1), 30_000);
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      try {
        const fresh = await this.d.loadState(root);
        if (fresh.status !== this.d.STATUS.RUNNING) return;
        const key = this.d.promptKey("recovery", sessionID, String(fresh.failures));
        if (this.d.isDuplicatePrompt(fresh, key)) return;
        fresh.prompt_ledger = this.d.recordPrompt(fresh, { key, kind: "recovery", sessionID });
        await this.journal(root, `retrying after ${delayMs}ms backoff`);
        await this.saveStateSafe(root, fresh);
        await this.refreshBrief(sessionID, root, fresh.last_checks ?? []);
        await this.ctx.session.prompt({
          sessionID,
          text: `[MISSION RECOVERY] The previous turn failed (${message}). Continue from the mission state; do not declare done without green checks.`,
          delivery: "queue",
        });
      } catch {
        // The next restart auto-resume will pick it up.
      }
    }, delayMs);
    this.timers.add(timer);
  },

  async rotateModel(sessionID, message) {
    if (!/(quota|402|credits|rate.?limit|429|overloaded)/i.test(message)) return;
    const fallback = this.options.fallbackModel;
    try {
      if (fallback?.providerID && fallback?.id) {
        await this.ctx.session.switchModel({ sessionID, model: fallback });
        await this.d.appendJournal(
          this.rootFor(sessionID),
          `model rotated to ${fallback.providerID}/${fallback.id} (configured fallback)`
        );
        return;
      }
      const session = await this.ctx.session.get({ sessionID });
      let current = session?.model;
      if (!current) {
        const def = await this.ctx.model.default().catch(() => null);
        if (def?.providerID) current = { providerID: def.providerID, id: def.id ?? def.modelID };
      }
      const catalog = await this.modelCatalog();
      const candidates = this.modelRotationCandidates(catalog, current, this.lastRotation ?? []);
      const candidate = candidates[0];
      if (candidate) {
        await this.ctx.session.switchModel({ sessionID, model: candidate });
        this.lastRotation = [
          ...(this.lastRotation ?? []),
          `${candidate.providerID}/${candidate.id}`,
        ].slice(-20);
        await this.d.appendJournal(
          this.rootFor(sessionID),
          `model rotated ${current?.providerID ?? "?"}/${current?.id ?? "?"} → ${candidate.providerID}/${candidate.id} after quota error (${candidates.length} candidate(s))`
        );
        return this.lastRotation;
      }
      this.lastRotation = [];
      return this.lastRotation;
    } catch {
      // Rotation is best-effort; the failure counter is the real backstop.
    }
  },
};
