# Architecture

## The one invariant

The harness decides completion. The model proposes work, verdicts and reports;
it never writes `status: complete`, never marks a task completed, and never
rewrites `criteria.json`, `tasks.json` or `state.json` (`mission_write` refuses
paths under `.mission/`).

## Module map

```text
src/
  index.js                 OpenCode adapter: commands, hooks, provider registration
  tool-definitions.js      mission_* tool registration (extracted from index)
  supervisor.js            thin coordinator: constructor + THE main turn loop
  supervisor/
    deps.js / util.js      dependency barrel + error formatting
    decisions.js           stop/auto-extend/handoff/nudge helpers
    state.js               write queue, bindings, state accessors
    recovery.js            failures, backoff, rescue, prompt ledger
    models.js              model selection and quota rotation
    lifecycle.js           start / stop / pause / finish
    planning.js            plan files, research plan, roadmap chaining
    registry.js            pointer + missions.json telemetry
    intelligence.js        briefs, memory, monotonic re-plan
    roles-pipeline.js      stage machine, role dispatch, reviews, task splitting
    goal-audit.js          requirement-gap repair
    improvements.js        audit/improve cycles
    workers.js             worker pool spawn/finalize, verification, status
    scheduler.js           waves, wait/timeout, lead ticks, watchers
    tools.js               workspace tools
    research-tools.js      web/image/research tools
  checks.js                criteria runner (shell + timeout + retries + evidence)
  verify.js                test hashing, git checkpoints, worktree isolation
  research.js              facade for ./research/*
  research/
    text.js                safe fetch, SSRF guard, HTML -> text
    search.js              DuckDuckGo/Brave/Serper/Tavily providers + cache
    images.js              image search, download, generation
    report.js              report building and mission plan
  planner.js               facade for ./planner/*
  planner/
    prompt.js              planner prompt + safe command rules
    normalize.js           plan validation + monotonic rules
    plan.js                fallback plan + createPlan
  team.js                  wave scheduling and worker prompts (pure)
  mission.js               facade for pure modules and persistence
  mission/
    state.js               constants, defaults, task normalization (pure)
    decide.js              termination and task completion rules (pure)
    memory.js              journal distillation and brief construction (pure)
    lease.js               claim / renew / expire / retry (pure)
    watchdog.js            stall detection and re-plan prompts (pure)
    chain.js               roadmap parsing, chain decision, budget extension (pure)
    roles.js               roles, permissions, review/gap parsing, stage machine (pure)
    autonomy.js            campaign progress, history, long-run defaults (pure)
    recovery.js            prompt ledger, handoff lineage, stale cleanup (pure)
    metrics.js             durable telemetry counters (pure)
    persistence.js         atomic JSON/text IO
    bootstrap.js           workspace creation
    journal.js             append-only journal with rotation
  tui.tsx                  TUI plugin setup (single sidebar slot + dashboard route)
  tui/
    model.js               read model (pure, reads durable files)
    format.js              formatters (pure)
    registry.js            mission discovery
    types.ts               shared types + store hook
    components.tsx         common components + sidebar card
    lists.tsx              checks/tasks/agents/requirements/timeline
    dashboard-parts.tsx    header + dashboard body
    dashboard.tsx          route + panel

test/                      node:test suites; no OpenCode, no network
```

`src/mission/*` never imports `node:test` at runtime: OpenCode loads these files
with Bun, which rejects test globals outside a test runner. All tests live in
`test/`.

## Data flow

```text
/mission start <objective>
  -> planner (free model, validated by normalizePlan)
  -> .mission/{mission,criteria,tasks,progress,charter,memory,summary}.json/md
  -> investigator (read-only) -> implementer waves (assigned files only)
  -> harness checks -> reviewer (read-only, SEVERITY findings) -> commit
  -> worker calls mission_task_done(id, status, summary, evidence)
  -> harness checks the task's verify check before accepting the report
  -> session.idle -> re-run ALL criteria -> evidence -> apply task results
  -> decide(): stop-file / deadline / budget / turns / writes / failures / blocked / complete
  -> complete + open roadmap item -> next mission in the same workspace (memory carried)
  -> journal every transition; distill memory every 4 turns
  -> nudge the lead with a brief rebuilt from disk
```

Worker completion is **not** trusted: a `done` report whose `verify` check is red
is rejected and the lease is released for retry.

## Invariants to preserve

1. `decide()` is the only place that returns `complete` or `stop`.
2. Terminal state is written by `Supervisor.finish`, never by a tool.
3. Every journal/state/progress write goes through the single per-mission
   `serialize(root, fn)` queue. Reentrant calls from inside `fn` run directly;
   concurrent callers wait. No write happens outside that queue.
4. `mission_write` never accepts a path inside `.mission/`.
5. The injected brief is rebuilt from disk, never from conversation history.
6. A task with a failed or expired lease is retryable until `MAX_ATTEMPTS`.
7. A re-plan replaces criteria/tasks but preserves turn, cost and write counters.
8. Prompt injection is appended at the end of the system array so the stable
   prefix stays cacheable.
9. A re-plan cannot drop a green check or a completed task, and cannot weaken a
   check's command or expectation.
10. Completion requires every declared requirement to be covered by a green
    check, not merely all tasks being marked complete.
11. Soft budgets may auto-extend only on verified progress; `hard_budget_usd`,
    `max_wallclock_min`, `STOP`, `PAUSE`, `blocked` and `hard-budget` are absolute.
12. Research network tools refuse private/loopback addresses and non-http schemes.
13. Every supervisor mixin reaches dependencies only through `this.d`; no mixin
    destructures the barrel. No source file exceeds 250 lines.
14. `npm run quality` (syntax, lint, format, typecheck, coverage) must stay green.

## Failure model

- Lead failure: deduplicated within 1.5 s, backoff 2/4/8…30 s, rotate to a free
  model, abort after `max_failures`.
- Worker failure: the owning task's lease is released with an error and the task
  is reclaimed on the next idle; it never counts against the lead's budget.
- Worker silence: `lease_ms` (default 5 min) bounds a task's lease. Workers call
  `mission_heartbeat(id)` to renew it; expiry releases the task for retry.
- Quiet session: a 60 s rescue timer re-admits one prompt for a running mission
  whose session is idle and whose last prompt is older than 3 minutes.
- Service restart: the mission registry in plugin storage restores the binding
  and auto-resumes a running mission whose last prompt is older than 30 s.
- Stagnation: tier 2/3 triggers a real re-plan through the model, not just a
  different prompt sentence. The new plan must pass the same validation.
