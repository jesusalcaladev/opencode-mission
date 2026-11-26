// Independent review pair. The second reviewer uses a different model when the
// catalog has one, so `combineReviews` is a real second opinion, not an echo.

export const reviews = {
  async dispatchReviewPair(sessionID, root, state, objective, results) {
    const prompt = this.d.reviewerPrompt({
      objective,
      workspace: root,
      checks: results.map((r) => ({ id: r.id })),
    });
    const catalog = await this.modelCatalog();
    const firstModel = this.modelForRole(this.d.ROLE.REVIEWER) ?? this.pickFreeModel(catalog);
    const secondModel =
      this.modelForRole("reviewer2") ?? this.pickFreeModel(catalog, firstModel) ?? firstModel;
    await Promise.all([
      this.dispatchRoleStage(sessionID, root, this.d.ROLE.REVIEWER, prompt, firstModel),
      this.dispatchRoleStage(sessionID, root, "reviewer2", prompt, secondModel),
    ]);
    const fresh = await this.d.loadState(root);
    const first = fresh.stage_reports?.reviewer?.text ?? state.stage_reports?.reviewer?.text ?? "";
    const second =
      fresh.stage_reports?.reviewer2?.text ?? state.stage_reports?.reviewer2?.text ?? "";
    state.stage_reports = state.stage_reports ?? {};
    state.stage_reports.review = {
      text: this.d.combineReviews(first, second),
      at: new Date().toISOString(),
    };
    await this.saveStateSafe(root, state);
    await this.journal(
      root,
      "two independent reviewers completed in parallel; completion held until review is clean"
    );
  },
};
