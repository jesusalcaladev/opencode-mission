// Goal audit mixin — extracts requirement gaps into verifiable tasks.
// All dependencies are reached through this.d (set by the Supervisor).

export const goalAudit = {
  async runGoalAudit(sessionID, root, state, objective, results) {
    const criteria = await this.d.loadCriteria(root);
    const existing = state.stage_reports?.["goal-auditor"]?.text ?? "";
    if (!existing) {
      const journal = await this.d.readJournalTail(root, 1500);
      await this.dispatchRoleStage(
        sessionID,
        root,
        this.d.ROLE.GOAL_AUDITOR,
        this.d.goalAuditorPrompt({
          objective,
          workspace: root,
          requirements: criteria.requirements ?? [],
          checks: results,
          journalTail: journal,
        })
      );
      const fresh = await this.d.loadState(root);
      state.stage_reports = fresh.stage_reports ?? state.stage_reports;
      await this.journal(root, "goal audit dispatched");
      return { type: "continue" };
    }

    const gaps = this.d.parseGaps(existing).filter((g) => g.text.length > 2);
    if (gaps.length === 0) {
      state.goal_audits = (state.goal_audits ?? 0) + 1;
      state.metrics = this.d.recordMetric(state.metrics, "goalAudits", 1);
      state.goal_audit_done = true;
      delete state.stage_reports["goal-auditor"];
      await this.saveStateSafe(root, state);
      await this.journal(root, "goal audit clean: objective is fully fulfilled");
      return { type: "continue" };
    }

    state.goal_audits = (state.goal_audits ?? 0) + 1;
    state.metrics = this.d.recordMetric(state.metrics, "goalAudits", 1);
    delete state.stage_reports["goal-auditor"];
    const maxAudits = this.d.effortLimit(state.max_goal_audits, 3);
    if (maxAudits > 0 && state.goal_audits >= maxAudits) {
      await this.journal(
        root,
        `goal audit found ${gaps.length} unresolved gap(s) after ${state.goal_audits} rounds`
      );
      if (!state.never_give_up) return { type: "stop", reason: "goal-gaps" };
      await this.journal(root, "relentless: goal gaps persist → rework again");
      await this.notify("goal-gaps", `Relentless mission still has ${gaps.length} goal gap(s).`);
      state.goal_audits = 0;
      state.stage = this.d.STAGE.IMPLEMENT;
      state.phase = this.d.STAGE.IMPLEMENT;
      await this.saveStateSafe(root, state);
      return { type: "continue" };
    }

    const tasks = await this.d.loadTasks(root);
    const progress = await this.d.loadProgress(root);
    const criteriaData = await this.d.loadCriteria(root);
    let nextId = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    for (const gap of gaps.slice(0, 4)) {
      let verify =
        gap.check && criteriaData.checks.some((c) => c.id === gap.check) ? gap.check : "";
      if (!verify && gap.cmd && this.d.safeCheckCmd(gap.cmd)) {
        verify = `goal-${nextId}`;
        criteriaData.checks.push({
          id: verify,
          cmd: gap.cmd,
          expect: "exit0",
          timeout_ms: 60000,
          kind: "e2e",
          retries: 0,
        });
      }
      if (!verify) continue;
      const files = gap.files.length ? gap.files : [];
      tasks.push({
        id: nextId,
        subject: `[goal gap] ${gap.text.slice(0, 120)}`,
        files,
        status: this.d.TASK_STATUS.PENDING,
        blocked_by: [],
        verify,
        milestone: "goal-gap",
      });
      progress.push({
        id: nextId,
        subject: `Goal gap: ${gap.text.slice(0, 80)}`,
        status: this.d.TASK_STATUS.PENDING,
        owner: null,
        attempts: 0,
        lease_until: 0,
        last_error: "",
        verify,
      });
      nextId += 1;
    }
    state.check_baseline = this.d.markBaselineRed(
      state.check_baseline ?? {},
      criteriaData.checks.map((c) => c.id),
      true
    );
    state.stage = this.d.STAGE.IMPLEMENT;
    state.phase = this.d.STAGE.IMPLEMENT;
    await Promise.all([
      this.saveTasksSafe(root, tasks),
      this.saveProgressSafe(root, progress),
      this.d.saveCriteria(root, criteriaData),
      this.saveStateSafe(root, state),
    ]);
    await this.journal(
      root,
      `goal audit added ${Math.max(0, nextId - (tasks.length - Math.min(gaps.length, 4)))} task(s) from gaps`
    );
    return { type: "continue" };
  },
};
