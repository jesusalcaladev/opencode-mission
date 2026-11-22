// The autonomous supervisor. It lives OUTSIDE the model:
//   - owns durable mission state,
//   - re-runs the criteria itself after every turn,
//   - guards test integrity and commits verified progress,
//   - recovers from failed/interrupted turns and service restarts,
//   - hands off to a fresh session to keep the context bounded,
//   - and decides whether to continue, complete, or stop.

import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { runChecks } from "./checks.js";
import { checkTestIntegrity, createWorktree, gitCommit } from "./verify.js";
import { createPlan, fallbackPlan, normalizePlan } from "./planner.js";
import { investigatorPrompt, reportsText, reviewerPrompt, wavesFor, workerBrief, workerPrompt } from "./team.js";
import {
  STATUS,
  STAGE,
  ROLE,
  TASK_STATUS,
  canWrite,
  roleForStage,
  parseReview,
  stageFor,
  VERSION,
  appendJournal,
  applyExtension,
  applyTaskResults,
  buildBrief,
  chainDecision,
  claim,
  consumeExtend,
  DEFAULT_MAX_EXTENSIONS,
  decideNext,
  distill,
  ensureMission,
  extendRequested,
  expired,
  fail,
  fromTasks,
  isLeased,
  loadCriteria,
  loadMemory,
  loadRoadmap,
  markItemDone,
  nextItem,
  loadProgress,
  loadState,
  loadSummary,
  loadTasks,
  nextStrategy,
  needsReplan,
  objectiveOf,
  afterReplan,
  parseRoadmap,
  replanPrompt,
  readJournal,
  readJournalTail,
  release,
  renew,
  retryable,
  saveMemory,
  saveProgress,
  saveRoadmap,
  saveState,
  saveSummary,
  saveTasks,
  selectTask,
  stopRequested,
  writeJsonAtomic,
  writeTextAtomic,
} from "./mission.js";

const REGISTRY_KEY = "mission:registry";
const MAX_NUDGE = 4000;
const AUTO_RESUME_AGE_MS = 30_000;

