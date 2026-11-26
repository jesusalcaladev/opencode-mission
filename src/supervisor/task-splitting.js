// Stuck-task decomposition: turns one failed task into independent,
// verifiable subtasks. Extracted from roles-pipeline.js.

export const taskSplitting = {
  async maybeSplitStuckTask(root, state, tasks) {
    if (!this.options.generate || !state.auto_extend) return false;
    const progress = await this.d.loadProgress(root);
    const criteria = await this.d.loadCriteria(root);
    const checkIds = new Set((criteria.checks ?? []).map((c) => c.id));
    const stuck = tasks.find((t) => {
      const p = progress.find((x) => x.id === t.id);
      return (
        t.status !== this.d.TASK_STATUS.COMPLETED &&
        (p?.attempts ?? 0) >= 2 &&
        (t.files?.length ?? 0) > 0
      );
    });
    if (!stuck) return false;
    const lastSplit = Number(state.last_split_turn ?? 0);
    if ((state.turn ?? 0) - lastSplit < 4) return false;
    let text = "";
    try {
      const out = await this.options.generate({
        prompt: this.d.splitPrompt({
          objective: this.d.objectiveOf(await this.readMission(root)),
          task: stuck,
          attempts: progress.find((p) => p.id === stuck.id)?.attempts ?? 2,
        }),
        model: this.options.fastModel,
      });
      this.noteGeneration(root, out);
      text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
    } catch {
      return false;
    }
    const parsed = /\{[\s\S]*\}/.exec(text);
    let subtasks = [];
    try {
      subtasks = parsed ? (JSON.parse(parsed[0]).tasks ?? []) : [];
    } catch {
      return false;
    }
    if (!Array.isArray(subtasks) || subtasks.length < 2 || subtasks.length > 5) return false;
    const stored = await this.d.loadTasks(root);
    const leased = await this.d.loadProgress(root);
    let nextId = stored.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    const children = [];
    for (const item of subtasks) {
      const verify =
        typeof item?.verify === "string" && checkIds.has(item.verify) ? item.verify : stuck.verify;
      if (!verify || !checkIds.has(verify)) continue;
      const subject = typeof item?.subject === "string" ? item.subject.trim().slice(0, 140) : "";
      if (subject.length < 4) continue;
      children.push({
        id: nextId,
        subject,
        files: Array.isArray(item.files) ? item.files.slice(0, 10).map(String) : [],
        verify,
      });
      nextId += 1;
    }
    if (children.length < 2) return false;
    const childIds = children.map((c) => c.id);
    const parent = stored.find((t) => t.id === stuck.id);
    if (parent) {
      parent.blocked_by = [...new Set([...(parent.blocked_by ?? []), ...childIds])];
      parent.status = this.d.TASK_STATUS.PENDING;
    }
    for (const child of children) {
      stored.push({
        ...child,
        status: this.d.TASK_STATUS.PENDING,
        blocked_by: [],
        milestone: stuck.milestone ?? "",
      });
      leased.push({
        id: child.id,
        subject: child.subject,
        status: this.d.TASK_STATUS.PENDING,
        owner: null,
        attempts: 0,
        lease_until: 0,
        last_error: "",
        verify: child.verify,
      });
    }
    state.last_split_turn = state.turn;
    state.metrics = this.d.recordMetric(state.metrics, "splits", 1);
    await Promise.all([
      this.saveTasksSafe(root, stored),
      this.saveProgressSafe(root, leased),
      this.saveStateSafe(root, state),
    ]);
    await this.journal(
      root,
      `split stuck task #${stuck.id} into ${children.map((c) => `#${c.id}`).join(", ")}`
    );
    return true;
  },
};
