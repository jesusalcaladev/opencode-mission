# Architecture

## The one invariant

The harness decides completion. The model proposes work, verdicts and reports;
it never writes `status: complete`, never marks a task completed, and never
rewrites `criteria.json`, `tasks.json` or `state.json` (`mission_write` refuses
paths under `.mission/`).

## Module map

```text
src/
  index.js                 OpenCode adapter: /mission commands, tools, hooks
  supervisor.js            thin coordinator: constructor + THE main turn loop
  supervisor/
    state.js               write queue, bindings, state accessors
    recovery.js            failures, backoff, model rotation, rescue timer
    lifecycle.js           start / plan / finish / chain
    intelligence.js        briefs, memory, re-plan, roles, improve cycle
    workers.js             worker waves, verification, status
    tools.js               mission_* tool handlers
    deps.js / util.js      shared imports and error formatting
  checks.js                criteria runner (shell + timeout + evidence)
  verify.js                test hashing, git checkpoints, worktree isolation
  planner.js               natural language / model JSON -> validated plan
  team.js                  wave scheduling and worker prompts (pure)
  mission.js               persistence facade + v1 -> v2 migration
  mission/
    state.js               constants, defaults, task normalization (pure)
    decide.js              termination and task completion rules (pure)
    memory.js              journal distillation and brief construction (pure)
    lease.js               claim / renew / expire / retry (pure)
    watchdog.js            stall detection and re-plan prompts (pure)
    chain.js               roadmap parsing, chain decision, budget extension (pure)
    roles.js               roles, permissions, review parsing, stage machine (pure)

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
