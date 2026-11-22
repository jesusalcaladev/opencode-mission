// recovery mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { os, writeFile, combineReviews, allGreen, workspaceStamp, criteriaSignature, upsertFact, renderFacts, loadProjectInstructions, path, mkdir, readFile, nextStrategy, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const recovery = {
  async init() {
    const saved = await this.ctx.storage.get(REGISTRY_KEY).catch(() => []);
    this.registry = Array.isArray(saved)
      ? saved.filter((e) => e && typeof e.sessionID === "string" && typeof e.root === "string")
      : [];
    for (const entry of this.registry) {
      const root = path.resolve(entry.root);
      this.bind(entry.sessionID, root);
      const state = await loadState(root);
      for (const id of state.worker_sessions ?? []) this.knownWorkers.add(id);
      await this.maybeAutoResume(entry.sessionID, root);
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
    this.registry.push({ sessionID, root });
    await this.ctx.storage.set(REGISTRY_KEY, this.registry).catch(() => {});
  },

  async maybeAutoResume(sessionID, root) {
    try {
      const session = await this.ctx.session.get({ sessionID });
      if (!session || session.outcome === "failed" || session.outcome === "interrupted") return;
      const busy = (session.time?.busy ?? 0) > (session.time?.idle ?? 0);
      if (busy) return;
      const state = await loadState(root);
      if (state.status !== STATUS.RUNNING) return;
      if (Date.now() - (state.last_prompt_at || 0) < AUTO_RESUME_AGE_MS) return;

      await this.journal(root, `auto-resume after plugin reload (session ${sessionID})`);
      state.failures = 0;
      state.last_prompt_at = Date.now();
      await this.saveStateSafe(root, state);
      await this.refreshBrief(sessionID, root, state.last_checks ?? []);
      await this.ctx.session.prompt({
        sessionID,
        text: "[MISSION RESUME] The service restarted. Continue from the mission state on disk.",
        delivery: "queue",
      });
    } catch {
      // A stale registry entry is not a reason to fail plugin setup.
    }
  },

  startRescueTimer() {
    const interval = Number(this.options.rescueIntervalMs) || 60_000;
    this.rescueTimer = setInterval(() => void this.rescueStalled(), interval);
    this.rescueTimer.unref?.();
  },

  async rescueStalled() {
    for (const entry of this.registry) {
      const root = path.resolve(entry.root);
      try {
        const state = await loadState(root);
        if (state.status !== STATUS.RUNNING) continue;
        if (Date.now() - (state.last_prompt_at || 0) < 180_000) continue;
        if (this.busy.has(entry.sessionID)) continue;
        const session = await this.ctx.session.get({ sessionID: entry.sessionID });
        if (!session || session.outcome === "failed" || session.outcome === "interrupted") continue;
        if ((session.time?.busy ?? 0) > (session.time?.idle ?? 0)) continue;
        state.last_prompt_at = Date.now();
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
          await this.handleFailure(sessionID, event?.data?.error ?? event?.error ?? new Error(event?.type ?? "execution failed"));
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
      const progress = await loadProgress(root);
      const worker = this.workers.get(sessionID);
      const owned = progress.find((p) => p.owner === sessionID) ?? (worker ? progress.find((p) => p.id === worker.taskId) : null);
      if (owned) {
        fail(progress, owned.id, shortError(error), Date.now());
        await this.saveProgressSafe(root, progress);
        await this.journal(root, `worker failure on task #${owned.id}: ${shortError(error)} → lease released for retry`);
      }
      return;
    }
    const state = await loadState(root);
    if (state.status !== STATUS.RUNNING || this.busy.has(sessionID)) return;

    // OpenCode can emit both `failed` and `interrupted` for one turn. Count
    // only one failure per short window so a single error cannot abort a mission.
    const now = Date.now();
    if (state.last_failure_at && now - state.last_failure_at < 1500) return;
    state.last_failure_at = now;

    const message = shortError(error);
    state.failures = (state.failures ?? 0) + 1;
    await this.journal(root, `execution failure ${state.failures}/${state.max_failures}: ${message}`);
    if (state.failures >= (state.max_failures ?? 3)) {
      await this.finish(root, sessionID, state, "aborted", "repeated-execution-failure", `after ${state.failures} failures: ${message}`);
      return;
    }

    await this.rotateModel(sessionID, message);
    state.last_prompt_at = Date.now();
    await this.saveStateSafe(root, state);

    const delayMs = Math.min(2000 * 2 ** (state.failures - 1), 30_000);
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      try {
        const fresh = await loadState(root);
        if (fresh.status !== STATUS.RUNNING) return;
        await this.journal(root, `retrying after ${delayMs}ms backoff`);
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
        await appendJournal(this.rootFor(sessionID), `model rotated to ${fallback.providerID}/${fallback.id} (configured fallback)`);
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
        await appendJournal(
          this.rootFor(sessionID),
          `model rotated ${current?.providerID ?? "?"}/${current?.id ?? "?"} → ${candidate.providerID}/${candidate.id} after quota error`,
        );
      }
    } catch {
      // Rotation is best-effort; the failure counter is the real backstop.
    }
  },

  async modelCatalog() {
    try {
      const listed = await this.ctx.model.list();
      let models = Array.isArray(listed) ? listed : (listed?.data ?? []);
      if (!Array.isArray(models) && listed && typeof listed === "object") {
        models = Object.values(listed).flatMap((v) => (Array.isArray(v) ? v : []));
      }
      return models.filter((m) => m?.id && m?.providerID);
    } catch {
      return [];
    }
  },

  pickFreeModel(models, exclude) {
    const free = models.filter(
      (m) =>
        (m.cost?.[0]?.output ?? 0) === 0 &&
        m.capabilities?.tools !== false &&
        !(m.id === exclude?.id && m.providerID === exclude?.providerID),
    );
    free.sort((a, b) => Number(b.providerID === "opencode") - Number(a.providerID === "opencode"));
    const chosen = free[0];
    return chosen ? { providerID: chosen.providerID, id: chosen.id } : undefined;
  },

  async pickPlannerModel() {
    if (this.options.plannerModel) return this.options.plannerModel;
    return this.pickFreeModel(await this.modelCatalog());
  },

  async ensureWorkingModel(sessionID, root) {
    if (this.options.model) {
      await this.ctx.session.switchModel({ sessionID, model: this.options.model });
      if (root) await this.journal(root, `model configured: ${this.options.model.providerID}/${this.options.model.id}`);
      return this.options.model;
    }
    const catalog = await this.modelCatalog();
    const session = await this.ctx.session.get({ sessionID }).catch(() => null);
    const current = session?.model;
    if (current) {
      const info = catalog.find((m) => m.id === current.id && m.providerID === current.providerID);
      if (info && (info.cost?.[0]?.output ?? 0) === 0) return current;
    }
    const free = this.pickFreeModel(catalog, current);
    if (!free) return undefined;
    try {
      await this.ctx.session.switchModel({ sessionID, model: free });
      if (root) await this.journal(root, `model auto-selected: ${free.providerID}/${free.id}`);
    } catch {
      return undefined;
    }
    return free;
  },

  /// Cheap/fast models for read-only roles, a stronger one for implementers.
  modelForRole(role) {
    const byRole = this.options.modelsByRole ?? this.options.models_by_role ?? {};
    if (byRole[role]) return byRole[role];
    if (role === "implementer" && this.options.model) return this.options.model;
    if (this.options.fastModel) return this.options.fastModel;
    return this.options.model ?? undefined;
  }
};
