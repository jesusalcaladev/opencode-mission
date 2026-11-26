// Lead-only tool: create a verifiable task and dispatch a subagent for it.

export const spawnTools = {
  async toolSpawn(sessionID, input = {}) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    if (this.workers.has(sessionID) || this.knownWorkers.has(sessionID))
      return "Only the lead agent may spawn subagents.";
    if (!this.enableWorkers) return "Subagents are disabled (enableWorkers: false).";
    const subject = String(input.subject ?? "")
      .trim()
      .slice(0, 140);
    if (subject.length < 3) return "A subject of at least 3 characters is required.";
    const files = Array.isArray(input.files)
      ? [...new Set(input.files.slice(0, 20).map((f) => String(f).replace(/^\.\//, "")))]
      : [];
    const criteria = await this.d.loadCriteria(root);
    const verify = String(input.verify ?? "").trim();
    if (verify && !criteria.checks.some((c) => c.id === verify))
      return `Unknown check id: ${verify}.`;
    const prompt = String(input.prompt ?? "")
      .trim()
      .slice(0, 2000);

    const stored = await this.d.loadTasks(root);
    const progress = await this.d.loadProgress(root);
    const id = stored.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
    const task = {
      id,
      subject,
      files,
      status: this.d.TASK_STATUS.PENDING,
      blocked_by: [],
      verify,
      milestone: "spawned",
    };
    stored.push(task);
    progress.push({
      id,
      subject,
      status: this.d.TASK_STATUS.PENDING,
      owner: null,
      attempts: 0,
      lease_until: 0,
      last_error: "",
      verify,
    });
    await Promise.all([this.saveTasksSafe(root, stored), this.saveProgressSafe(root, progress)]);
    await this.journal(root, `lead spawned verifiable task #${id}: ${subject}`);
    if (prompt) await this.journal(root, `spawn prompt for #${id}: ${prompt}`);
    const state = await this.d.loadState(root);
    const workRoot = this.effectiveRoot(root, state);
    const outcome = await this.runWorkers(sessionID, root, state, stored, workRoot);
    return `Spawned task #${id}${outcome.ran ? " and dispatched a worker" : "; it will be dispatched at the next idle boundary"}.`;
  },
};
