// Disk-backed context gathering shared by lead, worker and role briefs.

export const supervisorContext = {
  async contextArgs(root, state, task = null) {
    const [memory, summary, instructions, journal, criteria, progress, stored] = await Promise.all([
      this.d.loadMemory(root),
      this.d.loadSummary(root),
      this.d.loadProjectInstructions(null, root),
      this.d.readJournalTail(root, this.d.JOURNAL_TAIL_CHARS),
      this.d.loadCriteria(root),
      this.d.loadProgress(root),
      this.d.loadTasks(root),
    ]);
    const tasks = Array.isArray(stored?.tasks) ? stored.tasks : [];
    return {
      state,
      memory,
      summary,
      instructions,
      journal,
      facts: Array.isArray(state?.facts) ? state.facts : [],
      results: Array.isArray(state?.last_checks) ? state.last_checks : [],
      requirements: Array.isArray(criteria?.requirements) ? criteria.requirements : [],
      progress: Array.isArray(progress) ? progress : [],
      task: task ?? this.d.selectTask(tasks),
    };
  },

  async buildWorkerBrief(root, state, task) {
    const objective = this.d.objectiveOf(await this.readMission(root));
    const context = await this.contextArgs(root, state, task);
    return this.d.workerBrief({
      task,
      objective,
      workspace: this.effectiveRoot(root, state),
      context,
      role: "implementer",
    });
  },

  async buildRoleBrief(root, state, role, prompt = "") {
    const objective = this.d.objectiveOf(await this.readMission(root));
    const context = await this.contextArgs(root, state);
    return this.d.roleBrief({ role, objective, workspace: root, prompt, context });
  },
};
