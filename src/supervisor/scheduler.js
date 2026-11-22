// worker scheduler mixin — extracted from workers.js.
// All dependencies are reached through this.d (set by the Supervisor).

export const scheduler = {
  waitWithTimeout(sessionID, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      void Promise.resolve(this.ctx.session.wait({ sessionID })).then(finish).catch(finish);
    });
  },

  taskIsActive(root, taskId) {
    for (const worker of this.workers.values()) {
      if (worker.root === root && worker.taskId === taskId) return true;
    }
    return false;
  },

  scheduleLeadTick(leadID) {
    if (!leadID) return;
    if (!this.pendingTicks) this.pendingTicks = new Set();
    if (this.pendingTicks.has(leadID)) return;
    this.pendingTicks.add(leadID);
    const timer = setTimeout(() => {
      this.pendingTicks?.delete(leadID);
      this.timers.delete(timer);
      void this.handleIdle(leadID);
    }, 750);
    timer?.unref?.();
    this.timers.add(timer);
  },

  async watchWorker(w, leadID, root, state, workRoot) {
    const timeout = Number(state.worker_timeout_ms) || 1_800_000;
    const deadline = Date.now() + timeout;
    while (!this.controller.signal.aborted && Date.now() < deadline && this.workers.has(w.id)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer?.unref?.();
      });
      const fresh = await this.d.loadState(root);
      const report = fresh.task_reports?.[String(w.task.id)];
      const leased = await this.d.loadProgress(root);
      const lease = leased.find((p) => p.id === w.task.id);
      if (report || !lease || lease.lease_until <= Date.now()) {
        await this.finalizeWorker(w, leadID, root, state, workRoot);
        return;
      }
      const session = await this.ctx.session.get({ sessionID: w.id }).catch(() => null);
      if (session && (session.time?.idle ?? 0) > (session.time?.busy ?? 0)) {
        await this.finalizeWorker(w, leadID, root, state, workRoot);
        return;
      }
    }
    await this.finalizeWorker(w, leadID, root, state, workRoot);
  },
};
