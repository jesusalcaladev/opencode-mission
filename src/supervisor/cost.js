// Cost mixin: the lead is not the only spender. Workers, roles and direct
// generate() calls all belong to the same mission budget.

export const cost = {
  async sessionUsage(sessionID) {
    try {
      const messages = await this.ctx.session.context({ sessionID });
      return {
        cost: this.d.costFromContext(messages),
        tokens: this.d.tokensFromContext(messages),
      };
    } catch {
      return { cost: null, tokens: null };
    }
  },

  noteGeneration(root, out) {
    if (!root) return 0;
    const value = this.d.generationCost(out);
    if (value <= 0) return 0;
    if (!this.generationCosts) this.generationCosts = new Map();
    const total = (this.generationCosts.get(root) ?? 0) + value;
    this.generationCosts.set(root, total);
    return value;
  },

  recordedCostEntries(state, extra = 0) {
    const runs = Array.isArray(state?.agent_runs) ? state.agent_runs : [];
    const entries = runs.map((r) => ({ sessionID: r?.sessionID, cost: r?.cost ?? 0 }));
    if (extra > 0) entries.push({ sessionID: "generation", cost: extra });
    return entries;
  },

  missionCostTotal(state, extra = 0) {
    return (
      this.d.mergeCosts(this.recordedCostEntries(state, extra)) +
      (Number(state?.cost_extra_usd) || 0)
    );
  },

  async updateMissionCost(root, state, leadID) {
    const ids = this.d.sessionIDsForMission({
      leadID,
      boundIDs: [...(this.bySession ?? new Map())]
        .filter(([, boundRoot]) => boundRoot === root)
        .map(([id]) => id),
      workerSessions: state.worker_sessions ?? [],
      agentRuns: state.agent_runs ?? [],
    });
    const live = await Promise.all(
      ids.map(async (id) => {
        const usage = await this.sessionUsage(id);
        return { sessionID: id, cost: usage.cost, tokens: usage.tokens?.total ?? 0 };
      })
    );
    const extra = (this.generationCosts?.get(root) ?? 0) + (Number(state.cost_extra_usd) || 0);
    state.cost_usd = this.d.applyCost(
      state,
      this.d.mergeCosts([...live, ...this.recordedCostEntries(state, extra)])
    );
    state.tokens = Math.max(
      Number(state.tokens) || 0,
      this.d.mergeTokenEntries([
        ...live,
        ...(state.agent_runs ?? []).map((r) => ({ tokens: r.tokens })),
      ])
    );
    return state.cost_usd;
  },

  async recordWorkerCost(root, fresh, sessionID) {
    const usage = await this.sessionUsage(sessionID);
    if (usage.cost === null && !usage.tokens) return null;
    fresh.agent_runs = (fresh.agent_runs ?? []).map((run) =>
      run.sessionID === sessionID
        ? {
            ...run,
            cost: Math.max(Number(run.cost) || 0, usage.cost ?? 0),
            tokens: Math.max(Number(run.tokens) || 0, usage.tokens?.total ?? 0),
          }
        : run
    );
    fresh.cost_usd = this.d.applyCost(
      fresh,
      this.missionCostTotal(fresh, this.generationCosts?.get(root) ?? 0)
    );
    fresh.tokens = Math.max(
      Number(fresh.tokens) || 0,
      this.d.mergeTokenEntries(fresh.agent_runs ?? [])
    );
    return usage.cost;
  },
};
