// The supervisor is a thin coordinator. Behavior lives in cohesive mixins
// under src/supervisor/: state, recovery, lifecycle, intelligence, workers, tools.
// The main loop stays here because it is the one place that owns the turn flow.

import * as d from "./supervisor/deps.js";
import { decisions } from "./supervisor/decisions.js";
import { state } from "./supervisor/state.js";
import { recovery } from "./supervisor/recovery.js";
import { models } from "./supervisor/models.js";
import { lifecycle } from "./supervisor/lifecycle.js";
import { planning } from "./supervisor/planning.js";
import { intelligence } from "./supervisor/intelligence.js";
import { rolesPipeline } from "./supervisor/roles-pipeline.js";
import { goalAudit } from "./supervisor/goal-audit.js";
import { improvements } from "./supervisor/improvements.js";
import { workers } from "./supervisor/workers.js";
import { scheduler } from "./supervisor/scheduler.js";
import { tools } from "./supervisor/tools.js";
import { researchTools } from "./supervisor/research-tools.js";
import { cost } from "./supervisor/cost.js";
import { quality } from "./supervisor/quality.js";
import { spawnTools } from "./supervisor/spawn-tools.js";
import { wake } from "./supervisor/wake.js";
import { failures } from "./supervisor/failures.js";
import { verification } from "./supervisor/verification.js";
import { reviews } from "./supervisor/reviews.js";
import { parallel } from "./supervisor/parallel.js";

