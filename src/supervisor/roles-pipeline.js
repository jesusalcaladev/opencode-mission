// rolesPipeline mixin — extracted from intelligence.js.
// All dependencies are reached through this.d (set by the Supervisor).

const AGENT_RUN_LIMIT = 200;

export const rolesPipeline = {
  async dispatchRoleStage(
    sessionID,
    root,
    role,
    promptText,
    modelOverride = null,
    timeoutMs = null
  ) {
    const chosen =
      modelOverride ?? this.modelForRole(role) ?? this.pickFreeModel(await this.modelCatalog());
    const created = await this.ctx.session.create({
      parentID: sessionID,
      title: `mission ${role}`,
      location: { directory: this.ctx.location.directory },
      model: chosen,
    });
    const id = created?.id ?? created?.data?.id;
    if (!id) return null;
    this.bind(id, root, false);
    this.workers.set(id, { root, taskId: 0, leadID: sessionID, role });
    this.roles.set(id, role);
    this.knownWorkers.add(id);
    try {
      this.briefs.set(
        id,
        await this.buildRoleBrief(root, await this.d.loadState(root), role, promptText)
      );
    } catch (err) {
      this.unbind(id);
      this.workers.delete(id);
      this.roles.delete(id);
      this.knownWorkers.delete(id);
      await this.appendJournal(root, `role ${role} brief failed: ${this.d.shortError(err)}`).catch(
        () => {}
      );
      return null;
    }
    let failure = null;
    try {
      await this.serialize(root, async () => {
        const s = await this.d.loadState(root);
        const model = chosen;
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
      const budget = Number(timeoutMs) || Number(this.options.workerTimeoutMs) || 600_000;
      await this.waitWithTimeout(id, budget);
    } catch (err) {
      failure = err;
      await this.journal(root, `role ${role} failed: ${this.d.shortError(err)}`).catch((cause) =>
        this.warn(root, `role ${role} failure journal`, cause)
      );
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

  async dispatchRoles(sessionID, root, entries) {
    return Promise.all(
      entries.map(({ role, prompt, timeoutMs }) =>
        this.dispatchRoleStage(sessionID, root, role, prompt, null, timeoutMs)
      )
    );
  },

  async runRolePipeline(sessionID, root, state, tasks, results, decision) {
    if (!this.enableRoles) return decision;
    const objective = this.d.objectiveOf(await this.readMission(root));
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
      maxReviewAttempts: this.d.effortLimit(state.max_review_attempts, this.d.MAX_REVIEW_ATTEMPTS),
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
      // Discovery already inspected the project before planning; running the
      // investigator again would burn turns and produce duplicate findings.
      if (state.discovery_done) {
        state.stage = this.d.STAGE.IMPLEMENT;
        state.phase = this.d.STAGE.IMPLEMENT;
        await this.journal(
          root,
          `recon already done before planning (${state.recon_agents ?? 0} agent(s)); skipping duplicate investigation`
        );
        await this.saveStateSafe(root, state);
        return { type: "continue" };
      }
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

    if (next.decision === "blocked" && state.never_give_up) {
      await this.journal(root, "relentless: review-high → unlimited rework");
      await this.notify(
        "review-rework",
        "Relentless mission is reworking unresolved review findings."
      );
    }
    if (next.decision === "blocked" && !state.never_give_up)
      return { type: "stop", reason: "review-high" };
    if (next.decision === "retry" || next.decision === "blocked") {
      const fingerprint = this.d.reviewFingerprint(state.stage_reports?.review?.text);
      const seenBefore = this.d.alreadyReworked(state, fingerprint);
      if (seenBefore) {
        await this.journal(root, "review finding already reworked; keeping task progress");
        return { type: "continue" };
      }
      state.review_fingerprints = [...(state.review_fingerprints ?? []), fingerprint].slice(-10);
      state.review_attempts = next.decision === "blocked" ? 0 : (state.review_attempts ?? 0) + 1;
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

    if (next.decision === "complete") {
      // The stage machine must not manufacture a second, unguarded completion.
      const allGreen = Array.isArray(results) && results.length > 0 && results.every((r) => r.ok);
      const allTasks =
        Array.isArray(tasks) &&
        tasks.length > 0 &&
        tasks.every((t) => t.status === this.d.TASK_STATUS.COMPLETED);
      if (!allGreen || !allTasks) {
        await this.journal(root, "stage reached done but checks/tasks are not green; staying open");
        return { type: "continue", reason: "stage-complete-refused" };
      }
      if (state.continuous_improvement !== false)
        return this.runImproveCycle(sessionID, root, state, results);
    }
    return decision;
  },
};
