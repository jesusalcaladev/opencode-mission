// Workspace selection and safe partial cleanup. Generated missions live in the
// user's current project by default; sandboxes are opt-in.

import path from "node:path";

export const workspaces = {
  /// File-ownership guard shared by mission_write. Returns the normalized path
  /// or a refusal message; no bytes are written here.
  async writeGuard(sessionID, root, rel) {
    const normalized = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
    const worker = this.workers.get(sessionID);
    if (worker?.taskId) {
      const owner = this.d.lockedBy(this.fileLocks, normalized);
      if (owner !== null && owner !== worker.taskId)
        return {
          ok: false,
          error: `Refusing to write ${normalized}: file is locked by task #${owner}.`,
        };
      const assigned =
        (await this.d.loadTasks(root)).find((t) => t.id === worker.taskId)?.files ?? [];
      if (
        assigned.length > 0 &&
        !assigned.some((f) => normalized === f || normalized.startsWith(`${f}/`))
      )
        return {
          ok: false,
          error: `Refusing to write outside task #${worker.taskId} files: ${normalized}`,
        };
    }
    return { ok: true, normalized };
  },

  /// Settings for `/mission start --long`: no soft turn ceiling, generous hard
  /// caps, and no goal-audit loop that needs a model just to finish.
  unattendedSettings(previous = {}, autonomy = "relentless") {
    const unattended = autonomy === "relentless";
    return this.d.normalizeSettings({
      ...previous,
      autonomy,
      max_turns: unattended ? 0 : 40,
      auto_extend: true,
      max_wallclock_min: 480,
      hard_budget_usd: 25,
      max_failures: 0,
      goal_audit: false,
      require_e2e: false,
    });
  },

  projectDirectory() {
    return path.resolve(this.ctx.location?.directory ?? process.cwd());
  },

  workspaceFor(objective, options = {}) {
    if (options.workspace) return path.resolve(options.workspace);
    if ((this.options.workspaceMode ?? "project") === "project") return this.projectDirectory();
    const base = this.missionsRoot ?? path.join(this.projectDirectory(), "missions");
    const slug =
      String(objective ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .split("-")
        .slice(0, 4)
        .join("-") || "mission";
    return path.join(base, `${slug}-${Date.now().toString(36)}`);
  },

  /// In project mode the workspace IS the user's repository: deleting it on a
  /// failure would be catastrophic. Only remove `.mission/` when we created it.
  async removePartial(root, createdMarker, inProject) {
    const target =
      inProject && root === this.projectDirectory() ? path.join(root, ".mission") : root;
    if (inProject && !createdMarker) return;
    await this.d
      .rm(target, { recursive: true, force: true })
      .catch((err) => this.warn(root, "partial mission cleanup failed", err));
  },
};