function shortError(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (err && typeof err === "object") {
    const message = err.message ?? err.error?.message ?? err.type ?? err.name;
    if (typeof message === "string" && message.length > 0) return message.slice(0, 300);
    try {
      return JSON.stringify(err).slice(0, 300);
    } catch {
      return "unknown error";
    }
  }
  return String(err);
}

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

  // ---- binding / restart recovery -------------------------------------------

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
  }

  bind(sessionID, root, isLead = true) {
    this.bySession.set(sessionID, root);
    // Only the lead owns the root's idle loop and registry entry. Workers can
    // use mission_* tools, but must never continue the mission themselves.
    if (isLead) this.byRoot.set(root, sessionID);
  }

  unbind(sessionID) {
    const root = this.bySession.get(sessionID);
    if (root) this.byRoot.delete(root);
    this.bySession.delete(sessionID);
    this.registry = this.registry.filter((e) => e.sessionID !== sessionID);
  }

  async persistBinding(sessionID, root) {
    this.registry = this.registry.filter((e) => e.sessionID !== sessionID && e.root !== root);
    this.registry.push({ sessionID, root });
    await this.ctx.storage.set(REGISTRY_KEY, this.registry).catch(() => {});
  }

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
  }

  startRescueTimer() {
    const interval = Number(this.options.rescueIntervalMs) || 60_000;
    this.rescueTimer = setInterval(() => void this.rescueStalled(), interval);
    this.rescueTimer.unref?.();
  }

  // Catches a session that went quiet without firing experimental.idle.
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
  }

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
  }

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
  }

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
  }

  rootFor(sessionID) {
    return this.bySession.get(sessionID) ?? null;
  }

  effectiveRoot(root, state) {
    return state.worktree_root ? path.resolve(state.worktree_root) : root;
  }

  // ---- lifecycle ------------------------------------------------------------

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
  }

  // One normalized catalog for planner, lead, workers and rotation. OpenCode
  // supplies the default model; we only override it when a free one exists.
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
  }

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
  }

  async pickPlannerModel() {
    if (this.options.plannerModel) return this.options.plannerModel;
    return this.pickFreeModel(await this.modelCatalog());
  }

  // Proactively move the lead off an exhausted/default paid model so the first
  // turn does not waste a quota failure and a backoff cycle.
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
  }

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
  }

  // /mission start <natural language objective>
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
  }

  async resume(sessionID, target) {
    const root = path.resolve(target ?? this.rootFor(sessionID) ?? ".");
    const state = await loadState(root);
    if (state.status === STATUS.COMPLETE) return "Mission already complete. Nothing to resume.";
    return this.start(sessionID, root);
  }

  async stop(sessionID, reason = "manual stop") {
    const root = this.rootFor(sessionID);
    if (!root) return "No mission is active in this session.";
    const state = await loadState(root);
    await this.finish(root, sessionID, state, "aborted", reason, state.summary ?? "");
    return `Mission stopped (${reason}). State kept in ${path.join(root, ".mission", "state.json")}.`;
  }

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
  }

  // Start the next roadmap item in the same workspace, carrying distilled
  // memory forward. setImmediate keeps this out of the idle call stack.
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
  }

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

  async readMission(root) {
    return readFile(path.join(root, ".mission", "mission.md"), "utf8").catch(() => "");
  }

  inject(event) {
    const root = this.rootFor(event.sessionID);
    if (!root) return;
    const brief = this.briefs?.get(event.sessionID);
    if (brief) event.system.push({ type: "text", text: brief });
  }

  async refreshBrief(sessionID, root, results) {
    const [missionText, state, tasks, journal, memory, summary, progress] = await Promise.all([
      this.readMission(root),
      loadState(root),
      loadTasks(root),
      readJournal(root),
      loadMemory(root),
      loadSummary(root),
      loadProgress(root),
    ]);
    this.briefs.set(sessionID, buildBrief({ root, missionText, state, tasks, journal, memory, summary, progress, results }));
  }

  // One shared workspace, specialized agents. The harness owns the stage
  // transitions; an agent cannot skip review or write from a read-only role.
  async dispatchRoleStage(sessionID, root, role, promptText) {
    const created = await this.ctx.session.create({
      parentID: sessionID,
      title: `mission ${role}`,
      location: { directory: this.ctx.location.directory },
      model: this.options.model ?? this.pickFreeModel(await this.modelCatalog()),
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
  }

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
      await this.dispatchRoleStage(
        sessionID,
        root,
        ROLE.REVIEWER,
        reviewerPrompt({ objective, workspace: root, checks: results.map((r) => ({ id: r.id })) }),
      );
      await this.journal(root, "reviewer dispatched; completion held until review is clean");
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

    if (next.stage === STAGE.REVIEW) {
      if (!reviewText) {
        await this.dispatchRoleStage(
          sessionID,
          root,
          ROLE.REVIEWER,
          reviewerPrompt({ objective, workspace: root, checks: results.map((r) => ({ id: r.id })) }),
        );
        await this.journal(root, "reviewer dispatched; completion held until review is clean");
        return { type: "continue" };
      }
      return { type: "complete" };
    }
    return decision;
  }

  // A stalled mission gets a NEW plan, not a louder prompt. The harness applies
  // it only after it passes the same validation as the initial plan.
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
  }

  // Distill the raw journal into bounded memory. Called on a schedule, not on
  // every turn, so the brief is stable and cacheable between compactions.
  async compactMemory(root, state) {
    if (state.turn === 0 || state.turn % 4 !== 0) return;
    const [journal, memory, summary] = await Promise.all([readJournal(root), loadMemory(root), loadSummary(root)]);
    const distilled = distill({ journal, memory, summary });
    await Promise.all([saveMemory(root, distilled.memory), saveSummary(root, distilled.summary)]);
    await this.journal(root, `memory compacted: ${distilled.memory.split("\n").length} durable entries`);
  }

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
  }

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
  }

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
  }

  async journalTurn(root, state, results, tasks, decision, label = "turn") {
    const green = results.filter((r) => r.ok).length;
    const done = tasks.filter((t) => t.status === "completed").length;
    await appendJournal(
      root,
      `${label} ${state.turn}: ${green}/${results.length} checks green, ${done}/${tasks.length} tasks done, tier ${state.strategy_tier}, $${state.cost_usd.toFixed(2)} → ${decision.type}${decision.reason ? `(${decision.reason})` : ""}`,
    );
  }

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
  }

  // Parallel workers: one child session per ready task, grouped into waves of
  // disjoint file sets. The harness still owns verification and completion.
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
  }

  // THE LOOP. Runs just before the session goes idle, after each agent turn.
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
        const commit = await this.serialize(root, () =>
          gitCommit(workRoot, `mission(${state.id ?? "mission"}): turn ${state.turn} — verified progress`),
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

  dispose() {
    if (this.rescueTimer) clearInterval(this.rescueTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.controller.abort();
  }

  // ---- tool implementations -------------------------------------------------

  toolStatus(sessionID) {
    const root = this.rootFor(sessionID);
    return root ? this.statusText(root) : "No mission is active in this session. Run /mission start <dir>.";
  }

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
  }

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
  }

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
  }

  // Workers finish in parallel; serialize read-modify-write of state.json so
  // two reports cannot overwrite each other.
  // ONE write queue per mission. Parallel workers must never interleave a
  // journal append with a state or progress replace: the read-modify-write
  // window would lose lines. Reentrant calls (from inside fn) run directly.
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
  }

  journal(root, line) {
    return this.serialize(root, () => appendJournal(root, line));
  }
  saveStateSafe(root, state) {
    return this.serialize(root, () => saveState(root, state));
  }
  saveProgressSafe(root, progress) {
    return this.serialize(root, () => saveProgress(root, progress));
  }
  saveTasksSafe(root, tasks) {
    return this.serialize(root, () => saveTasks(root, tasks));
  }

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
  }

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
  }

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
  }

  async toolLog(sessionID, { text }) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    if (typeof text !== "string" || !text.trim()) return "text is required.";
    await this.journal(root, `agent: ${text.trim().slice(0, 1000)}`);
    return "Journal entry appended.";
  }
}
