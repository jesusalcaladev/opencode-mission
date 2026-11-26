// workers mixin — extracted from supervisor.js; behavior unchanged.

// A multi-day mission can spawn hundreds of short-lived agents. Keep only the
// recent history that the UI and recovery actually need.
const RUN_HISTORY_LIMIT = 200;

export const workers = {
  async runWorkers(leadID, root, state, tasks, workRoot) {
    const now = Date.now();
    const progress = await this.d.loadProgress(root);
    const attemptLimit = this.taskAttemptLimit(state);
    const open = tasks.filter(
      (t) =>
        t.status !== this.d.TASK_STATUS.COMPLETED &&
        this.d.retryable(progress, t.id, attemptLimit) &&
        !this.d.isLeased(progress, t.id, now) &&
        !this.taskIsActive(root, t.id)
    );
    if (!open.length || !this.enableWorkers) return { ran: false };
    const waves = this.d.wavesFor(open, this.maxWorkers);
    if (!waves.length) return { ran: false };
    const objective = this.d.objectiveOf(await this.readMission(root));
    const workerModel =
      this.modelForRole(this.d.ROLE.IMPLEMENTER) ?? this.pickFreeModel(await this.modelCatalog());
    let ran = false;

    for (const wave of waves) {
      // Recompute capacity per wave: roles and long-running workers from an
      // earlier wave may still be in flight.
      const capacity = Math.max(0, this.maxWorkers - this.activeWorkerCount(root));
      if (capacity === 0) break;
      const batch = wave.slice(0, Math.min(wave.length, capacity));
      const spawned = [];
      for (const task of batch) {
        const conflicts = this.d.lockFiles(this.fileLocks, task.id, task.files ?? []);
        if (conflicts.length) {
          await this.journal(
            root,
            `task #${task.id} skipped: files locked by another task (${conflicts.join(", ")})`
          );
          continue;
        }
        let id;
        try {
          const created = await this.ctx.session.create({
            parentID: leadID,
            title: `mission worker · task ${task.id}`,
            location: { directory: this.ctx.location.directory },
            model: workerModel,
          });
          id = created?.id ?? created?.data?.id;
        } catch (err) {
          this.d.unlockFiles(this.fileLocks, task.id);
          await this.journal(
            root,
            `worker spawn failed for task ${task.id}: ${this.d.shortError(err)}`
          );
          continue;
        }
        if (!id) {
          this.d.unlockFiles(this.fileLocks, task.id);
          continue;
        }
        this.bind(id, root, false);
        this.workers.set(id, { root, taskId: task.id, leadID, role: this.d.ROLE.IMPLEMENTER });
        this.roles.set(id, this.d.ROLE.IMPLEMENTER);
        this.knownWorkers.add(id);
        if (!this.briefs) this.briefs = new Map();
        this.briefs.set(id, this.d.workerBrief({ task, objective, workspace: workRoot }));
        spawned.push({ id, task });
      }
      if (!spawned.length) continue;
      ran = true;
      await this.d.appendJournal(
        root,
        `dispatching workers: ${spawned.map((w) => `#${w.task.id}`).join(", ")} · model ${workerModel ? `${workerModel.providerID}/${workerModel.id}` : "OpenCode default"}`
      );
      await this.serialize(root, async () => {
        const s = await this.d.loadState(root);
        const leased = await this.d.loadProgress(root);
        const ttl = Number(state.lease_ms) || 600000;
        for (const w of spawned)
          this.d.claim(leased, w.task.id, w.id, Date.now(), ttl, this.taskAttemptLimit(s));
        s.worker_sessions = [
          ...new Set([...(s.worker_sessions ?? []), ...spawned.map((w) => w.id)]),
        ].slice(-RUN_HISTORY_LIMIT);
        s.metrics = this.d.recordMetric(s.metrics, "agentsSpawned", spawned.length);
        s.agent_runs = [
          ...(s.agent_runs ?? []).filter((r) => !spawned.some((w) => w.id === r.sessionID)),
          ...spawned.map((w) => ({
            sessionID: w.id,
            role: this.d.ROLE.IMPLEMENTER,
            taskId: w.task.id,
            status: "running",
            started_at: Date.now(),
            last_heartbeat: Date.now(),
            model: workerModel ? `${workerModel.providerID}/${workerModel.id}` : "",
          })),
        ].slice(-RUN_HISTORY_LIMIT);
        await Promise.all([this.saveProgressSafe(root, leased), this.saveStateSafe(root, s)]);
      });

      const current = await this.d.loadTasks(root);
      for (const w of spawned) {
        const t = current.find((x) => x.id === w.task.id);
        if (t) t.status = this.d.TASK_STATUS.IN_PROGRESS;
      }
      await this.saveTasksSafe(root, current);
      const deliveries = await Promise.allSettled(
        spawned.map((w) =>
          this.ctx.session.prompt({
            sessionID: w.id,
            text: this.d.workerPrompt({ task: w.task, objective, workspace: workRoot }),
            delivery: "queue",
          })
        )
      );
      for (let i = 0; i < deliveries.length; i += 1) {
        if (deliveries[i].status === "rejected") {
          await this.journal(
            root,
            `worker prompt failed for #${spawned[i].task.id}: ${this.d.shortError(deliveries[i].reason)}; lease will be reclaimed`
          );
        }
      }

      // Short grace window: quick workers finish here. Long-running workers are
      // watched in the background so the lead session stays responsive.
      await Promise.all(spawned.map((w) => this.waitWithTimeout(w.id, 5000)));
      for (const w of spawned) await this.finalizeWorker(w, leadID, root, state, workRoot);
    }
    return { ran };
  },

  async finalizeWorker(w, leadID, root, state, workRoot) {
    const worker = this.workers.get(w.id);
    if (!worker) return;
    const fresh = await this.d.loadState(root);
    const leased = await this.d.loadProgress(root);
    const taskList = await this.d.loadTasks(root);
    const workerCost = await this.sessionCost(w.id).catch(() => null);
    const report = fresh.task_reports?.[String(w.task.id)];
    const session = await this.ctx.session.get({ sessionID: w.id }).catch(() => null);
    const lease = leased.find((p) => p.id === w.task.id);
    const leaseLive = lease && lease.lease_until > Date.now();
    const stillBusy = session && (session.time?.busy ?? 0) > (session.time?.idle ?? 0);
    if (!report && stillBusy && leaseLive) {
      void this.watchWorker(w, leadID, root, state, workRoot);
      return;
    }
    if (report && report.status !== "failed") {
      this.d.release(leased, w.task.id, this.d.TASK_STATUS.COMPLETED);
    } else {
      fresh.metrics = this.d.recordMetrics(fresh.metrics, { agentsFailed: 1, agentReclaims: 1 });
      await this.saveStateSafe(root, fresh);
      const limit = this.taskAttemptLimit(fresh);
      this.d.fail(leased, w.task.id, report?.summary ?? "no worker report", Date.now(), limit);
      const t = taskList.find((x) => x.id === w.task.id);
      if (t)
        t.status = this.d.retryable(leased, w.task.id, limit)
          ? this.d.TASK_STATUS.PENDING
          : this.d.TASK_STATUS.FAILED;
    }
    await this.serialize(root, async () => {
      const s = await this.d.loadState(root);
      s.agent_runs = (s.agent_runs ?? []).map((r) =>
        r.sessionID === w.id
          ? { ...r, status: "done", cost: Math.max(Number(r.cost) || 0, workerCost ?? 0) }
          : r
      );
      if (workerCost !== null)
        s.cost_usd = this.d.applyCost(
          s,
          this.missionCostTotal(s, this.generationCosts?.get(root) ?? 0)
        );
      await this.saveStateSafe(root, s);
    });
    this.d.unlockFiles(this.fileLocks, w.task.id);
    this.workers.delete(w.id);
    this.roles.delete(w.id);
    this.bySession.delete(w.id);
    this.briefs?.delete(w.id);
    this.knownWorkers.delete(w.id);
    await Promise.all([this.saveProgressSafe(root, leased), this.saveTasksSafe(root, taskList)]);
    await this.journal(root, this.d.reportsText(fresh.task_reports ?? {}));
    if (report && report.status !== "failed") this.scheduleLeadTick(leadID);
  },

  recordTurn(state, results, tasks, countTurn = true) {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    state.metrics = this.d.recordMetrics(state.metrics, {
      turns: countTurn ? 1 : 0,
      checksRun: results.length,
      checksGreen: green,
      checksRed: results.length - green,
      tasksCompleted: done,
    });
    const progress = green > (state.best_green ?? 0) || done > (state.tasks_done ?? 0);
    state.failures = 0;
    if (countTurn) state.turn += 1;
    state.last_checks = results;
    state.best_green = Math.max(state.best_green ?? 0, green);
    state.tasks_done = done;
    state.stall_turns = progress ? 0 : (state.stall_turns ?? 0) + 1;
    state.strategy_tier = this.d.nextStrategy(state.strategy_tier, progress);
    if (state.stall_turns >= 3 && state.strategy_tier < 3) {
      state.strategy_tier = 3;
      state.last_progress_turn = state.turn - 3;
    }
    if (progress) state.last_progress_turn = state.turn;
    return progress;
  },

  async journalTurn(root, state, results, tasks, decision, label = "turn") {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    await this.d.appendJournal(
      root,
      `${label} ${state.turn}: ${green}/${results.length} checks green, ${done}/${tasks.length} tasks done, tier ${state.strategy_tier}, $${state.cost_usd.toFixed(2)} → ${decision.type}${decision.reason ? `(${decision.reason})` : ""}`
    );
  },

  async sessionCost(sessionID) {
    try {
      const messages = await this.ctx.session.context({ sessionID });
      return this.d.costFromContext(messages);
    } catch {
      return null;
    }
  },

  async statusText(root) {
    const state = await this.d.loadState(root);
    const tasks = await this.d.loadTasks(root);
    const task = this.d.selectTask(tasks);
    const green = state.last_checks.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    const pct =
      state.last_checks.length > 0
        ? green / state.last_checks.length
        : tasks.length > 0
          ? done / tasks.length
          : 0;
    const filled = Math.max(0, Math.min(10, Math.round(pct * 10)));
    const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
    return [
      `Mission: ${root}`,
      `Progress: ${bar} ${green}/${state.last_checks.length} checks · ${done}/${tasks.length} tasks · improve cycles ${state.improve_cycles ?? 0}`,
      `Status: ${state.status} · turn ${state.turn}/${state.max_turns} · cost $${state.cost_usd.toFixed(2)}/$${state.budget_usd.toFixed(2)}`,
      `Checks: ${green}/${state.last_checks.length} green · tasks: ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`,
      `Next task: ${task ? `#${task.id} ${task.subject}` : "none"}`,
      `Strategy tier: ${state.strategy_tier} · failures: ${state.failures ?? 0} · finish reason: ${state.finish_reason ?? "none"}`,
      `Chain: ${state.chain_index ?? 0}/${state.chain_total ?? 0} · extensions: ${state.extensions ?? 0}/${state.max_extensions ?? 3}`,
      `Workspace: ${this.effectiveRoot(root, state)}${state.worktree_branch ? ` (${state.worktree_branch})` : ""}`,
    ].join("\n");
  },
};
