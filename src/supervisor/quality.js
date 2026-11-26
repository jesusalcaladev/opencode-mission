// Quality mixin: optional negative control for freshly completed tasks.

export const quality = {
  async runMutationCheck(root, workRoot, state, task, check) {
    if (!this.d.mutationSettings(state) || !check || !task?.files?.length)
      return { ok: true, reason: "skipped" };
    const tmp = this.d.path.join(this.d.os.tmpdir(), `mission-mutation-${Date.now()}-${task.id}`);
    try {
      await this.d.cp(workRoot, tmp, {
        recursive: true,
        filter: (source) => !/(^|\/)(?:\.git|\.mission|node_modules|dist|build)(\/|$)/.test(source),
      });
      for (const file of task.files)
        await this.d.rm(this.d.path.resolve(tmp, file), { recursive: true, force: true });
      const [mutated] = await this.d.runChecks(tmp, { checks: [check] }, { cache: null });
      const decision = this.d.mutationDecision({
        mutatedOk: Boolean(mutated?.ok),
        files: task.files,
        enabled: true,
      });
      if (!decision.ok) {
        await this.journal(
          root,
          `vacuous check ${task.verify}: still green without ${task.files.join(", ")}`
        );
        await this.notify(
          "vacuous-check",
          `Check ${task.verify} passes without ${task.files.join(", ")}; task reopened.`
        );
      }
      return decision;
    } catch (err) {
      await this.journal(root, `mutation check unavailable: ${this.d.shortError(err)}`).catch(
        () => {}
      );
      return { ok: true, reason: "mutation-unavailable" };
    } finally {
      await this.d.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  },
};
