// Discovery phase mixin: recon agents inspect the project, an architect turns
// their reports into a blueprint, and the harness harvests a validated plan from
// it. Artifacts live in `.mission/discovery/` and `.mission/blueprint.md`, so a
// resumed mission reuses the work instead of paying for it twice.

import path from "node:path";

export const discovery = {
  /// Discovery is on by default when specialised roles are available; a command
  /// can opt out (`/mission start --quick`) and an install can disable it.
  discoveryEnabled(options = {}) {
    if (!this.enableRoles) return false;
    if (options.discovery === false) return false;
    if (options.discovery === true) return true;
    return this.options.discovery !== false;
  },

  reconFile(root, areaId) {
    return path.join(root, ".mission", "discovery", `${areaId}.md`);
  },

  async cachedRecon(root, area) {
    const text = await this.d.readText(this.reconFile(root, area.id), "");
    return text.trim() ? text.trim().slice(0, 12000) : "";
  },

  /// One read-only agent per area, in parallel. A failing agent is a missing
  /// report, never a failed mission: the planner path still runs.
  async runRecon(sessionID, root, objective, options = {}) {
    const areas = this.d.reconAreas(options.reconAgents ?? this.options.reconAgents);
    const reports = [];
    const missing = [];
    for (const area of areas) {
      const cached = await this.cachedRecon(root, area);
      if (cached) reports.push({ area: area.id, text: cached, cached: true });
      else missing.push(area);
    }
    if (reports.length > 0)
      await this.journal(root, `recon reused from disk: ${reports.map((r) => r.area).join(", ")}`);
    if (missing.length === 0) {
      // A resumed mission still gets the recon memo in every brief.
      await this.saveReconMemory(root, reports);
      return reports;
    }

    await this.journal(
      root,
      `dispatching ${missing.length} recon agent(s): ${missing.map((a) => a.id).join(", ")}`
    );
    // Recon is a bounded read; a stuck agent must not block the intake forever.
    const timeoutMs = Number(this.options.reconTimeoutMs) || 300_000;
    const entries = missing.map((area) => ({
      role: area.role,
      prompt: this.d.reconPrompt({ objective, workspace: root, area }),
      timeoutMs,
    }));
    let answers = [];
    try {
      answers = await this.dispatchRoles(sessionID, root, entries);
    } catch (err) {
      await this.journal(root, `recon dispatch failed: ${this.d.shortError(err)}`);
    }
    for (let index = 0; index < missing.length; index += 1) {
      const area = missing[index];
      const text = String(answers?.[index]?.text ?? "").trim();
      if (!text) {
        await this.journal(root, `recon ${area.id} returned nothing; continuing without it`);
        continue;
      }
      await this.d.writeTextAtomic(this.reconFile(root, area.id), `${text}\n`);
      reports.push({ area: area.id, text, cached: false });
    }
    if (reports.length > 0) await this.saveReconMemory(root, reports);
    return reports;
  },

  async saveReconMemory(root, reports) {
    const memo = this.d.reconMemo(reports, 4500);
    const memory = await this.d.loadMemory(root);
    await this.d.saveMemory(root, this.d.mergeReconMemo(memory, memo));
  },

  /// The architect is one read-only agent with every recon report in its brief.
  /// A cached blueprint (or blueprint.json) is reused verbatim.
  async runArchitect(sessionID, root, objective, reports) {
    const dir = path.join(root, ".mission");
    const docFile = path.join(dir, "blueprint.md");
    const planFile = path.join(dir, "blueprint.json");
    const objectiveFile = path.join(dir, "blueprint-objective.txt");
    // A blueprint is evidence for ONE objective. Reusing a previous small plan
    // for a new, much larger objective was a direct cause of tiny missions.
    const cachedObjective = (await this.d.readText(objectiveFile, "")).trim();
    const requested = String(objective ?? "").trim();
    const legacyPlan = await this.d.readJson(planFile, null);
    // Older blueprints have no objective marker; their own plan objective is
    // the fallback signal so a cached plan from the same request still works.
    const sameObjective = cachedObjective
      ? cachedObjective === requested
      : !legacyPlan?.objective || String(legacyPlan.objective).trim() === requested;
    const cachedPlan = sameObjective ? legacyPlan : null;
    const cachedDoc = sameObjective ? await this.d.readText(docFile, "") : "";
    if (cachedPlan?.checks && cachedPlan?.tasks) {
      await this.journal(root, "blueprint reused from disk (structured plan)");
      return { plan: cachedPlan, markdown: cachedDoc, error: "" };
    }
    if (cachedDoc.trim()) {
      const parsed = this.d.parseBlueprint(cachedDoc);
      await this.journal(
        root,
        `blueprint reused from disk (${parsed.plan ? "structured plan" : "markdown only"})`
      );
      return parsed;
    }

    const memo = this.d.reconMemo(reports);
    const answer = await this.dispatchRoleStage(
      sessionID,
      root,
      "architect",
      this.d.architectPrompt({ objective, workspace: root, memo }),
      null,
      Number(this.options.reconTimeoutMs) || 300_000
    );
    const text = String(answer?.text ?? "").trim();
    if (!text) {
      await this.journal(root, "architect returned no blueprint");
      return null;
    }
    const parsed = this.d.parseBlueprint(text);
    await this.d.writeTextAtomic(docFile, `${parsed.markdown || text}\n`);
    await this.d.writeTextAtomic(objectiveFile, String(objective ?? "").trim());
    if (parsed.plan) await this.d.writeJsonAtomic(planFile, parsed.plan);
    await this.journal(
      root,
      `blueprint written (${parsed.plan ? `${parsed.plan.checks.length} checks, ${parsed.plan.tasks.length} tasks` : "no plan json"})`
    );
    return parsed;
  },

  /// Full prelude. Returns `{ reports, plan, markdown }` or null when nothing
  /// usable was produced; the caller then falls back to the single planner call.
  async runDiscovery(sessionID, root, objective, options = {}) {
    const started = Date.now();
    try {
      const reports = await this.runRecon(sessionID, root, objective, options);
      if (reports.length === 0) {
        await this.journal(root, "discovery produced no recon reports; using the planner");
        return null;
      }
      const blueprint = await this.runArchitect(sessionID, root, objective, reports);
      const plan = blueprint?.plan ?? this.d.harvestPlan(reports, objective, root);
      if (!plan) {
        await this.journal(root, "discovery found no structured plan; using the planner");
        return null;
      }
      const state = await this.d.loadState(root);
      state.metrics = this.d.recordMetric(state.metrics, "reconAgents", reports.length);
      await this.saveStateSafe(root, state);
      await this.journal(
        root,
        `discovery finished in ${Date.now() - started}ms: ${reports.length} recon report(s), ` +
          `${blueprint?.plan ? "architect plan" : "harvested plan"}`
      );
      return { reports, plan, markdown: blueprint?.markdown ?? "" };
    } catch (err) {
      await this.journal(root, `discovery skipped: ${this.d.shortError(err)}`);
      return null;
    }
  },
};