export class Supervisor {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.d = d;
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
    this.timers = new Set();
    this.pendingTicks = new Set();
    this.rescueTimer = null;
    this.generationCosts = new Map();
    this.fileLocks = new Map();
    this.controller = new AbortController();
    this.maxWorkers = Math.max(1, Number(options.maxWorkers) || 3);
    this.missionsRoot = options.missionsRoot ? this.d.path.resolve(options.missionsRoot) : null;
    this.enableWorkers = options.enableWorkers !== false;
    this.enableChaining = options.enableChaining !== false;
    this.enableRoles = options.enableRoles !== false;
  }

  async handleIdle(sessionID) {
    const root = this.rootFor(sessionID);
    if (
      !root ||
      this.busy.has(sessionID) ||
      this.workers.has(sessionID) ||
      this.knownWorkers.has(sessionID)
    )
      return;
    this.busy.add(sessionID);
    try {
      let state = await this.d.loadState(root);
      if (state.status === this.d.STATUS.PAUSED || (await this.d.pauseRequested(root))) {
        if (state.status !== this.d.STATUS.PAUSED) {
          state.status = this.d.STATUS.PAUSED;
          state.paused = true;
          await this.saveStateSafe(root, state);
          await this.journal(root, "paused at idle boundary (PAUSE file)");
        }
        return;
      }
      if (state.status !== this.d.STATUS.RUNNING) return;
      const workRoot = this.effectiveRoot(root, state);

      const integrity = await this.d.checkTestIntegrity(workRoot, state.test_hashes);
      state.test_hashes = integrity.current;
      if (!integrity.ok) {
        await this.journal(root, `test integrity refused progress: ${integrity.reason}`);
        await this.finish(root, sessionID, state, "aborted", "test-erosion", integrity.reason);
        return;
      }

      let progress = await this.d.loadProgress(root);
      if (progress.length === 0) {
        const stored = await this.d.loadTasks(root);
        if (stored.length > 0) {
          progress = this.d.fromTasks(stored);
          await this.saveProgressSafe(root, progress);
        }
      }
      await this.reclaimExpiredLeases(root, progress, state);

      await this.updateMissionCost(root, state, sessionID);
      let { results, tasks, baseline } = await this.verify(root, workRoot);
      state.check_baseline = baseline;
      if (await this.maybeSplitStuckTask(root, state, tasks)) {
        ({ results, tasks, baseline } = await this.verify(root, workRoot));
        state.check_baseline = baseline;
      }
      const criteria = await this.d.loadCriteria(root);
      state.last_checks_at = Date.now();
      state.history = this.d.appendHistory(state, { results, tasks });

      // A change that breaks verification is undone automatically; the mission
      // continues from the last known-good checkpoint.
      await this.revertBrokenImprovement(root, workRoot, state, results);

      let anyProgress = this.recordTurn(state, results, tasks);
      const verdict = state.last_verdict;
      state.last_verdict = null;
      const stopFile = await this.d.stopRequested(root);
      let decision = await this.resolveStopDecision(
        root,
        state,
        this.d.decideNext({
          state,
          results,
          tasks,
          verdict,
          stopFile,
          pauseFile: false,
          criteria,
          baseline: state.check_baseline ?? {},
        })
      );

      await this.journalTurn(root, state, results, tasks, decision);
      state.phase = state.stage ?? state.phase;
      await this.serialize(root, () => this.d.saveMetrics(root, state.metrics));
      await this.saveStateSafe(root, state);
      await this.compactMemory(root, state).catch(async (err) => {
        await this.journal(root, `memory compaction failed: ${this.d.shortError(err)}`).catch(
          () => {}
        );
      });

      if (decision.type === "continue" || decision.type === "replan") {
        const replanned = await this.maybeReplan(
          root,
          state,
          results,
          tasks,
          decision.type === "replan"
        );
        if (replanned) {
          state.metrics = this.d.recordMetric(state.metrics, "replans", 1);
          ({ results, tasks, baseline } = await this.verify(root, workRoot));
          state.check_baseline = baseline;
          decision = this.d.decideNext({
            state,
            results,
            tasks,
            verdict: null,
            stopFile: await this.d.stopRequested(root),
            pauseFile: await this.d.pauseRequested(root),
            criteria: await this.d.loadCriteria(root),
            baseline: state.check_baseline ?? {},
          });
          await this.journalTurn(root, state, results, tasks, decision, "after replan");
        }
      }
      // A forced re-plan from a blocked verdict is a retry instruction, not a
      // terminal state: keep the turn alive even when no new plan was produced.
      if (decision.type === "replan") decision = { type: "continue", reason: decision.reason };

      decision = await this.runRolePipeline(sessionID, root, state, tasks, results, decision);

      if (decision.type === "continue" && this.enableWorkers) {
        const outcome = await this.runWorkers(sessionID, root, state, tasks, workRoot);
        if (outcome.ran) {
          state = await this.d.loadState(root);
          ({ results, tasks, baseline } = await this.verify(root, workRoot));
          state.check_baseline = baseline;
          anyProgress = this.recordTurn(state, results, tasks, false) || anyProgress;
          decision = this.d.decideNext({
            state,
            results,
            tasks,
            verdict: null,
            stopFile: await this.d.stopRequested(root),
            pauseFile: await this.d.pauseRequested(root),
            criteria: await this.d.loadCriteria(root),
            baseline: state.check_baseline ?? {},
          });
          await this.journalTurn(root, state, results, tasks, decision, "after workers");
        }
      }

      if (decision.type === "complete" || decision.type === "stop") {
        state.unblock = decision.unblock ?? "";
        await this.finish(
          root,
          sessionID,
          state,
          decision.type === "complete"
            ? this.d.STATUS.COMPLETE
            : decision.reason === "blocked"
              ? this.d.STATUS.BLOCKED
              : this.d.STATUS.ABORTED,
          decision.reason ?? "all criteria green",
          verdict?.summary ?? ""
        );
        return;
      }

      if (anyProgress) {
        const owned = [...new Set(tasks.flatMap((task) => task.files ?? []))];
        const commit = await this.serialize(root, () =>
          this.d.gitCommit(
            workRoot,
            `mission(${state.id ?? "mission"}): turn ${state.turn} — verified progress`,
            owned
          )
        );
        if (commit.ok) {
          state.last_commit = commit.sha;
          await this.journal(root, `checkpoint committed: ${commit.sha ?? commit.reason}`);
        } else {
          await this.journal(root, `checkpoint commit skipped: ${commit.reason}`);
        }
      }

      const targetSession = await this.maybeHandoff(sessionID, root, state);
      state.last_prompt_at = Date.now();
      await this.saveStateSafe(root, state);
      await this.refreshBrief(targetSession, root, results).catch(async (err) => {
        await this.journal(root, `brief refresh failed: ${this.d.shortError(err)}`).catch(() => {});
      });

      const nudge = this.buildNudge({ sessionID, targetSession, state, results, tasks });
      if (!(await this.deliverNudge(root, sessionID, targetSession, state, nudge))) return;
    } catch (err) {
      await this.recoverFromError(sessionID, err);
    } finally {
      this.busy.delete(sessionID);
    }
  }
}

Object.assign(
  Supervisor.prototype,
  decisions,
  state,
  recovery,
  models,
  lifecycle,
  planning,
  intelligence,
  rolesPipeline,
  goalAudit,
  improvements,
  workers,
  scheduler,
  tools,
  researchTools,
  cost,
  quality,
  spawnTools,
  wake,
  failures,
  verification,
  reviews,
  parallel
);
