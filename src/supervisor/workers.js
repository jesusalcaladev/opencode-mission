// workers mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { path, mkdir, readFile, nextStrategy, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const workers = {
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

  async runWorkers(leadID, root, state, tasks, workRoot) {
    const now = Date.now();
    const progress = await loadProgress(root);
    const open = tasks.filter(
      (t) => t.status !== TASK_STATUS.COMPLETED && retryable(progress, t.id) && !isLeased(progress, t.id, now),
    );
    if (!open.length || !this.enableWorkers) return { ran: false };
    const waves = wavesFor(open, this.maxWorkers);
    if (!waves.length) return { ran: false };
    const objective = objectiveOf(await this.readMission(root));
    const workerModel = this.options.model ?? this.pickFreeModel(await this.modelCatalog());
    let ran = false;

    for (const wave of waves) {
      const spawned = [];
      for (const task of wave) {
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
          await this.journal(root, `worker spawn failed for task ${task.id}: ${shortError(err)}`);
          continue;
        }
        if (!id) continue;
        this.bind(id, root, false);
        this.workers.set(id, { root, taskId: task.id, leadID, role: ROLE.IMPLEMENTER });
        this.roles.set(id, ROLE.IMPLEMENTER);
        this.knownWorkers.add(id);
        if (!this.briefs) this.briefs = new Map();
        this.briefs.set(id, workerBrief({ task, objective, workspace: workRoot }));
        spawned.push({ id, task });
      }
      if (!spawned.length) continue;
      ran = true;
      await appendJournal(
        root,
        `dispatching workers: ${spawned.map((w) => `#${w.task.id}`).join(", ")} · model ${workerModel ? `${workerModel.providerID}/${workerModel.id}` : "OpenCode default"}`,
      );
      await this.serialize(root, async () => {
        const s = await loadState(root);
        const leased = await loadProgress(root);
        const ttl = Number(state.lease_ms) || 300000;
        for (const w of spawned) {
          claim(leased, w.task.id, w.id, Date.now(), ttl);
        }
        s.worker_sessions = [...new Set([...(s.worker_sessions ?? []), ...spawned.map((w) => w.id)])];
        await Promise.all([this.saveProgressSafe(root, leased), this.saveStateSafe(root, s)]);
      });

      const current = await loadTasks(root);
      for (const w of spawned) {
        const t = current.find((x) => x.id === w.task.id);
        if (t) t.status = "in_progress";
      }
      await this.saveTasksSafe(root, current);
      await Promise.all(
        spawned.map((w) =>
          this.ctx.session.prompt({
            sessionID: w.id,
            text: workerPrompt({ task: w.task, objective, workspace: workRoot }),
            delivery: "queue",
          }),
        ),
      );
      await Promise.all(spawned.map((w) => this.waitWithTimeout(w.id, 120_000)));

      const fresh = await loadState(root);
      const leased = await loadProgress(root);
      const taskList = await loadTasks(root);
      for (const w of spawned) {
        const report = fresh.task_reports?.[String(w.task.id)];
        if (report && report.status !== "failed") {
          release(leased, w.task.id, TASK_STATUS.COMPLETED);
        } else {
          fail(leased, w.task.id, report?.summary ?? "no worker report", Date.now());
          const t = taskList.find((x) => x.id === w.task.id);
          if (t) t.status = retryable(leased, w.task.id) ? TASK_STATUS.PENDING : TASK_STATUS.FAILED;
        }
        this.workers.delete(w.id);
        this.roles.delete(w.id);
        this.bySession.delete(w.id);
        this.briefs?.delete(w.id);
      }
      await Promise.all([this.saveProgressSafe(root, leased), this.saveTasksSafe(root, taskList)]);
      await this.journal(root, reportsText(fresh.task_reports ?? {}));
    }
    return { ran };
  },

  async verify(root, workRoot) {
    const [criteria, stored] = await Promise.all([loadCriteria(root), loadTasks(root)]);
    let results = await runChecks(workRoot, criteria);
    const applied = applyTaskResults(stored, results);
    let tasks = applied.tasks;
    if (applied.changed) {
      await this.saveTasksSafe(root, tasks);
      results = await runChecks(workRoot, criteria);
    }
    return { results, tasks };
  },

  recordTurn(state, results, tasks, countTurn = true) {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    const progress = green > (state.best_green ?? 0) || done > (state.tasks_done ?? 0);
    state.failures = 0;
    if (countTurn) state.turn += 1;
    state.last_checks = results;
    state.best_green = Math.max(state.best_green ?? 0, green);
    state.tasks_done = done;
    state.strategy_tier = nextStrategy(state.strategy_tier, progress);
    if (progress) state.last_progress_turn = state.turn;
    return progress;
  },

  async journalTurn(root, state, results, tasks, decision, label = "turn") {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    await appendJournal(
      root,
      `${label} ${state.turn}: ${green}/${results.length} checks green, ${done}/${tasks.length} tasks done, tier ${state.strategy_tier}, $${state.cost_usd.toFixed(2)} → ${decision.type}${decision.reason ? `(${decision.reason})` : ""}`,
    );
  },

  async sessionCost(sessionID) {
    try {
      const messages = await this.ctx.session.context({ sessionID });
      let total = 0;
      for (const item of messages ?? []) {
        const info = item?.info ?? item;
        if (info?.role === "assistant" && Number.isFinite(info.cost)) total += info.cost;
      }
      return total;
    } catch {
      return null;
    }
  },

  async statusText(root) {
    const state = await loadState(root);
    const tasks = await loadTasks(root);
    const task = selectTask(tasks);
    const green = state.last_checks.filter((r) => r.ok).length;
    return [
      `Mission: ${root}`,
      `Status: ${state.status} · turn ${state.turn}/${state.max_turns} · cost $${state.cost_usd.toFixed(2)}/$${state.budget_usd.toFixed(2)}`,
      `Checks: ${green}/${state.last_checks.length} green · tasks: ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`,
      `Next task: ${task ? `#${task.id} ${task.subject}` : "none"}`,
      `Strategy tier: ${state.strategy_tier} · failures: ${state.failures ?? 0} · finish reason: ${state.finish_reason ?? "none"}`,
      `Chain: ${state.chain_index ?? 0}/${state.chain_total ?? 0} · extensions: ${state.extensions ?? 0}/${state.max_extensions ?? 3}`,
      `Workspace: ${this.effectiveRoot(root, state)}${state.worktree_branch ? ` (${state.worktree_branch})` : ""}`,
    ].join("\n");
  }
};
