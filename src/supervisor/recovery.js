/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// recovery mixin — extracted from supervisor.js; behavior unchanged.

export const recovery = {
  async init() {
    const saved = await this.ctx.storage.get(this.d.REGISTRY_KEY).catch(() => []);
    const stored = Array.isArray(saved)
      ? saved.filter((e) => e && typeof e.sessionID === "string" && typeof e.root === "string")
      : [];
    this.registry = this.d.pruneRegistry(
      stored,
      stored.map((e) => e.root),
      30
    );
    for (const entry of this.registry) {
      const root = this.d.path.resolve(entry.root);
      this.bind(entry.sessionID, root);
      const state = await this.d.loadState(root);
      for (const id of state.worker_sessions ?? []) this.knownWorkers.add(id);
      await this.recoverStaleWorkers(root, state);
      await this.maybeAutoResume(entry.sessionID, root);
    }
  },

  async recoverStaleWorkers(root, state = null) {
    const progress = await this.d.loadProgress(root);
    if (progress.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const p of progress) {
      if (p?.status !== this.d.TASK_STATUS.IN_PROGRESS) continue;
      const owner = String(p.owner ?? "");
      const session = owner
        ? await this.ctx.session.get({ sessionID: owner }).catch(() => null)
        : null;
      if (!session || session.outcome === "failed" || session.outcome === "interrupted") {
        this.d.fail(
          progress,
          p.id,
          `worker did not survive restart (${session?.outcome ?? "missing"})`,
          now
        );
        changed = true;
      }
    }
    if (changed) {
      const s = await this.d.loadState(root);
      s.metrics = this.d.recordMetrics(s.metrics, {
        recoveries: 1,
        agentReclaims: progress.filter((p) => p.status === this.d.TASK_STATUS.FAILED).length,
      });
      await this.saveStateSafe(root, s);
      await this.saveProgressSafe(root, progress);
      const stored = await this.d.loadTasks(root);
      for (const t of stored) {
        const entry = progress.find((p) => p.id === t.id);
        if (entry && entry.status === this.d.TASK_STATUS.FAILED) {
          t.status = this.d.retryable(progress, t.id)
            ? this.d.TASK_STATUS.PENDING
            : this.d.TASK_STATUS.FAILED;
        }
      }
      await this.saveTasksSafe(root, stored);
      await this.journal(
        root,
        `recovery: stale worker leases released (${progress.filter((p) => p.status === this.d.TASK_STATUS.FAILED).length} failed)`
      );
    }
  },

  bind(sessionID, root, isLead = true) {
    this.bySession.set(sessionID, root);
    // Only the lead owns the root's idle loop and registry entry. Workers can
    // use mission_* tools, but must never continue the mission themselves.
    if (isLead) this.byRoot.set(root, sessionID);
  },

  unbind(sessionID) {
    const root = this.bySession.get(sessionID);
    if (root) this.byRoot.delete(root);
    this.bySession.delete(sessionID);
    this.registry = this.registry.filter((e) => e.sessionID !== sessionID);
  },

  async persistBinding(sessionID, root) {
    this.registry = this.registry.filter((e) => e.sessionID !== sessionID && e.root !== root);
    const now = Math.max(Date.now(), this.registryClock ?? 0);
    this.registryClock = now + 1;
    this.registry.push({ sessionID, root, updated_at: now });
    this.registry = this.d.pruneRegistry(
      this.registry,
      this.registry.map((e) => e.root),
      30
    );
    await this.ctx.storage.set(this.d.REGISTRY_KEY, this.registry).catch(() => {});
  },

  async maybeAutoResume(sessionID, root) {
    try {
      const session = await this.ctx.session.get({ sessionID });
      if (!session || session.outcome === "failed" || session.outcome === "interrupted") return;
      const busy = (session.time?.busy ?? 0) > (session.time?.idle ?? 0);
      if (busy) return;
      const state = await this.d.loadState(root);
      if (state.status !== this.d.STATUS.RUNNING) return;
      if (Date.now() - (state.last_prompt_at || 0) < this.d.AUTO_RESUME_AGE_MS) return;

      const key = this.d.promptKey("auto-resume", sessionID);
      if (this.d.isDuplicatePrompt(state, key)) return;
      await this.journal(root, `auto-resume after plugin reload (session ${sessionID})`);
      state.failures = 0;
      state.last_prompt_at = Date.now();
      state.metrics = this.d.recordMetrics(state.metrics, { autoResumes: 1, recoveries: 1 });
      state.prompt_ledger = this.d.recordPrompt(state, { key, kind: "auto-resume", sessionID });
      await this.saveStateSafe(root, state);
      await this.refreshBrief(sessionID, root, state.last_checks ?? []);
      await this.ctx.session.prompt({
        sessionID,
        text: "[MISSION RESUME] The service restarted. Continue from the mission state on disk.",
        delivery: "queue",
      });
    } catch {
      // A stale registry entry is not a reason to this.d.fail plugin setup.
    }
  },

  startRescueTimer() {
    const interval = Number(this.options.rescueIntervalMs) || 60_000;
    this.rescueTimer = setInterval(() => void this.rescueStalled(), interval);
    this.rescueTimer.unref?.();
  },

  async rescueStalled() {
    for (const entry of this.registry) {
      const root = this.d.path.resolve(entry.root);
      try {
        const state = await this.d.loadState(root);
        if (state.status !== this.d.STATUS.RUNNING) continue;
        if (Date.now() - (state.last_prompt_at || 0) < 180_000) continue;
        if (this.busy.has(entry.sessionID)) continue;
        const session = await this.ctx.session.get({ sessionID: entry.sessionID });
        if (!session || session.outcome === "failed" || session.outcome === "interrupted") continue;
        if ((session.time?.busy ?? 0) > (session.time?.idle ?? 0)) continue;
        const key = this.d.promptKey("rescue", entry.sessionID);
        if (this.d.isDuplicatePrompt(state, key)) continue;
        state.last_prompt_at = Date.now();
        state.metrics = this.d.recordMetrics(state.metrics, { rescues: 1, recoveries: 1 });
        state.prompt_ledger = this.d.recordPrompt(state, {
          key,
          kind: "rescue",
          sessionID: entry.sessionID,
        });
        await this.saveStateSafe(root, state);
        await this.refreshBrief(entry.sessionID, root, state.last_checks ?? []);
        await this.ctx.session.prompt({
          sessionID: entry.sessionID,
          text: "[MISSION RESCUE] This session went quiet while the mission was still running. Continue from the durable state in .mission/.",
          delivery: "queue",
        });
        await this.journal(root, "rescue timer re-admitted a stalled turn");
      } catch {
        // A stale registry entry must never break the timer.
      }
    }
  },

  startEventRecovery() {
    const signal = this.controller.signal;
    void (async () => {
      try {
        for await (const event of this.ctx.event.subscribe({
          types: ["session.execution.failed", "session.execution.interrupted"],
          signal,
        })) {
          const sessionID = event?.data?.sessionID ?? event?.sessionID;
          if (!sessionID) continue;
          await this.handleFailure(
            sessionID,
            event?.data?.error ?? event?.error ?? new Error(event?.type ?? "execution failed")
          );
        }
      } catch {
        // Stream closed on dispose.
      }
    })();
  },

  async handleFailure(sessionID, error) {
    const root = this.rootFor(sessionID);
    if (!root) return;
    if (this.workers.has(sessionID) || this.knownWorkers.has(sessionID)) {
      const progress = await this.d.loadProgress(root);
      const worker = this.workers.get(sessionID);
      const owned =
        progress.find((p) => p.owner === sessionID) ??
        (worker ? progress.find((p) => p.id === worker.taskId) : null);
      if (owned) {
        this.d.fail(progress, owned.id, this.d.shortError(error), Date.now());
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
    if (state.failures >= (state.max_failures ?? 3)) {
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

    await this.rotateModel(sessionID, message);
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
      const candidate = this.pickFreeModel(catalog, current);
      if (candidate) {
        await this.ctx.session.switchModel({ sessionID, model: candidate });
        await this.d.appendJournal(
          this.rootFor(sessionID),
          `model rotated ${current?.providerID ?? "?"}/${current?.id ?? "?"} → ${candidate.providerID}/${candidate.id} after quota error`
        );
      }
    } catch {
      // Rotation is best-effort; the failure counter is the real backstop.
    }
  },
};
