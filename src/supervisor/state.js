// state mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { allGreen, workspaceStamp, criteriaSignature, upsertFact, renderFacts, loadProjectInstructions, path, mkdir, readFile, nextStrategy, STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension, applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision, decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail, fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress, loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan, normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings, readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements, saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask, stopRequested, writeJsonAtomic, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert, createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt, shortError, REGISTRY_KEY, MAX_NUDGE, AUTO_RESUME_AGE_MS } = d;

export const state = {
  rootFor(sessionID) {
    return this.bySession.get(sessionID) ?? null;
  },

  effectiveRoot(root, state) {
    return state.worktree_root ? path.resolve(state.worktree_root) : root;
  },

  async serialize(root, fn) {
    // Only calls made from INSIDE fn are reentrant. A concurrent caller must
    // wait on the queue even while another caller is awaiting its turn.
    if (this.writeOwners.has(root)) return fn();
    const previous = this.stateQueue.get(root) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.stateQueue.set(root, previous.then(() => current));
    await previous;
    this.writeOwners.add(root);
    try {
      return await fn();
    } finally {
      this.writeOwners.delete(root);
      release();
    }
  },

  journal(root, line) {
    return this.serialize(root, () => appendJournal(root, line));
  },

  saveStateSafe(root, state) {
    return this.serialize(root, () => saveState(root, state));
  },

  saveProgressSafe(root, progress) {
    return this.serialize(root, () => saveProgress(root, progress));
  },

  saveTasksSafe(root, tasks) {
    return this.serialize(root, () => saveTasks(root, tasks));
  },

  dispose() {
    if (this.rescueTimer) clearInterval(this.rescueTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.controller.abort();
  }
};
