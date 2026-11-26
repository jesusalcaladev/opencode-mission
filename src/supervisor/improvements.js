// improvements mixin — extracted from intelligence.js.
// All dependencies are reached through this.d (set by the Supervisor).

export const improvements = {
  async runImproveCycle(sessionID, root, state, _results) {
    const report = state.stage_reports?.auditor?.text ?? "";
    if (!report) {
      const answer = await this.dispatchRoleStage(
        sessionID,
        root,
        "auditor",
        `[MISSION AUDITOR] Workspace: ${root}\nRead-only. Find real improvements and emit one line each:\nFINDING: impact=high|medium|low risk=low|medium|high files=a.js,b.js description\nCall mission_report(role='auditor', text=...). If nothing valuable, write 'NO FINDINGS'.`
      );
      state.stage_reports = state.stage_reports ?? {};
      state.stage_reports.auditor = {
        text: answer?.text ?? "NO FINDINGS",
        at: new Date().toISOString(),
      };
      await this.saveStateSafe(root, state);
      await this.journal(root, "improvement audit dispatched");
      return { type: "continue" };
    }

    const findings = this.d.rankFindings(
      this.d.parseFindings(report),
      state.min_impact ?? "medium"
    );
    const decision = this.d.cycleDecision({
      finding: findings[0],
      improveCycles: state.improve_cycles ?? 0,
      maxCycles: state.max_improve_cycles ?? 5,
      cleanRounds: state.clean_audit_rounds ?? 0,
      maxCleanRounds: state.max_clean_audit_rounds ?? 2,
      stopFile: await this.d.stopRequested(root),
      outOfBudget: this.d.budgetExhausted(state),
    });

    if (decision.type === "stop") {
      await this.journal(root, `continuous improvement stopping: ${decision.reason}`);
      return { type: "complete", reason: decision.reason };
    }
    if (decision.type === "audit") {
      state.clean_audit_rounds = (state.clean_audit_rounds ?? 0) + 1;
      delete state.stage_reports.auditor;
      await this.saveStateSafe(root, state);
      await this.journal(
        root,
        `audit round without valuable findings (${state.clean_audit_rounds}/${state.max_clean_audit_rounds ?? 2})`
      );
      return { type: "continue" };
    }

    const finding = decision.finding;
    const tasks = await this.d.loadTasks(root);
    const id = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    const subject = `[improve ${finding.impact}] ${finding.text.slice(0, 120)}`;
    tasks.push({
      id,
      subject,
      files: finding.files,
      status: this.d.TASK_STATUS.PENDING,
      blocked_by: [],
      verify: "",
    });
    const progress = await this.d.loadProgress(root);
    progress.push({
      id,
      subject,
      status: this.d.TASK_STATUS.PENDING,
      owner: null,
      attempts: 0,
      lease_until: 0,
      last_error: "",
      verify: "",
    });
    state.improve_cycles = (state.improve_cycles ?? 0) + 1;
    state.metrics = this.d.recordMetric(state.metrics, "improvements", 1);
    state.active_improve_id = id;
    state.improve_revert_sha = state.last_commit ?? "";
    state.stage = this.d.STAGE.IMPLEMENT;
    state.clean_audit_rounds = 0;
    delete state.stage_reports.auditor;
    await Promise.all([
      this.saveTasksSafe(root, tasks),
      this.saveProgressSafe(root, progress),
      this.saveStateSafe(root, state),
    ]);
    const line = `- [ ] id: imp-${id} | impact: ${finding.impact} | risk: ${finding.risk} | files: ${finding.files.join(",")} | ${finding.text.slice(0, 120)}`;
    await this.d.saveImprovements(root, `${await this.d.loadImprovements(root)}${line}\n`);
    await this.journal(root, `improvement cycle ${state.improve_cycles}: #${id} ${subject}`);
    return { type: "continue" };
  },
};
