// intelligence mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { os, writeFile, combineReviews, allGreen, workspaceStamp, criteriaSignature, upsertFact, renderFacts, loadProjectInstructions, path, mkdir, readFile, nextStrategy, parseReview, replanPrompt, stageFor, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const intelligence = {
  async readMission(root) {
    return readFile(path.join(root, ".mission", "mission.md"), "utf8").catch(() => "");
  },

  inject(event) {
    const root = this.rootFor(event.sessionID);
    if (!root) return;
    const brief = this.briefs?.get(event.sessionID);
    if (brief) event.system.push({ type: "text", text: brief });
  },

  async refreshBrief(sessionID, root, results) {
    const [missionText, state, tasks, journal, memory, summary, progress, instructions] = await Promise.all([
      this.readMission(root),
      loadState(root),
      loadTasks(root),
      readJournal(root),
      loadMemory(root),
      loadSummary(root),
      loadProgress(root),
      loadProjectInstructions(null, root),
    ]);
    this.briefs.set(sessionID, buildBrief({ root, missionText, state, tasks, journal, memory, summary, progress, instructions, facts: state.facts ?? [], results }));
  },

  async compactMemory(root, state) {
    if (state.turn === 0 || state.turn % 4 !== 0) return;
    const [journal, memory, summary] = await Promise.all([readJournal(root), loadMemory(root), loadSummary(root)]);
    let distilled = distill({ journal, memory, summary });
    if (this.options.generate) {
      try {
        const prompt = [
          "Summarize this mission's durable memory for the next context window.",
          "Keep decisions, reasons, discarded approaches, constraints and facts. Drop noise. Output plain text only.",
          `CURRENT MEMORY:\n${memory.slice(0, 2000)}`,
          `RECENT JOURNAL:\n${journal.slice(-4000)}`,
        ].join("\n\n");
        const out = await this.options.generate({ prompt, model: this.options.fastModel });
        const text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
        if (text.trim().length > 20) {
          distilled = { memory: text.trim().slice(0, 4000), summary: `Model-compacted memory at turn ${state.turn}` };
        }
      } catch {
        // Keyword distill is the fallback.
      }
    }
    await Promise.all([saveMemory(root, distilled.memory), saveSummary(root, distilled.summary)]);
    await this.journal(root, `memory compacted: ${distilled.memory.split("\n").length} durable entries`);
  },

  async maybeReplan(root, state, results, tasks) {
    if (!needsReplan(state) || !this.options.generate) return false;
    const [missionText, memory, journal] = await Promise.all([
      this.readMission(root),
      loadMemory(root),
      readJournalTail(root, 1500),
    ]);
    const prompt = replanPrompt({
      objective: objectiveOf(missionText),
      memory,
      journalTail: journal,
      results,
      tasks,
    });
    let text = "";
    try {
      const out = await this.options.generate({ prompt, model: await this.pickPlannerModel() });
      text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
    } catch (err) {
      await this.journal(root, `re-plan request failed: ${shortError(err)}`);
      return false;
    }
    const parsed = normalizePlan(text, objectiveOf(missionText), root);
    if (!parsed.ok) {
      await this.journal(root, `re-plan rejected: ${parsed.errors.join("; ")}`);
      return false;
    }
    const planned = parsed.plan.tasks.map((t) => ({ ...t, status: TASK_STATUS.PENDING }));
    const dir = path.join(root, ".mission");
    await Promise.all([
      writeJsonAtomic(path.join(dir, "criteria.json"), { version: VERSION, checks: parsed.plan.checks }),
      writeJsonAtomic(path.join(dir, "tasks.json"), { version: VERSION, tasks: planned }),
      this.saveProgressSafe(root, fromTasks(planned)),
    ]);
    const next = afterReplan(state, state.turn);
    Object.assign(state, next);
    await this.saveStateSafe(root, state);
    await appendJournal(
      root,
      `re-plan applied at turn ${state.turn}: ${parsed.plan.checks.length} checks, ${planned.length} tasks (strategy reset to 1)`,
    );
    return true;
  },

  async dispatchReviewPair(sessionID, root, state, objective, results) {
    const prompt = reviewerPrompt({ objective, workspace: root, checks: results.map((r) => ({ id: r.id })) });
    await this.dispatchRoleStage(sessionID, root, ROLE.REVIEWER, prompt);
    const first = state.stage_reports?.reviewer?.text ?? "";
    await this.dispatchRoleStage(sessionID, root, "reviewer2", prompt);
    const second = state.stage_reports?.reviewer2?.text ?? "";
    state.stage_reports = state.stage_reports ?? {};
    state.stage_reports.review = { text: combineReviews(first, second), at: new Date().toISOString() };
    await this.saveStateSafe(root, state);
    await this.journal(root, "two independent reviewers completed; completion held until review is clean");
  },

  async runImproveCycle(sessionID, root, state, results) {
    const report = state.stage_reports?.auditor?.text ?? "";
    if (!report) {
      const answer = await this.dispatchRoleStage(
        sessionID,
        root,
        "auditor",
        `[MISSION AUDITOR] Workspace: ${root}\nRead-only. Find real improvements and emit one line each:\nFINDING: impact=high|medium|low risk=low|medium|high files=a.js,b.js description\nCall mission_report(role='auditor', text=...). If nothing valuable, write 'NO FINDINGS'.`,
      );
      state.stage_reports = state.stage_reports ?? {};
      state.stage_reports.auditor = { text: answer?.text ?? "NO FINDINGS", at: new Date().toISOString() };
      await this.saveStateSafe(root, state);
      await this.journal(root, "improvement audit dispatched");
      return { type: "continue" };
    }

    const findings = rankFindings(parseFindings(report), state.min_impact ?? "medium");
    const decision = cycleDecision({
      finding: findings[0],
      improveCycles: state.improve_cycles ?? 0,
      maxCycles: state.max_improve_cycles ?? 5,
      cleanRounds: state.clean_audit_rounds ?? 0,
      maxCleanRounds: state.max_clean_audit_rounds ?? 2,
      stopFile: await stopRequested(root),
      outOfBudget: state.cost_usd >= state.budget_usd,
    });

    if (decision.type === "stop") {
      await this.journal(root, `continuous improvement stopping: ${decision.reason}`);
      return { type: "complete", reason: decision.reason };
    }
    if (decision.type === "audit") {
      state.clean_audit_rounds = (state.clean_audit_rounds ?? 0) + 1;
      delete state.stage_reports.auditor;
      await this.saveStateSafe(root, state);
      await this.journal(root, `audit round without valuable findings (${state.clean_audit_rounds}/${state.max_clean_audit_rounds ?? 2})`);
      return { type: "continue" };
    }

    const finding = decision.finding;
    const tasks = await loadTasks(root);
    const id = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    const subject = `[improve ${finding.impact}] ${finding.text.slice(0, 120)}`;
    tasks.push({ id, subject, files: finding.files, status: TASK_STATUS.PENDING, blocked_by: [], verify: "" });
    const progress = await loadProgress(root);
    progress.push({ id, subject, status: TASK_STATUS.PENDING, owner: null, attempts: 0, lease_until: 0, last_error: "", verify: "" });
    state.improve_cycles = (state.improve_cycles ?? 0) + 1;
    state.active_improve_id = id;
    state.improve_revert_sha = state.last_commit ?? "";
    state.stage = STAGE.IMPLEMENT;
    state.clean_audit_rounds = 0;
    delete state.stage_reports.auditor;
    await Promise.all([this.saveTasksSafe(root, tasks), this.saveProgressSafe(root, progress), this.saveStateSafe(root, state)]);
    const line = `- [ ] id: imp-${id} | impact: ${finding.impact} | risk: ${finding.risk} | files: ${finding.files.join(",")} | ${finding.text.slice(0, 120)}`;
    await saveImprovements(root, `${await loadImprovements(root)}${line}\n`);
    await this.journal(root, `improvement cycle ${state.improve_cycles}: #${id} ${subject}`);
    return { type: "continue" };
  },

  async dispatchRoleStage(sessionID, root, role, promptText) {
    const created = await this.ctx.session.create({
      parentID: sessionID,
      title: `mission ${role}`,
      location: { directory: this.ctx.location.directory },
      model: this.modelForRole(role) ?? this.pickFreeModel(await this.modelCatalog()),
    });
    const id = created?.id ?? created?.data?.id;
    if (!id) return null;
    this.bind(id, root, false);
    this.workers.set(id, { root, taskId: 0, leadID: sessionID, role });
    this.roles.set(id, role);
    this.knownWorkers.add(id);
    this.briefs.set(id, `MISSION ${role.toUpperCase()} — read-only unless the role is implementer. Report with mission_report.`);
    await this.ctx.session.prompt({ sessionID: id, text: promptText, delivery: "queue" });
    await this.waitWithTimeout(id, 120_000);
    const fresh = await loadState(root);
    this.workers.delete(id);
    this.bySession.delete(id);
    this.roles.delete(id);
    this.briefs.delete(id);
    return fresh.stage_reports?.[role];
  },

  async runRolePipeline(sessionID, root, state, tasks, results, decision) {
    if (!this.enableRoles) return decision;
    const objective = objectiveOf(await this.readMission(root));
    const stage = state.stage ?? STAGE.IMPLEMENT;
    const reviewText = state.stage_reports?.review?.text ?? "";
    const next = stageFor({
      stage,
      tasksDone: tasks.length > 0 && tasks.every((t) => t.status === TASK_STATUS.COMPLETED),
      review: parseReview(reviewText),
      reviewAttempts: state.review_attempts ?? 0,
    });
    if (next.stage !== stage) {
      state.stage = next.stage;
      await this.journal(root, `stage: ${stage} → ${next.stage}`);
      await this.saveStateSafe(root, state);
    }

    if (stage === STAGE.REVIEW && !reviewText) {
      await this.dispatchReviewPair(sessionID, root, state, objective, results);
      return { type: "continue" };
    }

    if (stage === STAGE.INVESTIGATE) {
      const report = await this.dispatchRoleStage(
        sessionID,
        root,
        ROLE.INVESTIGATOR,
        investigatorPrompt({ objective, workspace: root }),
      );
      if (report?.text) await saveMemory(root, `${await loadMemory(root)}\nINVESTIGATION:\n${report.text}`.trim());
      state.stage = STAGE.IMPLEMENT;
      await this.journal(root, "investigator finished; implementers may now write");
      await this.saveStateSafe(root, state);
      return { type: "continue" };
    }

    if (next.decision === "blocked") return { type: "stop", reason: "review-high" };
    if (next.decision === "retry") {
      state.review_attempts = (state.review_attempts ?? 0) + 1;
      state.stage = STAGE.IMPLEMENT;
      const stored = await loadTasks(root);
      for (const t of stored) t.status = TASK_STATUS.PENDING;
      const leased = await loadProgress(root);
      for (const p of leased) {
        p.status = TASK_STATUS.PENDING;
        p.owner = null;
        p.lease_until = 0;
        p.attempts = 0;
      }
      if (state.stage_reports) delete state.stage_reports.review;
      await Promise.all([this.saveTasksSafe(root, stored), this.saveProgressSafe(root, leased), this.saveStateSafe(root, state)]);
      await this.journal(root, `review requires rework (attempt ${state.review_attempts})`);
      return { type: "continue" };
    }
    if (next.decision === "complete" && state.continuous_improvement !== false) {
      return this.runImproveCycle(sessionID, root, state, results);
    }

    if (next.stage === STAGE.REVIEW) {
      if (!reviewText) {
        await this.dispatchReviewPair(sessionID, root, state, objective, results);
        return { type: "continue" };
      }
      return { type: "complete" };
    }
    return decision;
  }
};
