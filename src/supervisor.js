// The supervisor is a thin coordinator. Behavior lives in cohesive mixins
// under src/supervisor/: state, recovery, lifecycle, intelligence, workers, tools.
// The main loop stays here because it is the one place that owns the turn flow.

import * as d from "./supervisor/deps.js";
const {
  path, mkdir, readFile, writeJsonAtomic, MAX_NUDGE, REGISTRY_KEY, AUTO_RESUME_AGE_MS,
  STATUS, TASK_STATUS, VERSION, ROLE, STAGE, FILES, appendJournal, applyExtension,
  applyTaskResults, buildBrief, canWrite, chainDecision, claim, consumeExtend, cycleDecision,
  decideNext, DEFAULT_MAX_EXTENSIONS, distill, ensureMission, expired, extendRequested, fail,
  fileExists, fromTasks, isLeased, loadCriteria, loadImprovements, loadMemory, loadProgress,
  loadRoadmap, loadState, loadSummary, loadTasks, markItemDone, nextItem, needsReplan,
  normalizePlan, objectiveOf, afterReplan, parseFindings, parseRoadmap, rankFindings,
  readJournal, readJournalTail, release, renew, retryable, roleForStage, saveImprovements,
  saveMemory, saveProgress, saveRoadmap, saveState, saveSummary, saveTasks, selectTask,
  stopRequested, writeTextAtomic, runChecks, checkTestIntegrity, createWorktree, gitCommit, gitRevert,
  createPlan, fallbackPlan, investigatorPrompt, reportsText, reviewerPrompt, wavesFor,
  workerBrief, workerPrompt, shortError,
} = d;
import { state } from "./supervisor/state.js";
import { recovery } from "./supervisor/recovery.js";
import { lifecycle } from "./supervisor/lifecycle.js";
import { intelligence } from "./supervisor/intelligence.js";
import { workers } from "./supervisor/workers.js";
import { tools } from "./supervisor/tools.js";

