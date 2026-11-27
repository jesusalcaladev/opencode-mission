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
    // Parallel missions must never share one workspace. Give each one an
    // isolated directory instead of letting them race on the same .mission/.
    const slug =
      String(objective)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .split("-")
        .slice(0, 3)
        .join("-") || "mission";
    const base = this.missionsRoot ?? this.d.path.join(this.currentDirectory, "missions");
    const workspace = this.d.path.join(
      base,
      `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    );
    const reply = await this.planAndStart(id, objective, { workspace });
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
