// Parallel missions: one independent lead session per objective. The existing
// bySession/byRoot maps and registry already handle several running missions.

export const parallel = {
  async launchMission(objective) {
    const created = await this.ctx.session.create({
      title: `mission · ${String(objective).slice(0, 48)}`,
      location: { directory: this.ctx.location.directory },
    });
    const id = created?.id ?? created?.data?.id;
    if (!id) throw new Error("session.create returned no id");
    const reply = await this.planAndStart(id, objective);
    return `${objective} → ${id}: ${String(reply).split("\n")[0]}`;
  },

  async startParallel(leadID, arg) {
    const objectives = String(arg ?? "")
      .split(/\s*[|;]\s*|\r?\n+/)
      .map((value) => value.trim())
      .filter((value) => value.length >= 3)
      .slice(0, 8);
    if (objectives.length === 0)
      return "Usage: /mission parallel objective A | objective B | objective C (max 8)";

    const lines = [];
    for (const objective of objectives) lines.push(`- ${await this.launchMission(objective)}`);
    const currentRoot = this.rootFor(leadID);
    if (currentRoot)
      await this.journal(
        currentRoot,
        `parallel launcher: ${objectives.length} lead session(s) started`
      );
    return `Started ${lines.length} mission(s) in parallel:\n${lines.join("\n")}`;
  },
};