export class Supervisor {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.bySession = new Map();
    this.byRoot = new Map();
    this.registry = [];
    this.busy = new Set();
    this.workers = new Map();
    this.roles = new Map();
    this.knownWorkers = new Set();
    this.briefs = new Map();
    this.stateQueue = new Map();
    this.writeOwners = new Set();
    this.timers = new Set();
    this.rescueTimer = null;
    this.controller = new AbortController();
    this.maxWorkers = Math.min(8, Math.max(1, Number(options.maxWorkers) || 3));
    this.missionsRoot = options.missionsRoot ? path.resolve(options.missionsRoot) : null;
    this.enableWorkers = options.enableWorkers !== false;
    this.enableChaining = options.enableChaining !== false;
    this.enableRoles = options.enableRoles !== false;
  }


  async handleIdle(sessionID) {
    const root = this.rootFor(sessionID);
    if (!root || this.busy.has(sessionID) || this.workers.has(sessionID) || this.knownWorkers.has(sessionID)) return;
    this.busy.add(sessionID);
    try {
      let state = await loadState(root);
      if (state.status !== STATUS.RUNNING) return;
      const workRoot = this.effectiveRoot(root, state);

      const integrity = await checkTestIntegrity(workRoot, state.test_hashes);
      state.test_hashes = integrity.current;
      if (!integrity.ok) {
        await this.journal(root, `test integrity refused progress: ${integrity.reason}`);
        await this.finish(root, sessionID, state, "aborted", "test-erosion", integrity.reason);
        return;
      }

      let progress = await loadProgress(root);
      if (progress.length === 0) {
        const stored = await loadTasks(root);
        if (stored.length > 0) {
          progress = fromTasks(stored);
          await this.saveProgressSafe(root, progress);
        }
      }
      const now = Date.now();
      const overdue = expired(progress, now);
      if (overdue.length > 0) {
        for (const id of overdue) fail(progress, id, "lease expired", now);
        const stored = await loadTasks(root);
        for (const t of stored) {
          if (overdue.includes(t.id)) t.status = retryable(progress, t.id) ? TASK_STATUS.PENDING : TASK_STATUS.FAILED;
        }
        await this.saveTasksSafe(root, stored);
        await this.saveProgressSafe(root, progress);
        await this.journal(root, `leases expired: ${overdue.map((id) => `#${id}`).join(", ")} → reclaimed`);
      }

      let { results, tasks } = await this.verify(root, workRoot);

      // An improvement that breaks verification is undone automatically; the
      // mission continues from the last known-good checkpoint.
      if (state.active_improve_id && !allGreen(results) && state.improve_revert_sha) {
        const reverted = await gitRevert(workRoot, state.improve_revert_sha);
        const note = reverted.ok
          ? `improve #${state.active_improve_id} reverted: ${state.improve_revert_sha}`
          : `improve #${state.active_improve_id} revert failed: ${reverted.reason}`;
        await this.journal(root, note);
        if (reverted.ok) {
          const reopened = await loadTasks(root);
          const target = reopened.find((t) => t.id === state.active_improve_id);
          if (target) target.status = TASK_STATUS.FAILED;
          await saveTasks(root, reopened);
        }
        state.active_improve_id = 0;
        state.improve_revert_sha = "";
        await saveState(root, state);
      }

      let anyProgress = this.recordTurn(state, results, tasks);
      const cost = await this.sessionCost(sessionID);
      if (cost !== null) state.cost_usd = cost;
      const verdict = state.last_verdict;
      state.last_verdict = null;
      const stopFile = await stopRequested(root);
      let decision = decideNext({ state, results, tasks, verdict, stopFile });
      if (decision.type === "stop") {
        const roadmap = parseRoadmap(await loadRoadmap(root));
        const chain = chainDecision({
          decision,
          extendRequested: await extendRequested(root),
          extensions: state.extensions ?? 0,
          maxExtensions: state.max_extensions ?? DEFAULT_MAX_EXTENSIONS,
          next: nextItem(roadmap),
        });
        if (chain.type === "extend" && (await consumeExtend(root))) {
          Object.assign(state, applyExtension(state));
          await this.journal(root, `budget extended ${state.extensions}/${state.max_extensions ?? DEFAULT_MAX_EXTENSIONS} after ${chain.reason}`);
          decision = { type: "continue" };
        }
      }
      await this.journalTurn(root, state, results, tasks, decision);
      await this.saveStateSafe(root, state);
      await this.compactMemory(root, state);

      if (decision.type === "continue") {
        const replanned = await this.maybeReplan(root, state, results, tasks);
        if (replanned) {
          ({ results, tasks } = await this.verify(root, workRoot));
          decision = decideNext({ state, results, tasks, verdict: null, stopFile: await stopRequested(root) });
          await this.journalTurn(root, state, results, tasks, decision, "after replan");
        }
      }

      decision = await this.runRolePipeline(sessionID, root, state, tasks, results, decision);

      if (decision.type === "continue" && this.enableWorkers) {
        const outcome = await this.runWorkers(sessionID, root, state, tasks, workRoot);
        if (outcome.ran) {
          state = await loadState(root);
          ({ results, tasks } = await this.verify(root, workRoot));
          anyProgress = this.recordTurn(state, results, tasks, false) || anyProgress;
          decision = decideNext({ state, results, tasks, verdict: null, stopFile: await stopRequested(root) });
          await this.journalTurn(root, state, results, tasks, decision, "after workers");
        }
      }

      if (decision.type === "complete" || decision.type === "stop") {
        state.unblock = decision.unblock ?? "";
        await this.finish(
          root,
          sessionID,
          state,
          decision.type === "complete" ? STATUS.COMPLETE : decision.reason === "blocked" ? STATUS.BLOCKED : STATUS.ABORTED,
          decision.reason ?? "all criteria green",
          verdict?.summary ?? "",
        );
        return;
      }

      if (anyProgress) {
        const owned = [...new Set(tasks.flatMap((t) => t.files ?? []))];
        const commit = await this.serialize(root, () =>
          gitCommit(workRoot, `mission(${state.id ?? "mission"}): turn ${state.turn} — verified progress`, owned),
        );
        if (commit.ok) {
          state.last_commit = commit.sha;
          await this.journal(root, `checkpoint committed: ${commit.sha ?? commit.reason}`);
        } else {
          await this.journal(root, `checkpoint commit skipped: ${commit.reason}`);
        }
      }

      let targetSession = sessionID;
      if (state.handoff_every_turns > 0 && state.turn - (state.last_handoff_turn ?? 0) >= state.handoff_every_turns) {
        try {
          const created = await this.ctx.session.create({
            title: `mission ${state.id ?? "mission"} · turn ${state.turn}`,
            location: { directory: this.ctx.location.directory },
          });
          const newID = created?.id ?? created?.data?.id;
          if (newID) {
            targetSession = newID;
            state.last_handoff_turn = state.turn;
            state.session_id = newID;
            await this.journal(root, `context handoff ${sessionID} → ${newID}`);
            this.unbind(sessionID);
            this.bind(newID, root);
            await this.persistBinding(newID, root);
            await this.ctx.session.synthetic({ sessionID, text: `[MISSION HANDOFF] Continuing in session ${newID}.` }).catch(() => {});
          }
        } catch (err) {
          await this.journal(root, `handoff failed, staying in session: ${shortError(err)}`);
        }
      }

      state.last_prompt_at = Date.now();
      await this.saveStateSafe(root, state);
      await this.refreshBrief(targetSession, root, results);

      const failing = results.filter((r) => !r.ok).map((r) => `- ${r.id}: ${r.summary}`).join("\n");
      const task = selectTask(tasks);
      const strategyNote =
        state.strategy_tier >= 2
          ? `STRATEGY TIER ${state.strategy_tier}: no verified progress. Re-read the criteria and CHANGE the approach; do not repeat the same edit.`
          : "Continue the mission. Do not stop after writing files.";
      const handoffNote = targetSession !== sessionID ? `[FRESH CONTEXT] You are in a new session. The journal on disk is your memory.\n` : "";
      const nudge = [
        `[MISSION SUPERVISOR · turn ${state.turn}/${state.max_turns}]`,
        handoffNote.trim(),
        `Harness re-ran the criteria: ${results.filter((r) => r.ok).length}/${results.length} green.`,
        failing ? `Failing checks:\n${failing}` : "All checks green; finishing verification.",
        task ? `Next task: #${task.id} ${task.subject}` : "All tasks complete.",
        strategyNote,
        "Use mission_write / mission_check. Call mission_verdict only when every check is green.",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_NUDGE);

      await this.ctx.session.prompt({ sessionID: targetSession, text: nudge, delivery: "queue" });
    } catch (err) {
      const root2 = this.rootFor(sessionID);
      if (root2) {
        const state = await loadState(root2);
        state.status = STATUS.ABORTED;
        state.finish_reason = `supervisor error: ${shortError(err)}`;
        state.finished_at = new Date().toISOString();
        await saveState(root2, state);
        await appendJournal(root2, `supervisor error: ${shortError(err)}`).catch(() => {});
      }
    } finally {
      this.busy.delete(sessionID);
    }
  }

}

Object.assign(
  Supervisor.prototype,
  state,
  recovery,
  lifecycle,
  intelligence,
  workers,
  tools,
);
