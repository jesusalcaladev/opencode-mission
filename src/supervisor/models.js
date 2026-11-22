// model selection mixin — extracted from recovery.js.
// All dependencies are reached through this.d (set by the Supervisor).

export const models = {
  async modelCatalog() {
    try {
      const listed = await this.ctx.model.list();
      let models = Array.isArray(listed) ? listed : (listed?.data ?? []);
      if (!Array.isArray(models) && listed && typeof listed === "object") {
        models = Object.values(listed).flatMap((v) => (Array.isArray(v) ? v : []));
      }
      return models.filter((m) => m?.id && m?.providerID);
    } catch {
      return [];
    }
  },

  pickFreeModel(models, exclude) {
    const free = models.filter(
      (m) =>
        (m.cost?.[0]?.output ?? 0) === 0 &&
        m.capabilities?.tools !== false &&
        !(m.id === exclude?.id && m.providerID === exclude?.providerID)
    );
    free.sort((a, b) => Number(b.providerID === "opencode") - Number(a.providerID === "opencode"));
    const chosen = free[0];
    return chosen ? { providerID: chosen.providerID, id: chosen.id } : undefined;
  },

  async pickPlannerModel() {
    if (this.options.plannerModel) return this.options.plannerModel;
    return this.pickFreeModel(await this.modelCatalog());
  },

  async ensureWorkingModel(sessionID, root) {
    if (this.options.model) {
      await this.ctx.session.switchModel({ sessionID, model: this.options.model });
      if (root)
        await this.journal(
          root,
          `model configured: ${this.options.model.providerID}/${this.options.model.id}`
        );
      return this.options.model;
    }
    const catalog = await this.modelCatalog();
    const session = await this.ctx.session.get({ sessionID }).catch(() => null);
    const current = session?.model;
    if (current) {
      const info = catalog.find((m) => m.id === current.id && m.providerID === current.providerID);
      if (info && (info.cost?.[0]?.output ?? 0) === 0) return current;
    }
    const free = this.pickFreeModel(catalog, current);
    if (!free) return undefined;
    try {
      await this.ctx.session.switchModel({ sessionID, model: free });
      if (root) await this.journal(root, `model auto-selected: ${free.providerID}/${free.id}`);
    } catch {
      return undefined;
    }
    return free;
  },

  /// Cheap/fast models for read-only roles, a stronger one for implementers.
  modelForRole(role) {
    const byRole = this.options.modelsByRole ?? this.options.models_by_role ?? {};
    if (byRole[role]) return byRole[role];
    if (role === "implementer" && this.options.model) return this.options.model;
    if (this.options.fastModel) return this.options.fastModel;
    return this.options.model ?? undefined;
  },
};
