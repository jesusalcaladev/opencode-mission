// plan-files mixin — persists a validated plan. Extracted from planning.js so
// the intake flow (recon → blueprint → plan) stays readable.

import * as d from "./deps.js";
const { path, mkdir } = d;

export const planFiles = {
  async writePlanFiles(root, plan, original, _force = false) {
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
      `max_tokens: ${s.max_tokens ?? 0}`,
      `auto_extend: ${s.auto_extend ?? false}`,
      `max_extensions: ${s.max_extensions ?? 3}`,
      `extension_turns: ${s.extension_turns ?? 8}`,
      `extension_writes: ${s.extension_writes ?? 50}`,
      `extension_budget_usd: ${s.extension_budget_usd ?? 5}`,
      `goal_audit: ${s.goal_audit ?? false}`,
      `max_goal_audits: ${s.max_goal_audits ?? 3}`,
      `autonomy: ${s.autonomy ?? "standard"}`,
      `never_give_up: ${s.never_give_up === true}`,
      `max_task_attempts: ${s.max_task_attempts ?? 3}`,
      `max_review_attempts: ${s.max_review_attempts ?? 2}`,
      `mutation_checks: ${s.mutation_checks === true}`,
      `require_e2e: ${s.require_e2e === true}`,
      `strict_checks: ${s.strict_checks === true}`,
      `sandbox: ${s.sandbox === "copy" ? "copy" : "none"}`,
      `global_memory: ${s.global_memory === true}`,
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
      ...(plan.definition_of_done ?? []).map((item) => `- DONE: ${item}`),
    ].join("\n");
    await this.d.writeTextAtomic(path.join(dir, "mission.md"), `${frontmatter}\n`);
    await this.d.writeJsonAtomic(path.join(dir, "criteria.json"), {
      version: this.d.VERSION,
      checks: plan.checks,
      requirements: plan.requirements ?? [],
      milestones: plan.milestones ?? [],
      definition_of_done: plan.definition_of_done ?? [],
    });
    const planned = plan.tasks.map((task) => ({ ...task, status: "pending" }));
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
      review_attempts: 0,
      goal_audits: 0,
      cost_extra_usd: 0,
    });
    await this.saveStateSafe(root, state);
  },
};
