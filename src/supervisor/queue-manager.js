// Queue manager: persistent, prioritized missions that survive restarts.

export const queueManager = {
  queuePath() {
    return this.d.path.join(this.missionsRoot ?? this.ctx.location.directory, this.d.QUEUE_FILE);
  },

  async loadQueue() {
    const entries = await this.d.readJson(this.queuePath(), []);
    return Array.isArray(entries) ? entries : [];
  },

  async saveQueue(entries) {
    await this.d.writeJsonAtomic(this.queuePath(), entries);
    return entries;
  },

  async enqueueMission(objective, priority = 0) {
    const entries = await this.loadQueue();
    const next = this.d.enqueue(entries, objective, priority);
    if (next.length === entries.length) return "Objective must be at least 3 characters.";
    await this.saveQueue(next);
    return `Queued #${next.find((e) => !entries.some((old) => old.id === e.id))?.id}: ${String(objective).trim().slice(0, 120)}`;
  },

  async recoverQueue() {
    const entries = await this.loadQueue();
    if (entries.length === 0) return;
    const alive = [];
    for (const entry of entries) {
      if (entry?.status !== "running" || !entry.sessionID) continue;
      const session = await this.ctx.session.get({ sessionID: entry.sessionID }).catch(() => null);
      if (session && session.outcome !== "failed" && session.outcome !== "interrupted")
        alive.push(entry.sessionID);
    }
    const recovered = this.d.requeueDead(entries, alive);
    if (JSON.stringify(recovered) !== JSON.stringify(entries)) await this.saveQueue(recovered);
  },

  async runQueue(limit = 0) {
    const entries = await this.loadQueue();
    const slots =
      Number(limit) > 0
        ? Math.trunc(Number(limit))
        : Math.max(0, (Number(this.options.parallelSlots) || 8) - this.d.runningCount(entries));
    const batch = this.d.nextBatch(entries, slots);
    if (batch.length === 0) {
      const stats = this.d.queueStats(entries);
      return `No queued missions to start (${stats.pending} pending, ${stats.running} running).`;
    }
    const ids = [];
    const errors = [];
    for (const entry of batch) {
      try {
        const launched = await this.launchMission(entry.objective);
        ids.push(launched.match(/→\s*([^:]+):/)?.[1]?.trim() ?? null);
      } catch (err) {
        errors.push(`${entry.id}: ${this.d.shortError(err)}`);
      }
    }
    let updated = this.d.markRunning(entries, batch.slice(0, ids.length), ids);
    for (const error of errors) {
      const id = error.split(":")[0];
      updated = this.d.markFinished(updated, id, "pending", error.slice(id.length + 2));
    }
    await this.saveQueue(updated);
    return `Started ${ids.length} queued mission(s)${errors.length ? `; ${errors.length} failed: ${errors.join("; ")}` : ""}.`;
  },

  async tickQueue() {
    const entries = await this.loadQueue();
    if (!entries.some((e) => e?.status === "pending")) return;
    const maxAttempts = Math.max(1, Number(this.options.maxQueueAttempts) || 3);
    const retryable = entries.map((e) =>
      e?.status === "pending" && (Number(e.attempts) || 0) >= maxAttempts
        ? { ...e, status: "failed", last_error: "queue attempt limit" }
        : e
    );
    if (JSON.stringify(retryable) !== JSON.stringify(entries)) await this.saveQueue(retryable);
    await this.runQueue();
  },

  startQueueTimer() {
    if (this.options.autoQueue !== true) return;
    const interval = Math.max(1000, Number(this.options.queueIntervalMs) || 30_000);
    this.queueTimer = setInterval(() => void this.tickQueue(), interval);
    this.queueTimer.unref?.();
  },
};
