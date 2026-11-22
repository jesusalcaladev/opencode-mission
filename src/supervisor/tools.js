// tools mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { os, writeFile, combineReviews, allGreen, workspaceStamp, criteriaSignature, upsertFact, renderFacts, loadProjectInstructions, path, mkdir, readFile, nextStrategy, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const tools = {
  toolStatus(sessionID) {
    const root = this.rootFor(sessionID);
    return root ? this.statusText(root) : "No mission is active in this session. Run /mission start <dir>.";
  },

  async toolWrite(sessionID, { path: rel, content }) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    if (typeof rel !== "string" || typeof content !== "string") return "path and content are required strings.";
    const role = this.roles.get(sessionID) ?? ROLE.IMPLEMENTER;
    if (!canWrite(role)) return `Role '${role}' is read-only in this mission. Only the implementer writes files.`;
    const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
    const worker = this.workers.get(sessionID);
    if (worker?.taskId) {
      const assigned = (await loadTasks(root)).find((t) => t.id === worker.taskId)?.files ?? [];
      if (assigned.length > 0 && !assigned.some((f) => normalized === f || normalized.startsWith(`${f}/`))) {
        return `Refusing to write outside task #${worker.taskId} files: ${normalized}`;
      }
    }
    // The harness owns the contract. Allowing the model to rewrite criteria,
    // tasks or state would let it define "done" as whatever it wrote.
    if (normalized === ".mission" || normalized.startsWith(".mission/")) {
      return "Refusing to write mission control files under .mission/ (the harness owns criteria, tasks and state).";
    }
    const state = await loadState(root);
    const workRoot = this.effectiveRoot(root, state);
    const target = path.resolve(workRoot, rel);
    if (target !== workRoot && !target.startsWith(`${workRoot}${path.sep}`)) return `Refusing to write outside the mission workspace: ${rel}`;
    await writeTextAtomic(target, content);
    await this.serialize(root, async () => {
      const fresh = await loadState(root);
      fresh.writes = (fresh.writes ?? 0) + 1;
      await this.saveStateSafe(root, fresh);
    });
    return `Wrote ${path.relative(workRoot, target)} (${content.length} bytes). Call mission_check to verify.`;
  },

  async toolCheck(sessionID) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const state = await loadState(root);
    const workRoot = this.effectiveRoot(root, state);
    const criteria = await loadCriteria(root);
    const results = await runChecks(workRoot, criteria);
    if (!this.workers.has(sessionID)) {
      state.last_checks = results;
      await this.saveStateSafe(root, state);
      await this.refreshBrief(sessionID, root, results);
    }
    const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.id}: ${r.summary} (evidence: ${r.evidence})`);
    return `${results.filter((r) => r.ok).length}/${results.length} checks green\n${lines.join("\n")}`;
  },

  async toolVerdict(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const status = String(input?.status ?? "").toLowerCase();
    if (status !== "met" && status !== "blocked") return 'status must be "met" or "blocked".';
    const summary = String(input?.summary ?? "").trim();
    if (summary.length < 3) return "summary is required (at least 3 characters).";
    const unblock = String(input?.what_would_unblock ?? "").trim();
    if (status === "blocked" && !unblock) return "blocked verdicts require what_would_unblock.";
    const state = await loadState(root);
    state.last_verdict = { status, summary, unblock };
    await this.saveStateSafe(root, state);
    return status === "met"
      ? "Verdict recorded. The harness will verify the checks before accepting it."
      : "Blocked verdict recorded. The mission will stop after the harness re-runs the checks.";
  },

  async toolReport(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const role = this.roles.get(sessionID) ?? String(input?.role ?? "agent");
    const text = String(input?.text ?? "").trim();
    if (text.length < 3) return "report text is required (at least 3 characters).";
    return this.serialize(root, async () => {
      const state = await loadState(root);
      if (!state.stage_reports || typeof state.stage_reports !== "object") state.stage_reports = {};
      state.stage_reports[role] = { text: text.slice(0, 8000), at: new Date().toISOString() };
      await this.saveStateSafe(root, state);
      await this.journal(root, `stage report from ${role}: ${text.slice(0, 200)}`);
      return `Report stored for role '${role}'.`;
    });
  },

  async toolHeartbeat(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const worker = this.workers.get(sessionID);
    const id = Number(input?.id ?? worker?.taskId);
    if (!Number.isFinite(id) || id < 1) return "task id is required.";
    return this.serialize(root, async () => {
      const progress = await loadProgress(root);
      const state = await loadState(root);
      const ok = renew(progress, id, Date.now(), Number(state.lease_ms) || 300000);
      if (ok) await saveProgress(root, progress);
      return ok ? `Lease for task #${id} renewed.` : `No active lease for task #${id}.`;
    });
  },

  async toolTaskDone(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const worker = this.workers.get(sessionID);
    const id = Number(input?.id ?? worker?.taskId);
    const summary = String(input?.summary ?? "").trim();
    const rawStatus = String(input?.status ?? "done").toLowerCase();
    const status = rawStatus === "failed" || rawStatus === "blocked" ? "failed" : "done";
    const evidence = Array.isArray(input?.evidence) ? input.evidence.filter((e) => typeof e === "string").slice(0, 12) : [];
    if (!Number.isFinite(id) || id < 1) return "task id is required.";
    if (summary.length < 3) return "summary is required (at least 3 characters).";
    return this.serialize(root, async () => {
      const state = await loadState(root);
      const progress = await loadProgress(root);
      if (!state.task_reports || typeof state.task_reports !== "object") state.task_reports = {};
      state.task_reports[String(id)] = {
        status,
        summary: summary.slice(0, 1000),
        evidence,
        at: new Date().toISOString(),
        by: worker?.taskId === id ? "worker" : "lead",
      };
      const task = (await loadTasks(root)).find((t) => t.id === id);
      const check = state.last_checks?.find((r) => r.id === task?.verify);
      const credible = status !== "done" || !task?.verify || Boolean(check?.ok);
      if (credible) {
        if (status === "done") release(progress, id, TASK_STATUS.COMPLETED);
        else fail(progress, id, summary, Date.now());
      } else {
        fail(progress, id, `verify check ${task.verify} is red`, Date.now());
      }
      await Promise.all([this.saveStateSafe(root, state), this.saveProgressSafe(root, progress)]);
      await appendJournal(
        root,
        credible
          ? `task #${id} reported ${status}: ${summary.slice(0, 200)} (harness verifies)`
          : `task #${id} report rejected: verify check ${task.verify} is red → retry`,
      );
      if (!credible) return `Report rejected: task #${id} verify check ${task.verify} is not green. The lease was released for retry.`;
      return status === "done"
        ? `Report recorded for task #${id}; lease released. The harness still verifies its check.`
        : `Failure recorded for task #${id}; lease released for retry.`;
    });
  },

  async toolFact(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    return this.serialize(root, async () => {
      const state = await loadState(root);
      state.facts = upsertFact(state.facts, {
        kind: input?.kind,
        subject: input?.subject,
        text: input?.text,
      });
      await saveState(root, state);
      await this.journal(root, `fact [${input?.kind ?? "note"}] ${input?.subject ?? ""}`);
      return "Fact stored in durable mission memory.";
    });
  },

  async toolLog(sessionID, { text }) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    if (typeof text !== "string" || !text.trim()) return "text is required.";
    await this.journal(root, `agent: ${text.trim().slice(0, 1000)}`);
    return "Journal entry appended.";
  }
};
