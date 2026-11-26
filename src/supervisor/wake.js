// WAKE watcher mixin: consumes external watchdog requests and re-admits the
// lead. Only this process is allowed to prompt a session.

export const wake = {
  startWakeWatcher() {
    const interval = Number(this.options.wakeIntervalMs) || 15_000;
    this.wakeTimer = setInterval(() => void this.wakeStalled(), interval);
    this.wakeTimer.unref?.();
  },

  async wakeStalled() {
    for (const entry of this.registry) {
      const root = this.d.path.resolve(entry.root);
      try {
        const wakeFile = this.d.path.join(root, ".mission", this.d.WAKE_FILE);
        let marker = false;
        try {
          await this.d.access(wakeFile);
          marker = true;
        } catch {
          // No external wake request.
        }
        const state = await this.d.loadState(root);
        if (state.status !== this.d.STATUS.RUNNING) continue;
        if (marker && !this.d.needsWake(state)) {
          await this.d.unlink(wakeFile).catch(() => {});
          continue;
        }
        if (!marker && !this.d.needsWake(state)) continue;
        if (this.busy.has(entry.sessionID)) continue;
        const session = await this.ctx.session
          .get({ sessionID: entry.sessionID })
          .catch(() => null);
        if (!session || session.outcome === "failed" || session.outcome === "interrupted") continue;
        if ((session.time?.busy ?? 0) > (session.time?.idle ?? 0)) continue;
        const key = this.d.promptKey("wake", entry.sessionID);
        if (this.d.isDuplicatePrompt(state, key)) continue;
        if (marker) await this.d.unlink(wakeFile).catch(() => {});
        state.prompt_ledger = this.d.recordPrompt(state, {
          key,
          kind: "wake",
          sessionID: entry.sessionID,
        });
        state.last_prompt_at = Date.now();
        state.metrics = this.d.recordMetric(state.metrics, { rescues: 1, recoveries: 1 });
        await this.saveStateSafe(root, state);
        await this.refreshBrief(entry.sessionID, root, state.last_checks ?? []);
        await this.ctx.session.prompt({
          sessionID: entry.sessionID,
          text: "[MISSION WAKE] An external watchdog saw this mission running and quiet. Continue from the durable state in .mission/.",
          delivery: "queue",
        });
        await this.journal(
          root,
          marker
            ? "external WAKE re-admitted a stalled turn"
            : "wake watcher re-admitted a quiet turn"
        );
      } catch {
        // A stale registry entry must never break the timer.
      }
    }
  },
};
