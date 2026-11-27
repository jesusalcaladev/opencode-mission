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
    // A pre-existing green suite may only be credited when the worker actually
    // changed something in the workspace (mission_write counts writes). Without
    // this, "npm test was already green" would be reported as completed work.
    const reportedIDs = new Set(
      (cachedState.writes ?? 0) > 0
        ? Object.entries(cachedState.task_reports ?? {})
            .filter(([, report]) => report?.status === "done")
            .map(([id]) => Number(id))
        : []
    );
    const applied = this.d.applyTaskResults(stored, results, baseline, {
      reportedIDs,
      reopenRed: true,
    });
    const tasks = applied.tasks;
    // Publish each newly verified task, not just "some progress this turn".
    // A large mission cannot be deployed if the harness never checkpointed the
    // exact files the worker was assigned.
    const newly = tasks.filter(
      (t) =>
        t.status === this.d.TASK_STATUS.COMPLETED &&
        stored.find((s) => s.id === t.id)?.status !== this.d.TASK_STATUS.COMPLETED
    );
    const reopened = [];
    const owned = [...new Set(tasks.flatMap((t) => t.files ?? []))];
    const commits = {};
    // A plan made only of verifier tasks owns no files; there is nothing to
    // checkpoint. Mark publication as satisfied so the deploy gate cannot stall.
    let lastCommit = owned.length ? null : { ok: true, sha: "", reason: "no mission-owned paths" };
    for (const task of newly) {
      const paths = task.files?.length ? task.files : owned;
      let outcome = await this.serialize(root, () =>
        this.d.gitCommit(
          workRoot,
          `mission(${cachedState.id ?? "mission"}): task #${task.id} verified`,
          paths
        )
      );
      // A workspace without git has no artefact to publish; a failed commit
      // there must not leave a large mission stuck at deploy-pending forever.
      if (!outcome.ok && /not a git repository|no mission-owned paths/i.test(outcome.reason ?? ""))
        outcome = { ok: true, sha: "", reason: outcome.reason };
      commits[task.id] = { ok: outcome.ok, sha: outcome.sha ?? "", reason: outcome.reason ?? "" };
      if (outcome.ok) lastCommit = outcome;
      await this.journal(
        root,
        `task #${task.id} checkpoint: ${outcome.ok ? (outcome.sha ?? "no changes") : outcome.reason}`
      );
    }
    if (applied.changed) {
      for (const task of tasks) {
        const before = stored.find((s) => s.id === task.id);
        if (
          before?.status === this.d.TASK_STATUS.COMPLETED &&
          task.status !== this.d.TASK_STATUS.COMPLETED
        )
          reopened.push(task.id);
      }
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
      await this.saveTasksSafe(root, tasks);
      // Keep progress.json (leases/attempts) in step with tasks.json. Without
      // this the TUI showed 0/N while the harness had already credited tasks.
      const leased = await this.d.loadProgress(root);
      let progressChanged = false;
      for (const task of tasks) {
        if (task.status !== this.d.TASK_STATUS.COMPLETED) continue;
        const entry = leased.find((p) => Number(p?.id) === Number(task.id));
        if (entry && entry.status !== this.d.TASK_STATUS.COMPLETED) {
          this.d.release(leased, task.id, this.d.TASK_STATUS.COMPLETED);
          progressChanged = true;
        }
      }
      if (reopened.length) {
        for (const id of [...new Set(reopened)])
          this.d.release(leased, id, this.d.TASK_STATUS.PENDING);
        progressChanged = true;
      }
      if (progressChanged) await this.saveProgressSafe(root, leased);
      // Bookkeeping changed task ownership; execute the criteria again instead
      // of trusting a cached green that may belong to the previous state.
      results = await this.d.runChecks(workRoot, criteria, {
        stamp,
        strict: cachedState.strict_checks === true,
        sandbox: cachedState.sandbox,
      });
    }
    // Reload inside the lock: a worker may have written a report or released a
    // lease while the checks were running. Re-saving the state we loaded at
    // the start would silently drop that update.
    await this.serialize(root, async () => {
      const fresh = await this.d.loadState(root);
      for (const id of reopened) if (fresh.task_reports) delete fresh.task_reports[String(id)];
      fresh.check_cache = {
        stamp,
        signature: this.d.criteriaSignature(criteria.checks, {
          strict: cachedState.strict_checks === true,
          sandbox: cachedState.sandbox,
        }),
        results,
      };
      fresh.check_baseline = baseline;
      if (newly.length || Object.keys(commits).length || fresh.require_deploy) {
        const evidence = fresh.require_deploy
          ? this.d.deploymentVerified({
              criteria,
              results,
              tasks,
              commit: lastCommit ?? fresh.deploy?.lastCommit ?? null,
            })
          : null;
        fresh.deploy = {
          ...(fresh.deploy ?? {}),
          ...(evidence ?? {}),
          commits: { ...(fresh.deploy?.commits ?? {}), ...commits },
          lastCommit: lastCommit ?? fresh.deploy?.lastCommit ?? null,
        };
      }
      await this.saveStateSafe(root, fresh);
    });
    return { results, tasks, baseline, commit: lastCommit };
  },
};
