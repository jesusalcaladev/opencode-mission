// End-of-mission report mixin. Every terminal state (complete, blocked, aborted)
// leaves a detailed MISSION_REPORT.md in the workspace: what was done, how it was
// verified, which agents/models/costs were used, what changed and what is next.

export const missionReport = {
  async writeMissionReport(root, state) {
    const workspace = this.effectiveRoot(root, state);
    const inputs = await this.d.collectReportInputs(root, workspace);
    const git = await this.d.gitSummary(workspace);
    const markdown = this.d.buildMissionReport({
      ...inputs,
      state: { ...inputs.state, ...state },
      git,
    });
    await this.d.writeTextAtomic(this.d.path.join(root, this.d.REPORT_FILE), markdown);
    state.report_path = this.d.REPORT_FILE;
    await this.journal(root, `report written: ${this.d.REPORT_FILE}`);
    return this.d.REPORT_FILE;
  },
};
