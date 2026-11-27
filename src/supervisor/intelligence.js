// intelligence mixin — extracted from supervisor.js; behavior unchanged.

export const intelligence = {
  async readMission(root) {
    return this.d
      .readFile(this.d.path.join(root, ".mission", "mission.md"), "utf8")
      .catch(() => "");
  },

  inject(event) {
    const root = this.rootFor(event.sessionID);
    if (!root) return;
    const brief = this.briefs?.get(event.sessionID);
    if (brief) event.system.push({ type: "text", text: brief });
  },

  /// One disk-backed context pack for the lead, workers and roles.
  globalMemoryPath(root) {
    return this.d.path.join(
      this.missionsRoot ?? this.d.path.dirname(root),
      this.d.GLOBAL_MEMORY_FILE
    );
  },

  async refreshBrief(sessionID, root, results) {
    const [
      missionText,
      state,
      tasks,
      journal,
      memory,
      summary,
      progress,
      instructions,
      criteria,
      research,
    ] = await Promise.all([
      this.readMission(root),
      this.d.loadState(root),
      this.d.loadTasks(root),
      this.d.readJournalTail(root, this.d.JOURNAL_TAIL_CHARS),
      this.d.loadMemory(root),
      this.d.loadSummary(root),
      this.d.loadProgress(root),
      this.d.loadProjectInstructions(null, root),
      this.d.loadCriteria(root),
      this.d.readFile(this.d.path.join(root, "research", "report.md"), "utf8").catch(() => ""),
    ]);
    const globalMemory = await this.d.readFile(this.globalMemoryPath(root), "utf8").catch(() => "");
    const fullInstructions = globalMemory
      ? `${instructions}\n\n## Cross-mission memory\n${globalMemory}`
      : instructions;
    this.briefs.set(
      sessionID,
      this.d.buildBrief({
        root,
        missionText,
        state,
        tasks,
        journal,
        memory,
        summary,
        progress,
        instructions: fullInstructions,
        facts: state.facts ?? [],
        results,
        requirements: criteria.requirements ?? [],
        research,
      })
    );
  },

  async compactMemory(root, state) {
    if (state.turn === 0 || state.turn % 4 !== 0) return;
    const [journal, memory, summary] = await Promise.all([
      this.d.readJournalTail(root, this.d.JOURNAL_MEMORY_CHARS),
      this.d.loadMemory(root),
      this.d.loadSummary(root),
    ]);
    let distilled = this.d.distill({ journal, memory, summary });
    if (this.options.generate) {
      try {
        const prompt = [
          "Summarize this mission's durable memory for the next context window.",
          "Keep decisions, reasons, discarded approaches, constraints and facts. Drop noise. Output plain text only.",
          `CURRENT MEMORY:\n${memory.slice(0, 2000)}`,
          `RECENT JOURNAL:\n${journal}`,
        ].join("\n\n");
        const out = await this.options.generate({ prompt, model: this.options.fastModel });
        this.noteGeneration(root, out);
        const text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
        if (text.trim().length > 20) {
          distilled = {
            memory: text.trim().slice(0, 4000),
            summary: `Model-compacted memory at turn ${state.turn}`,
          };
        }
      } catch {
        // Keyword distill is the fallback.
      }
    }
    await Promise.all([
      this.d.saveMemory(root, distilled.memory),
      this.d.saveSummary(root, distilled.summary),
    ]);
    if (state.global_memory === true) {
      const globalPath = this.globalMemoryPath(root);
      const existing = await this.d.readFile(globalPath, "utf8").catch(() => "");
      await this.d.writeTextAtomic(
        globalPath,
        this.d.mergeGlobalMemory(existing, [distilled.memory, distilled.summary])
      );
    }
    await this.journal(
      root,
      `memory compacted: ${distilled.memory.split("\n").length} durable entries`
    );
  },

  async maybeReplan(root, state, results, tasks, force = false) {
    if (!force && (!this.d.needsReplan(state) || !this.options.generate)) return false;
    if (!this.options.generate) {
      // A blocked verdict must still break the loop when no planner model is
      // wired: reset the strategy so the next turn tries a different approach.
      Object.assign(state, this.d.afterReplan(state, state.turn));
      state.failures = 0;
      await this.saveStateSafe(root, state);
      await this.d.appendJournal(root, `blocked verdict → forced retry at turn ${state.turn}`);
      await this.notify("blocked-replan", "Relentless mission re-planned after a blocked verdict.");
      return true;
    }
    const [missionText, memory, journal] = await Promise.all([
      this.readMission(root),
      this.d.loadMemory(root),
      this.d.readJournalTail(root, 1500),
    ]);
    const prompt = this.d.replanPrompt({
      objective: this.d.objectiveOf(missionText),
      memory,
      journalTail: journal,
      results,
      tasks,
    });
    let text = "";
    try {
      const out = await this.options.generate({ prompt, model: await this.pickPlannerModel() });
      this.noteGeneration(root, out);
      text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
    } catch (err) {
      await this.journal(root, `re-plan request failed: ${this.d.shortError(err)}`);
      return false;
    }
    const parsed = this.d.normalizePlan(text, this.d.objectiveOf(missionText), root);
    if (!parsed.ok) {
      await this.journal(root, `re-plan rejected: ${parsed.errors.join("; ")}`);
      return false;
    }
    const [existingCriteria, existingTasks] = await Promise.all([
      this.d.loadCriteria(root),
      this.d.loadTasks(root),
    ]);
    const greenChecks = (state.last_checks ?? []).filter((c) => c.ok);
    const monotonic = this.d.validateMonotonic(parsed.plan, greenChecks, existingTasks);
    if (!monotonic.ok) {
      await this.journal(root, `re-plan rejected (not monotonic): ${monotonic.errors.join("; ")}`);
      return false;
    }
    const completed = existingTasks.filter((t) => t.status === this.d.TASK_STATUS.COMPLETED);
    const seen = new Set(parsed.plan.tasks.map((t) => t.id));
    const merged = [
      ...parsed.plan.tasks,
      ...completed.filter((t) => !seen.has(t.id)).map((t) => ({ ...t })),
    ].sort((a, b) => a.id - b.id);
    const planned = merged.map((t) => ({
      ...t,
      status:
        t.status === this.d.TASK_STATUS.COMPLETED
          ? this.d.TASK_STATUS.COMPLETED
          : this.d.TASK_STATUS.PENDING,
    }));
    const dir = this.d.path.join(root, ".mission");
    await Promise.all([
      this.d.writeJsonAtomic(this.d.path.join(dir, "criteria.json"), {
        version: this.d.VERSION,
        checks: parsed.plan.checks,
        requirements: parsed.plan.requirements ?? existingCriteria.requirements ?? [],
        milestones: parsed.plan.milestones ?? existingCriteria.milestones ?? [],
      }),
      this.d.writeJsonAtomic(this.d.path.join(dir, "tasks.json"), {
        version: this.d.VERSION,
        tasks: planned,
      }),
      this.saveProgressSafe(root, this.d.fromTasks(planned)),
    ]);
    state.check_baseline = this.d.markBaselineRed(
      state.check_baseline ?? {},
      parsed.plan.checks.map((c) => c.id),
      true
    );
    const next = this.d.afterReplan(state, state.turn);
    Object.assign(state, next);
    await this.saveStateSafe(root, state);
    await this.d.appendJournal(
      root,
      `re-plan applied at turn ${state.turn}: ${parsed.plan.checks.length} checks, ${planned.length} tasks (strategy reset to 1)`
    );
    if (force)
      await this.notify("blocked-replan", "Relentless mission re-planned after a blocked verdict.");
    return true;
  },
};
