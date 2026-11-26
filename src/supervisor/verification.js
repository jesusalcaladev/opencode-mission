// Verification mixin: the only place that turns real check results into task
// completion. Extracted from workers.js to keep both files under the size cap.

export const verification = {
  async verify(root, workRoot) {
    const [criteria, stored, cachedState] = await Promise.all([
      this.d.loadCriteria(root),
      this.d.loadTasks(root),
      this.d.loadState(root),
    ]);
    const stamp = await this.d.workspaceStamp(workRoot);
    let results = await this.d.runChecks(workRoot, criteria, {
      stamp,
      cache: cachedState.check_cache,
      strict: cachedState.strict_checks === true,
      sandbox: cachedState.sandbox,
    });
    const baseline = this.d.captureBaseline(results, cachedState.check_baseline);
    const applied = this.d.applyTaskResults(stored, results, baseline);
    const tasks = applied.tasks;
    if (applied.changed) {
      const reopened = [];
      for (const task of tasks) {
        const before = stored.find((t) => t.id === task.id);
        if (task.status !== this.d.TASK_STATUS.COMPLETED || before?.status === task.status)
          continue;
        const check = criteria.checks.find((c) => c.id === task.verify);
        const result = results.find((r) => r.id === task.verify);
        const mutation = await this.runMutationCheck(root, workRoot, cachedState, task, check);
        if (!mutation.ok) {
          task.status = this.d.TASK_STATUS.PENDING;
          reopened.push(task.id);
        }
        if (!result?.ok) break;
      }
      if (reopened.length) {
        const leased = await this.d.loadProgress(root);
        for (const id of reopened) this.d.release(leased, id, this.d.TASK_STATUS.PENDING);
        await this.saveProgressSafe(root, leased);
      }
      await this.saveTasksSafe(root, tasks);
      results = await this.d.runChecks(workRoot, criteria, {
        stamp,
        cache: null,
        strict: cachedState.strict_checks === true,
        sandbox: cachedState.sandbox,
      });
    }
    // Reload inside the lock: a worker may have written a report or released a
    // lease while the checks were running. Re-saving the state we loaded at
    // the start would silently drop that update.
    await this.serialize(root, async () => {
      const fresh = await this.d.loadState(root);
      fresh.check_cache = { stamp, signature: this.d.criteriaSignature(criteria.checks), results };
      fresh.check_baseline = baseline;
      await this.saveStateSafe(root, fresh);
    });
    return { results, tasks, baseline };
  },
};
