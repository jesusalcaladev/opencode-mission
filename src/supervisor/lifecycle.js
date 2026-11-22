// lifecycle mixin — extracted from supervisor.js; behavior unchanged.
import * as d from "./deps.js";
const { os, path, mkdir, readFile, writeTextAtomic } = d;
const cacheDir = () =>
  path.join(os.homedir?.() ?? process.env.HOME ?? "", ".cache", "opencode-mission");
const pointerPath = () => path.join(cacheDir(), "current.json");
const registryPath = () => path.join(cacheDir(), "missions.json");

async function updateRegistry(root, state, objective = "") {
  if (process.env.NODE_TEST_CONTEXT) return;
  try {
    await mkdir(cacheDir(), { recursive: true });
    const pointer = JSON.stringify({
      root,
      sessionID: state.session_id ?? "",
      id: state.id ?? "mission",
      status: state.status,
      at: Date.now(),
    });
    await writeTextAtomic(pointerPath(), `${pointer}\n`);

    let list = [];
    try {
      const raw = await readFile(registryPath(), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
    const checks = Array.isArray(state.last_checks) ? state.last_checks : [];
    const green = checks.filter((c) => c.ok).length;
    const entry = {
      root,
      sessionID: state.session_id ?? "",
      id: state.id ?? "mission",
      objective: String(objective ?? "").slice(0, 200),
      status: state.status,
      pct: checks.length ? Math.round((green / checks.length) * 100) : 0,
      updated_at: Date.now(),
    };
    list = [entry, ...list.filter((e) => e?.root !== root)].slice(0, 30);
    await writeTextAtomic(registryPath(), `${JSON.stringify(list, null, 2)}\n`);
  } catch {
    // The registry is telemetry only; it must never fail a mission.
  }
}

export const lifecycle = {
  async start(sessionID, target, options = {}) {
    const root = path.resolve(target);
    await this.d.ensureMission(root, options);
    const state = await this.d.loadState(root);
    await updateRegistry(root, state, options.objective ?? "");
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
    await updateRegistry(root, state, options.objective ?? this.d.objectiveOf(missionText));
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
    await this.saveStateSafe(root, state);
    await updateRegistry(root, state, state.objective ?? "");
    await this.journal(root, `mission ${status}: ${reason}`);
    const label = status === this.d.STATUS.COMPLETE ? "MISSION COMPLETE" : "MISSION STOPPED";
    const text = `[${label}] ${reason}${state.unblock ? `. Unblock: ${state.unblock}` : ""}. Mission state: ${path.join(root, ".mission")}`;
    await this.ctx.session.synthetic({ sessionID, text }).catch(() => {});
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
