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
    await this.recoverQueue();
  },

  async recoverStaleWorkers(root, state = null) {
    const progress = await this.d.loadProgress(root);
    if (progress.length === 0) return;
    const now = Date.now();
    const limit = this.taskAttemptLimit(state);
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
          now,
          limit
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
          t.status = this.d.retryable(progress, t.id, limit)
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

  async recoverFromError(sessionID, err) {
    const root = this.rootFor(sessionID);
    if (!root) return;
    try {
      const current = await this.d.loadState(root);
      if (current.status !== this.d.STATUS.RUNNING) return;
      await this.journal(root, `supervisor error: ${this.d.shortError(err)}`).catch(() => {});
      if (current.never_give_up) {
        current.status = this.d.STATUS.RUNNING;
        current.failures = 0;
        current.finish_reason = null;
        current.last_prompt_at = 0;
        await this.saveStateSafe(root, current);
        await this.notify(
          "supervisor-recovery",
          `Relentless mission recovered from: ${this.d.shortError(err)}`
        );
        this.scheduleLeadTick(sessionID);
        return;
      }
      current.status = this.d.STATUS.ABORTED;
      current.finish_reason = `supervisor error: ${this.d.shortError(err)}`;
      current.finished_at = new Date().toISOString();
      await this.saveStateSafe(root, current);
    } catch (inner) {
      // Keep the original failure visible even when the state file is unwritable.
      await this.journal(
        root,
        `supervisor error: ${this.d.shortError(err)} (recovery failed: ${this.d.shortError(inner)})`
      ).catch(() => {});
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
};
