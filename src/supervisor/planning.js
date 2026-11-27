// planning mixin — intake flow: recon → blueprint → validated plan → start.
// Plan persistence lives in plan-files.js. Dependencies come through this.d.

import path from "node:path";

export const planning = {
  async planAndStart(sessionID, objective, options = {}) {
    const clean = String(objective ?? "").trim();
    if (clean.length < 3)
      return "Give an objective after /mission start, e.g. /mission start build a tiny CLI with three tests";

    const root = this.workspaceFor(clean, options);
    const inProject = root === this.projectDirectory();
    const createdMarker = !(await this.d.fileExists(path.join(root, ".mission", "state.json")));
    if (inProject && !createdMarker) {
      const busy = await this.d.loadState(root).catch(() => null);
      if (busy?.status === this.d.STATUS.RUNNING)
        return `A mission is already running in ${root}. Use /mission status, /mission stop or /mission resume first.`;
    }
    await this.d.ensureMission(root, { objective: clean });

    // Discovery: parallel read-only recon agents, then one architect blueprint.
    // The blueprint's structured plan is validated exactly like a planner plan;
    // if anything fails we fall back to the single planner call, which now
    // receives the blueprint as context.
    const blueprint = this.discoveryEnabled(options)
      ? await this.runDiscovery(sessionID, root, clean, options)
      : null;

    // Recon artifacts remain on disk even when the architect failed. They are
    // the deterministic source for plan repair, so read them directly instead
    // of letting a missing blueprint collapse the mission to two build checks.
    const reports = [];
    for (const area of this.d.reconAreas(options.reconAgents ?? this.options.reconAgents)) {
      const file = path.join(root, ".mission", "discovery", `${area.id}.md`);
      const text = await this.d.readText(file, "");
      if (text.trim()) reports.push({ area: area.id, text });
    }
    if (reports.length === 0 && Array.isArray(blueprint?.reports))
      reports.push(...blueprint.reports);
    const parsedProposals = this.d.parseProposals(reports);
    const proposals = { ...parsedProposals, reports };
    const bigFlag = options.big === true || this.options.bigMission === true ? true : undefined;
    const sizing = this.d.missionSizing({
      objective: clean,
      options: { ...options, big: bigFlag },
      proposals,
    });

    let generated = null;
    if (blueprint?.plan) {
      const parsed = this.d.normalizePlan(blueprint.plan, clean, root, { proposals, sizing });
      if (parsed.ok) {
        generated = { plan: parsed.plan, source: "blueprint", errors: [] };
      } else {
        await this.journal(
          root,
          `blueprint plan rejected: ${parsed.errors.join("; ")}; falling back to the planner`
        );
      }
    }
    if (!generated) {
      const extra = blueprint?.markdown
        ? `BLUEPRINT (architect, built from recon)\n${blueprint.markdown}`.slice(0, 9000)
        : "";
      try {
        const model = await this.pickPlannerModel();
        const generate = this.options.generate ?? (async () => "");
        generated = await this.d.createPlan(
          clean,
          root,
          async (args) => {
            const out = await generate(args);
            this.noteGeneration(root, out);
            return out;
          },
          { model, attempts: 2, extra }
        );
      } catch (err) {
        generated = await this.d.safeFallbackPlan(clean, root, [
          err instanceof Error ? err.message : String(err),
        ]);
        generated.source = "fallback-after-error";
      }
    }
    // Repair any plan (including the model planner's) up to the sizing target.
    const sized = this.d.normalizePlan(generated.plan, clean, root, { proposals, sizing });
    if (sized.ok) {
      generated.plan = sized.plan;
      generated.errors = [...(generated.errors ?? []), ...sized.errors];
    } else if (sizing.big && generated.plan?.checks?.length) {
      await this.journal(root, `plan repair unavailable: ${sized.errors.join("; ")}`);
    }
    const autonomy = options.autonomy ?? this.defaultAutonomy;
    if (autonomy)
      generated.plan.settings = this.unattendedSettings(generated.plan.settings, autonomy);
    // Unattended runs used to drop both loops; a large objective must keep the
    // goal audit and the deployment/e2e requirement.
    if (sizing.big) {
      generated.plan.settings.goal_audit = true;
      generated.plan.settings.require_e2e = true;
    }
    if (generated.plan?.unstartable || (generated.plan?.checks?.length ?? 0) === 0) {
      await this.removePartial(root, createdMarker, inProject);
      return [
        `Could not create a mission: ${generated.plan?.reason ?? "no real criteria could be defined"}.`,
        ...(generated.errors?.length ? [`Planner: ${generated.errors.join("; ")}`] : []),
        "Write real checks in .mission/criteria.json (or a package.json test script) and run /mission start <dir>.",
      ].join("\n");
    }
    try {
      await this.writePlanFiles(root, generated.plan, clean);
    } catch (err) {
      await this.removePartial(root, createdMarker, inProject);
      const why = err instanceof Error ? err.message : String(err);
      return `Could not create the mission (${why}). No partial workspace was left behind.`;
    }
    const state = await this.d.loadState(root);
    if (blueprint) {
      state.discovery_done = true;
      state.recon_agents = blueprint.reports.length;
      state.blueprint = "blueprint.md";
      // A mission planned from inspected reality gets the extra goal audit
      // before completion, unless the architect explicitly disabled it.
      if (blueprint.plan?.settings?.goal_audit !== false) state.goal_audit = true;
    }
    // Durable sizing + deployment gate. Only the harness writes these.
    state.sizing = sizing;
    state.require_deploy = sizing.big;
    state.deploy = { verified: false, checks: generated.plan.checks.map((c) => c.id) };
    await this.saveStateSafe(root, state);

    const status = await this.start(sessionID, root, { objective: clean, autoDispatch: true });
    const waves = this.d.wavesFor(generated.plan.tasks, this.maxWorkers);
    return [
      status,
      `Plan source: ${generated.source}${generated.errors?.length ? ` (${generated.errors.join("; ")})` : ""}`,
      ...(blueprint
        ? [
            `Discovery: ${blueprint.reports.length} recon report(s) · blueprint ${blueprint.plan ? "plan accepted" : "markdown only"} · goal audit before completion`,
          ]
        : []),
      `Objective: ${generated.plan.objective}`,
      `Criteria: ${generated.plan.checks.map((c) => c.id).join(", ")}`,
      `${generated.plan.tasks.length} task(s) scheduled in ${waves.length} parallel wave(s) · max ${this.maxWorkers} workers`,
      `Workspace: ${root}`,
    ].join("\n");
  },

  async planAndResearch(sessionID, question, options = {}) {
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
    const root = this.workspaceFor(`research ${slug}`, options);
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
    const generated = await this.d.safeFallbackPlan(item.title, root);
    const plan = generated.plan;
    // A roadmap title is rarely a verifiable criterion. Reuse the mission's
    // existing real checks instead of inventing an "anything exists" probe.
    const existing = await this.d.loadCriteria(root);
    const checks = (existing?.checks ?? []).filter((c) => c?.id && this.d.safeCheckCmd(c.cmd));
    if (!checks.length) {
      await this.journal(root, `chain skipped '${item.title}': no real criteria`);
      return false;
    }
    plan.checks = checks;
    plan.tasks = [
      {
        id: 1,
        subject: item.title.slice(0, 160),
        files: [],
        verify: checks[0].id,
        blocked_by: [],
      },
    ];
    plan.requirements = existing.requirements ?? [];
    plan.unstartable = false;
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
