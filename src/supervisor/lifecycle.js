// lifecycle mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
import { updateRegistry, directoryFor } from "./registry.js";
const { path } = d;

export const lifecycle = {
  /// Keep the TUI cache fresh after every idle boundary, not only at start.
  async publishRegistry(root, state, objective = "") {
    await updateRegistry(root, state, objective, {
      directory: directoryFor(state.session_id ?? "", {
        boundDirectory: this.boundDirectory,
        fallback: this.currentDirectory,
        root,
      }),
      onError: (err) => this.warn(root, "registry publish failed", err),
    });
  },

  async start(sessionID, target, options = {}) {
    const root = path.resolve(target);
    await this.d.ensureMission(root, options);
    const state = await this.d.loadState(root);
    // Capture installed dependencies once, so the final report can say exactly
    // what the mission added or changed. Never overwritten by a resume.
    if (!state.deps_baseline) {
      state.deps_baseline = this.d.dependencySnapshot(
        await this.d.readText(path.join(root, "package.json"), "")
      );
    }
    state.status = this.d.STATUS.RUNNING;
    state.session_id = sessionID;
    state.finished_at = null;
    state.finish_reason = null;
    state.last_verdict = null;
    state.failures = 0;
    state.chain_total = this.d.parseRoadmap(await this.d.loadRoadmap(root)).length;
    state.started_at = state.started_at || new Date().toISOString();
    state.last_prompt_at = Date.now();

    const tasks0 = await this.d.loadTasks(root);
    const progress0 = await this.d.loadProgress(root);
    if (progress0.length === 0 && tasks0.length > 0)
      await this.saveProgressSafe(root, this.d.fromTasks(tasks0));

    if (state.isolation === "worktree" && !state.worktree_root) {
      const wt = await this.d.createWorktree(root, String(state.id ?? "mission"));
      if (wt.ok) {
        state.worktree_root = wt.root;
        state.worktree_branch = wt.branch;
        await this.journal(root, `isolated in worktree ${wt.root} (${wt.branch})`);
      } else {
        await this.journal(root, `worktree isolation requested but unavailable: ${wt.reason}`);
      }
    }

    const workRoot = this.effectiveRoot(root, state);
    const integrity = await this.d.checkTestIntegrity(workRoot, state.test_hashes);
    state.test_hashes = integrity.current;
    await this.saveStateSafe(root, state);

    this.bind(sessionID, root);
    await this.persistBinding(sessionID, root);
    await this.journal(
      root,
      `session ${sessionID} — mission started (turn ${state.turn + 1}/${state.max_turns})`
    );

    let dispatched = false;
    if (options.autoDispatch) await this.ensureWorkingModel(sessionID, root);
    if (options.autoDispatch && this.enableWorkers) {
      const tasks = await this.d.loadTasks(root);
      const outcome = await this.runWorkers(sessionID, root, state, tasks, workRoot);
      dispatched = outcome.ran;
    }
    await this.refreshBrief(sessionID, root, state.last_checks ?? []);

    const missionText = await this.readMission(root);
    const prompt = dispatched
      ? `[MISSION COORDINATOR]\n${this.d.objectiveOf(missionText)}\n\nWorkspace: ${workRoot}\nParallel workers are already handling the open tasks. Do NOT duplicate their work. Use mission_status / mission_check to watch progress; call mission_verdict only after every check is green.`
      : `[MISSION START]\n${this.d.objectiveOf(missionText)}\n\nWorkspace: ${workRoot}\nUse mission_write to create files, mission_check after every change, and mission_verdict only when all checks are green. Begin now.`;
    const startKey = this.d.promptKey("start", sessionID, String(state.turn));
    state.prompt_ledger = this.d.recordPrompt(state, { key: startKey, kind: "start", sessionID });
    await this.saveStateSafe(root, state);
    await this.publishRegistry(root, state, options.objective ?? this.d.objectiveOf(missionText));
    await this.ctx.session.prompt({ sessionID, text: prompt, delivery: "queue" });
    return this.statusText(root);
  },

  async pause(sessionID) {
    const root = this.rootFor(sessionID);
    if (!root) return "No mission is active in this session.";
    const state = await this.d.loadState(root);
    if (state.status !== this.d.STATUS.RUNNING)
      return `Mission is ${state.status}; nothing to pause.`;
    await this.d.writeTextAtomic(
      path.join(this.d.missionDir(root), this.d.FILES.pause),
      `${new Date().toISOString()}\n`
    );
    await this.journal(root, "PAUSE requested at the next idle boundary");
    return `Pause requested. The mission will stop at the next idle boundary; remove PAUSE and resume to continue.`;
  },

  async resume(sessionID, target) {
    const root = path.resolve(target ?? this.rootFor(sessionID) ?? ".");
    const state = await this.d.loadState(root);
    if (state.status === this.d.STATUS.COMPLETE)
      return "Mission already complete. Nothing to resume.";
    return this.start(sessionID, root);
  },

  async stop(sessionID, reason = "manual stop") {
    const root = this.rootFor(sessionID);
    if (!root) return "No mission is active in this session.";
    const state = await this.d.loadState(root);
    await this.finish(root, sessionID, state, "aborted", reason, state.summary ?? "");
    return `Mission stopped (${reason}). State kept in ${path.join(root, ".mission", "state.json")}.`;
  },

  async finish(root, sessionID, state, status, reason, summary) {
    state.status = status;
    state.finished_at = new Date().toISOString();
    state.finish_reason = reason;
    state.summary = summary ?? "";
    // Every terminal state leaves a detailed report in the workspace. A report
    // failure is logged and never changes the mission outcome.
    await this.writeMissionReport(root, state).catch((err) =>
      this.warn(root, "mission report failed", err)
    );
    await this.saveStateSafe(root, state);
    await this.publishRegistry(root, state, state.objective ?? "");
    await this.journal(root, `mission ${status}: ${reason}`);
    const label = status === this.d.STATUS.COMPLETE ? "MISSION COMPLETE" : "MISSION STOPPED";
    const reportPath = state.report_path ? ` Report: ${path.join(root, state.report_path)}.` : "";
    const text = `[${label}] ${reason}${state.unblock ? `. Unblock: ${state.unblock}` : ""}. Mission state: ${path.join(root, ".mission")}.${reportPath}`;
    await this.ctx.session
      .synthetic({ sessionID, text })
      .catch((err) => this.warn(root, "mission notice failed", err));
    await this.notify(label, `${text}\nworkspace: ${root}`);
    if (
      status === this.d.STATUS.COMPLETE &&
      this.enableChaining &&
      !this.controller.signal.aborted
    ) {
      setImmediate(() => {
        void this.continueChain(root, sessionID).catch((err) => {
          void this.journal(root, `chain failed: ${this.d.shortError(err)}`).catch(() => {});
        });
      });
    }
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
  },
};
