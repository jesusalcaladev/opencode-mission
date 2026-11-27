// Safe handoff: prepare a fresh session but keep the old lead bound until the
// first prompt is actually delivered. A failed delivery rolls back instead of
// orphaning a RUNNING mission on a dead session id.

export const handoff = {
  async beginHandoff(sessionID, root, state) {
    const pending = this.pendingHandoffs?.get(sessionID);
    if (pending) return pending;
    const due =
      state.handoff_every_turns > 0 &&
      state.turn - (state.last_handoff_turn ?? 0) >= state.handoff_every_turns;
    if (!due) return sessionID;
    try {
      const created = await this.ctx.session.create({
        title: `mission ${state.id ?? "mission"} · turn ${state.turn}`,
        location: { directory: this.ctx.location.directory },
      });
      const newID = created?.id ?? created?.data?.id;
      if (!newID || newID === sessionID) return sessionID;
      this.pendingHandoffs.set(sessionID, newID);
      // Non-lead binding: the new session can use tools and receive prompts,
      // but the old session still owns rootFor()/idle handling for now.
      this.bind(newID, root, false);
      await this.journal(root, `context handoff prepared ${sessionID} → ${newID}`);
      return newID;
    } catch (err) {
      await this.journal(root, `handoff failed, staying in session: ${this.d.shortError(err)}`);
      return sessionID;
    }
  },

  async finalizeHandoff(sessionID, newID, root, state) {
    if (!newID || newID === sessionID) return;
    this.pendingHandoffs.delete(sessionID);
    this.unbind(sessionID);
    this.bind(newID, root);
    const handoffs = this.d.recordHandoff(state, sessionID, newID, state.turn);
    const metrics = this.d.recordMetric(state.metrics, "handoffs", 1);
    await this.serialize(root, async () => {
      const fresh = await this.d.loadState(root);
      fresh.session_id = newID;
      fresh.last_handoff_turn = state.turn;
      fresh.handoffs = handoffs;
      fresh.metrics = metrics;
      await this.saveStateSafe(root, fresh);
    });
    await this.persistBinding(newID, root);
    const fresh = await this.d.loadState(root);
    await this.publishRegistry(
      root,
      fresh,
      this.d.objectiveOf(await this.readMission(root).catch(() => ""))
    );
    await this.ctx.session
      .synthetic({ sessionID, text: `[MISSION HANDOFF] Continuing in session ${newID}.` })
      .catch((err) => this.warn(root, "handoff notice failed", err));
  },

  async rollbackHandoff(sessionID, newID, root) {
    if (!newID || newID === sessionID) return;
    this.pendingHandoffs.delete(sessionID);
    this.unbind(newID);
    await this.journal(root, `handoff to ${newID} did not deliver; staying in ${sessionID}`);
  },
};
