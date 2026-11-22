/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// planning mixin — extracted from lifecycle.js.
// All dependencies are reached through this.d (set by the Supervisor).

import * as d from "./deps.js";
const { path, mkdir } = d;

export const planning = {
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
      `hard_budget_usd: ${s.hard_budget_usd ?? 0}`,
      `auto_extend: ${s.auto_extend ?? false}`,
      `max_extensions: ${s.max_extensions ?? 3}`,
      `extension_turns: ${s.extension_turns ?? 8}`,
      `extension_writes: ${s.extension_writes ?? 50}`,
      `extension_budget_usd: ${s.extension_budget_usd ?? 5}`,
      `goal_audit: ${s.goal_audit ?? false}`,
      `max_goal_audits: ${s.max_goal_audits ?? 3}`,
      `autonomy: ${s.autonomy ?? "standard"}`,
      `lease_ms: ${s.lease_ms ?? 300000}`,
      `worker_timeout_ms: ${s.worker_timeout_ms ?? 1800000}`,
      `continuous_improvement: ${s.continuous_improvement ?? true}`,
      `max_improve_cycles: ${s.max_improve_cycles ?? 5}`,
      `min_impact: ${s.min_impact ?? "medium"}`,
      `max_writes: ${s.max_writes ?? 0}`,
      `needs_research: ${plan.needs_research === true}`,
      `research: ${plan.research === true || plan.needs_research === true}`,
      `isolation: ${s.isolation}`,
      "---",
      plan.objective,
      "",
      `Original request: ${original}`,
      "",
      "Completion is defined ONLY by criteria.json. All tasks must be verified by the harness.",
      ...(plan.definition_of_done ?? []).map((d) => `- DONE: ${d}`),
    ].join("\n");
    await this.d.writeTextAtomic(path.join(dir, "mission.md"), `${frontmatter}\n`);
    await this.d.writeJsonAtomic(path.join(dir, "criteria.json"), {
      version: this.d.VERSION,
      checks: plan.checks,
      requirements: plan.requirements ?? [],
      milestones: plan.milestones ?? [],
      definition_of_done: plan.definition_of_done ?? [],
    });
    const planned = plan.tasks.map((t) => ({ ...t, status: "pending" }));
    await this.d.writeJsonAtomic(path.join(dir, "tasks.json"), {
      version: this.d.VERSION,
      tasks: planned,
    });
    // progress.json may have been seeded by this.d.ensureMission from the placeholder
    // task. Keep leases in sync with the actual plan.
    await this.saveProgressSafe(root, this.d.fromTasks(planned));
    const state = await this.d.loadState(root);
    Object.assign(state, s, {
      status: this.d.STATUS.RUNNING,
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
    if (clean.length < 3)
      return "Give an objective after /mission start, e.g. /mission start build a tiny CLI with three tests";

    const slug =
      clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .split("-")
        .slice(0, 4)
        .join("-") || "mission";
    const base = this.missionsRoot ?? path.join(this.ctx.location.directory, "missions");
    const root = path.join(base, `${slug}-${Date.now().toString(36)}`);
    await this.d.ensureMission(root, { objective: clean });

    let generated;
    try {
      const model = await this.pickPlannerModel();
      generated = await this.d.createPlan(clean, root, this.options.generate ?? (async () => ""), {
        model,
        attempts: 2,
      });
    } catch (err) {
      // A planner/model failure must never leave a half-authored mission:
      // `.mission/` with only state.json renders as "(no objective)" and 0/0
      // checks in the TUI. The fallback plan always has real criteria/tasks.
      generated = {
        plan: this.d.fallbackPlan(clean, root),
        source: "fallback-after-error",
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
    try {
      await this.writePlanFiles(root, generated.plan, clean);
    } catch (err) {
      // If even the minimal files cannot be written, remove the workspace we
      // just created rather than leaving a broken folder behind.
      await this.d.rm(root, { recursive: true, force: true }).catch(() => {});
      const why = err instanceof Error ? err.message : String(err);
      return `Could not create the mission (${why}). No partial workspace was left behind.`;
    }
    const status = await this.start(sessionID, root, { objective: clean, autoDispatch: true });
    const waves = this.d.wavesFor(generated.plan.tasks, this.maxWorkers);
    return [
      status,
      `Plan source: ${generated.source}${generated.errors?.length ? ` (${generated.errors.join("; ")})` : ""}`,
      `Objective: ${generated.plan.objective}`,
      `Criteria: ${generated.plan.checks.map((c) => c.id).join(", ")}`,
      `${generated.plan.tasks.length} task(s) scheduled in ${waves.length} parallel wave(s) · max ${this.maxWorkers} workers`,
      `Workspace: ${root}`,
    ].join("\n");
  },

  async planAndResearch(sessionID, question) {
    const clean = String(question ?? "").trim();
    if (clean.length < 3) return "Give a research question after /mission research.";
    const slug =
      clean
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .split("-")
        .slice(0, 4)
        .join("-") || "research";
    const base = this.missionsRoot ?? path.join(this.ctx.location.directory, "missions");
    const root = path.join(base, `research-${slug}-${Date.now().toString(36)}`);
    const plan = this.d.researchPlan(clean, root);
    await this.d.ensureMission(root, { objective: plan.objective });
    await this.writePlanFiles(root, plan, clean);
    const status = await this.start(sessionID, root, { objective: clean, autoDispatch: true });
    return [
      status,
      `Research question: ${clean}`,
      `Workspace: ${root}`,
      "Report: research/report.md · sources: research/sources.json · images: research/images/",
    ].join("\n");
  },

  async continueChain(root, sessionID) {
    const roadmapText = await this.d.loadRoadmap(root);
    const items = this.d.parseRoadmap(roadmapText);
    if (items.length === 0) return false;
    const item = this.d.nextItem(items);
    if (!item) {
      await this.journal(root, "chain exhausted: all roadmap items are done");
      return false;
    }
    const plan = this.d.fallbackPlan(item.title, root);
    await this.writePlanFiles(root, plan, item.title, true);
    const state = await this.d.loadState(root);
    Object.assign(state, {
      session_id: sessionID,
      started_at: new Date().toISOString(),
      chain_index: (state.chain_index ?? 0) + 1,
      chain_total: items.length,
    });
    await Promise.all([
      this.saveStateSafe(root, state),
      this.d.saveRoadmap(root, this.d.markItemDone(roadmapText, item.id)),
    ]);
    await this.journal(
      root,
      `chain: starting mission ${state.chain_index}/${items.length} — ${item.title}`
    );
    await this.refreshBrief(sessionID, root, []);
    await this.ctx.session.prompt({
      sessionID,
      text: `[MISSION CHAIN] Mission ${state.chain_index}/${items.length}: ${item.title}\nDistilled memory from previous missions is in your brief. Continue from disk state; do not restart from scratch.`,
      delivery: "queue",
    });
    return true;
  },
};
