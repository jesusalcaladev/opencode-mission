// lifecycle mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { allGreen, workspaceStamp, criteriaSignature, upsertFact, renderFacts, loadProjectInstructions, path, mkdir, readFile, nextStrategy, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const lifecycle = {
  async start(sessionID, target, options = {}) {
    const root = path.resolve(target);
    await ensureMission(root, options);
    const state = await loadState(root);
    state.status = STATUS.RUNNING;
    state.session_id = sessionID;
    state.finished_at = null;
    state.finish_reason = null;
    state.last_verdict = null;
    state.failures = 0;
    state.chain_total = parseRoadmap(await loadRoadmap(root)).length;
    state.started_at = state.started_at || new Date().toISOString();
    state.last_prompt_at = Date.now();

    const tasks0 = await loadTasks(root);
    const progress0 = await loadProgress(root);
    if (progress0.length === 0 && tasks0.length > 0) await this.saveProgressSafe(root, fromTasks(tasks0));

    if (state.isolation === "worktree" && !state.worktree_root) {
      const wt = await createWorktree(root, String(state.id ?? "mission"));
      if (wt.ok) {
        state.worktree_root = wt.root;
        state.worktree_branch = wt.branch;
        await this.journal(root, `isolated in worktree ${wt.root} (${wt.branch})`);
      } else {
        await this.journal(root, `worktree isolation requested but unavailable: ${wt.reason}`);
      }
    }

    const workRoot = this.effectiveRoot(root, state);
    const integrity = await checkTestIntegrity(workRoot, state.test_hashes);
    state.test_hashes = integrity.current;
    await this.saveStateSafe(root, state);

    this.bind(sessionID, root);
    await this.persistBinding(sessionID, root);
    await this.journal(root, `session ${sessionID} — mission started (turn ${state.turn + 1}/${state.max_turns})`);

    let dispatched = false;
    if (options.autoDispatch) await this.ensureWorkingModel(sessionID, root);
    if (options.autoDispatch && this.enableWorkers) {
      const tasks = await loadTasks(root);
      const outcome = await this.runWorkers(sessionID, root, state, tasks, workRoot);
      dispatched = outcome.ran;
    }
    await this.refreshBrief(sessionID, root, state.last_checks ?? []);

    const missionText = await this.readMission(root);
    const prompt = dispatched
      ? `[MISSION COORDINATOR]\n${objectiveOf(missionText)}\n\nWorkspace: ${workRoot}\nParallel workers are already handling the open tasks. Do NOT duplicate their work. Use mission_status / mission_check to watch progress; call mission_verdict only after every check is green.`
      : `[MISSION START]\n${objectiveOf(missionText)}\n\nWorkspace: ${workRoot}\nUse mission_write to create files, mission_check after every change, and mission_verdict only when all checks are green. Begin now.`;
    await this.ctx.session.prompt({ sessionID, text: prompt, delivery: "queue" });
    return this.statusText(root);
  },

  async writePlanFiles(root, plan, original, force = false) {
    const dir = path.join(root, ".mission");
    await mkdir(path.join(dir, "evidence"), { recursive: true });
    const s = plan.settings;
    const frontmatter = [
      "---",
      `id: mission-${Date.now().toString(36)}`,
      `max_turns: ${s.max_turns}`,
      `budget_usd: ${s.budget_usd}`,
      `stall_after_turns: 2`,
      `handoff_every_turns: ${s.handoff_every_turns}`,
      `max_failures: ${s.max_failures}`,
      `max_wallclock_min: ${s.max_wallclock_min ?? 0}`,
      `lease_ms: ${s.lease_ms ?? 300000}`,
      `continuous_improvement: ${s.continuous_improvement ?? true}`,
      `max_improve_cycles: ${s.max_improve_cycles ?? 5}`,
      `min_impact: ${s.min_impact ?? "medium"}`,
      `max_writes: ${s.max_writes ?? 0}`,
      `isolation: ${s.isolation}`,
      "---",
      plan.objective,
      "",
      `Original request: ${original}`,
      "",
      "Completion is defined ONLY by criteria.json. All tasks must be verified by the harness.",
    ].join("\n");
    await writeTextAtomic(path.join(dir, "mission.md"), `${frontmatter}\n`);
    await writeJsonAtomic(path.join(dir, "criteria.json"), { version: VERSION, checks: plan.checks });
    const planned = plan.tasks.map((t) => ({ ...t, status: "pending" }));
    await writeJsonAtomic(path.join(dir, "tasks.json"), { version: VERSION, tasks: planned });
    // progress.json may have been seeded by ensureMission from the placeholder
    // task. Keep leases in sync with the actual plan.
    await this.saveProgressSafe(root, fromTasks(planned));
    const state = await loadState(root);
    Object.assign(state, s, {
      status: STATUS.RUNNING,
      turn: 0,
      cost_usd: 0,
      failures: 0,
      writes: 0,
      last_replan_turn: 0,
      best_green: 0,
      tasks_done: 0,
      last_checks: [],
      last_verdict: null,
      test_hashes: null,
      last_commit: null,
      session_id: null,
      started_at: null,
      finished_at: null,
      finish_reason: null,
      task_reports: {},
      worker_sessions: [],
    });
    await this.saveStateSafe(root, state);
  },

  async planAndStart(sessionID, objective) {
    const clean = String(objective ?? "").trim();
    if (clean.length < 3) return "Give an objective after /mission start, e.g. /mission start build a tiny CLI with three tests";

    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-") || "mission";
    const base = this.missionsRoot ?? path.join(this.ctx.location.directory, "missions");
    const root = path.join(base, `${slug}-${Date.now().toString(36)}`);
    await ensureMission(root, { objective: clean });

    const generated = await createPlan(clean, root, this.options.generate ?? (async () => ""), {
      model: await this.pickPlannerModel(),
      attempts: 2,
    });
    await this.writePlanFiles(root, generated.plan, clean);
    const status = await this.start(sessionID, root, { objective: clean, autoDispatch: true });
    const waves = wavesFor(generated.plan.tasks, this.maxWorkers);
    return [
      status,
      `Plan source: ${generated.source}${generated.errors?.length ? ` (${generated.errors.join("; ")})` : ""}`,
      `Objective: ${generated.plan.objective}`,
      `Criteria: ${generated.plan.checks.map((c) => c.id).join(", ")}`,
      `${generated.plan.tasks.length} task(s) scheduled in ${waves.length} parallel wave(s) · max ${this.maxWorkers} workers`,
      `Workspace: ${root}`,
    ].join("\n");
  },

  async resume(sessionID, target) {
    const root = path.resolve(target ?? this.rootFor(sessionID) ?? ".");
    const state = await loadState(root);
    if (state.status === STATUS.COMPLETE) return "Mission already complete. Nothing to resume.";
    return this.start(sessionID, root);
  },

  async stop(sessionID, reason = "manual stop") {
    const root = this.rootFor(sessionID);
    if (!root) return "No mission is active in this session.";
    const state = await loadState(root);
    await this.finish(root, sessionID, state, "aborted", reason, state.summary ?? "");
    return `Mission stopped (${reason}). State kept in ${path.join(root, ".mission", "state.json")}.`;
  },

  async finish(root, sessionID, state, status, reason, summary) {
    state.status = status;
    state.finished_at = new Date().toISOString();
    state.finish_reason = reason;
    state.summary = summary ?? "";
    await this.saveStateSafe(root, state);
    await this.journal(root, `mission ${status}: ${reason}`);
    const label = status === STATUS.COMPLETE ? "MISSION COMPLETE" : "MISSION STOPPED";
    const text = `[${label}] ${reason}${state.unblock ? `. Unblock: ${state.unblock}` : ""}. Mission state: ${path.join(root, ".mission")}`;
    await this.ctx.session.synthetic({ sessionID, text }).catch(() => {});
    await this.notify(label, `${text}\nworkspace: ${root}`);
    if (status === STATUS.COMPLETE && this.enableChaining) {
      setImmediate(() => {
        void this.continueChain(root, sessionID).catch((err) => {
          void this.journal(root, `chain failed: ${shortError(err)}`).catch(() => {});
        });
      });
    }
  },

  async continueChain(root, sessionID) {
    const roadmapText = await loadRoadmap(root);
    const items = parseRoadmap(roadmapText);
    if (items.length === 0) return false;
    const item = nextItem(items);
    if (!item) {
      await this.journal(root, "chain exhausted: all roadmap items are done");
      return false;
    }
    const plan = fallbackPlan(item.title, root);
    await this.writePlanFiles(root, plan, item.title, true);
    const state = await loadState(root);
    Object.assign(state, {
      session_id: sessionID,
      started_at: new Date().toISOString(),
      chain_index: (state.chain_index ?? 0) + 1,
      chain_total: items.length,
    });
    await Promise.all([this.saveStateSafe(root, state), saveRoadmap(root, markItemDone(roadmapText, item.id))]);
    await this.journal(root, `chain: starting mission ${state.chain_index}/${items.length} — ${item.title}`);
    await this.refreshBrief(sessionID, root, []);
    await this.ctx.session.prompt({
      sessionID,
      text: `[MISSION CHAIN] Mission ${state.chain_index}/${items.length}: ${item.title}\nDistilled memory from previous missions is in your brief. Continue from disk state; do not restart from scratch.`,
      delivery: "queue",
    });
    return true;
  },

  async notify(kind, text) {
    const url = this.options.notifyUrl ?? process.env.MISSION_WEBHOOK_URL;
    if (!url) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, text, at: new Date().toISOString() }),
      });
    } catch {
      // A broken webhook must never stop a mission.
    }
  }
};
