/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// rolesPipeline mixin — extracted from intelligence.js.
// All dependencies are reached through this.d (set by the Supervisor).

const AGENT_RUN_LIMIT = 200;

export const rolesPipeline = {
  async dispatchReviewPair(sessionID, root, state, objective, results) {
    const prompt = this.d.reviewerPrompt({
      objective,
      workspace: root,
      checks: results.map((r) => ({ id: r.id })),
    });
    await Promise.all([
      this.dispatchRoleStage(sessionID, root, this.d.ROLE.REVIEWER, prompt),
      this.dispatchRoleStage(sessionID, root, "reviewer2", prompt),
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

  async dispatchRoleStage(sessionID, root, role, promptText) {
    const created = await this.ctx.session.create({
      parentID: sessionID,
      title: `mission ${role}`,
      location: { directory: this.ctx.location.directory },
      model: this.modelForRole(role) ?? this.pickFreeModel(await this.modelCatalog()),
    });
    const id = created?.id ?? created?.data?.id;
    if (!id) return null;
    this.bind(id, root, false);
    this.workers.set(id, { root, taskId: 0, leadID: sessionID, role });
    this.roles.set(id, role);
    this.knownWorkers.add(id);
    this.briefs.set(
      id,
      `MISSION ${role.toUpperCase()} — ${this.d.canWrite(role) ? "may write workspace files" : "read-only"}. Report with mission_report.`
    );
    let failure = null;
    try {
      await this.serialize(root, async () => {
        const s = await this.d.loadState(root);
        const model = this.modelForRole(role);
        s.agent_runs = [
          ...(s.agent_runs ?? []).filter((r) => r.sessionID !== id),
          {
            sessionID: id,
            role,
            taskId: 0,
            status: "running",
            started_at: Date.now(),
            last_heartbeat: Date.now(),
            model: model ? `${model.providerID}/${model.id}` : "",
          },
        ].slice(-AGENT_RUN_LIMIT);
        await this.saveStateSafe(root, s);
      });
      await this.ctx.session.prompt({ sessionID: id, text: promptText, delivery: "queue" });
      await this.waitWithTimeout(id, Number(this.options.workerTimeoutMs) || 600_000);
    } catch (err) {
      failure = err;
      await this.journal(root, `role ${role} failed: ${this.d.shortError(err)}`).catch(() => {});
    } finally {
      // Cleanup must happen even when the session API throws; otherwise the
      // supervisor keeps treating a dead role as an in-flight worker forever.
      await this.serialize(root, async () => {
        const s = await this.d.loadState(root);
        s.agent_runs = (s.agent_runs ?? []).map((r) =>
          r.sessionID === id ? { ...r, status: failure ? "failed" : "done" } : r
        );
        await this.saveStateSafe(root, s);
      }).catch(() => {});
      this.workers.delete(id);
      this.bySession.delete(id);
      this.roles.delete(id);
      this.briefs.delete(id);
      this.knownWorkers.delete(id);
    }
    const fresh = await this.d.loadState(root);
    return fresh.stage_reports?.[role];
  },

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

  async dispatchRoles(sessionID, root, entries) {
    return Promise.all(
      entries.map(({ role, prompt }) => this.dispatchRoleStage(sessionID, root, role, prompt))
    );
  },

  async runRolePipeline(sessionID, root, state, tasks, results, decision) {
    if (!this.enableRoles) return decision;
    const objective = this.d.objectiveOf(await this.readMission(root));
    const criteria = await this.d.loadCriteria(root);
    const extended =
      state.autonomy === "campaign" ||
      state.goal_audit === true ||
      state.needs_research === true ||
      state.research === true;
    const stage = state.stage ?? this.d.STAGE.IMPLEMENT;
    const reviewText = state.stage_reports?.review?.text ?? "";
    const next = this.d.stageFor({
      stage,
      tasksDone: tasks.length > 0 && tasks.every((t) => t.status === this.d.TASK_STATUS.COMPLETED),
      review: this.d.parseReview(reviewText),
      reviewAttempts: state.review_attempts ?? 0,
      goalAudit: extended && state.goal_audit === true,
      goalAuditDone: state.goal_audit_done === true,
      extended,
    });
    if (next.stage !== stage) {
      state.stage = next.stage;
      state.phase = next.stage;
      await this.journal(root, `stage: ${stage} → ${next.stage}`);
      await this.saveStateSafe(root, state);
    }

    if (stage === this.d.STAGE.INVESTIGATE) {
      const roles = [
        {
          role: this.d.ROLE.INVESTIGATOR,
          prompt: this.d.investigatorPrompt({ objective, workspace: root }),
        },
      ];
      if (extended && (state.needs_research === true || state.research === true)) {
        roles.push({
          role: this.d.ROLE.RESEARCHER,
          prompt: this.d.researcherPrompt({ objective, workspace: root }),
        });
      }
      const reports = await this.dispatchRoles(sessionID, root, roles);
      const investigator = reports[0];
      if (investigator?.text)
        await this.d.saveMemory(
          root,
          `${await this.d.loadMemory(root)}\nINVESTIGATION:\n${investigator.text}`.trim()
        );
      const researcher = reports[1];
      if (researcher?.text)
        await this.d.saveMemory(
          root,
          `${await this.d.loadMemory(root)}\nRESEARCH:\n${researcher.text}`.trim()
        );
      state.stage = this.d.STAGE.IMPLEMENT;
      state.phase = this.d.STAGE.IMPLEMENT;
      await this.journal(
        root,
        `investigation finished (${roles.length} agent(s)); implementers may now write`
      );
      await this.saveStateSafe(root, state);
      return { type: "continue" };
    }

    if (stage === this.d.STAGE.INTEGRATE) {
      await this.dispatchRoleStage(
        sessionID,
        root,
        this.d.ROLE.INTEGRATOR,
        this.d.integratorPrompt({ objective, workspace: root, checks: results })
      );
      await this.journal(root, "integrator finished; re-verifying");
      return { type: "continue" };
    }

    if (stage === this.d.STAGE.REVIEW && !reviewText) {
      await this.dispatchReviewPair(sessionID, root, state, objective, results);
      return { type: "continue" };
    }

    if (next.decision === "blocked") return { type: "stop", reason: "review-high" };
    if (next.decision === "retry") {
      state.review_attempts = (state.review_attempts ?? 0) + 1;
      state.stage = this.d.STAGE.IMPLEMENT;
      state.phase = this.d.STAGE.IMPLEMENT;
      const stored = await this.d.loadTasks(root);
      for (const t of stored) t.status = this.d.TASK_STATUS.PENDING;
      const leased = await this.d.loadProgress(root);
      for (const p of leased) {
        p.status = this.d.TASK_STATUS.PENDING;
        p.owner = null;
        p.lease_until = 0;
        p.attempts = 0;
      }
      if (state.stage_reports) delete state.stage_reports.review;
      await Promise.all([
        this.saveTasksSafe(root, stored),
        this.saveProgressSafe(root, leased),
        this.saveStateSafe(root, state),
      ]);
      await this.journal(root, `review requires rework (attempt ${state.review_attempts})`);
      return { type: "continue" };
    }

    if (extended && stage === this.d.STAGE.GOAL_AUDIT) {
      return this.runGoalAudit(sessionID, root, state, objective, results);
    }

    if (next.decision === "complete" && state.continuous_improvement !== false) {
      return this.runImproveCycle(sessionID, root, state, results);
    }
    if (next.decision === "complete") return decision;
    return decision;
  },
};
