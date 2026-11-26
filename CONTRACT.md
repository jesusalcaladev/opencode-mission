# Mission contract (host-agnostic)

This is the source of truth for what "autonomous" means in this project. The OpenCode
plugin implements it. The zode port will implement **the same files and the same
state machine** later — no format translation.

## The one rule

> The model **proposes** a verdict. The **harness verifies** with executable checks.
> `complete` is written by the supervisor, never by the model.

A red check always beats a `met` verdict. A model that stops after writing files is
nudged back to work. A mission that is genuinely impossible declares `blocked` with
`what_would_unblock` and stops cleanly instead of burning budget.

## Layout

`<workspace>/.mission/`

| File                      | Purpose                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mission.md`              | Frontmatter (`id`, `max_turns`, `budget_usd`, `stall_after_turns`) + objective and non-goals                                                                              |
| `criteria.json`           | **The** definition of done: `{version, checks:[{id, cmd, expect, timeout_ms}], review}`                                                                                   |
| `tasks.json`              | `{version, tasks:[{id, subject, status, blocked_by, verify}]}`. `verify` is the check id whose green state completes the task — the harness, not the model, marks it done |
| `state.json`              | Durable supervisor state: status, turn, cost, budget, last checks, strategy tier, last verdict, finish reason                                                             |
| `charter.md`              | Immutable goal + acceptance criteria. Never rewritten by the supervisor                                                                                                   |
| `memory.md`               | **Distilled** decisions, constraints, file map and discarded approaches, capped at ~4k characters. This is what the model sees                                            |
| `summary.md`              | Regenerated short summary of `memory.md`, written on the compaction schedule                                                                                              |
| `journal.md`              | Raw append-only audit log; source material for distillation, not injected wholesale                                                                                       |
| `progress.json`           | Task leases: `{id, subject, status, owner, attempts, lease_until, last_error, verify}`                                                                                    |
| `evidence/<check-id>.txt` | stdout, stderr, exit code and timing of each check run                                                                                                                    |
| `STOP`                    | Kill switch. Presence stops the mission at the next idle boundary                                                                                                         |
| `PAUSE`                   | Pause at the next idle boundary; resume after removing it                                                                                                                 |
| `WAKE`                    | External watchdog request. Only the live supervisor consumes it and prompts the lead                                                                                      |

`expect` is `exit0` (default) or `contains:<text>` (requires exit 0 **and** the substring
in stdout). With `strict_checks: true` (default in relentless), unsafe or vacuous
commands are refused **before execution** regardless of who authored the criteria;
the check is recorded as failed with a `refused` flag and evidence.

## State machine

```
init -> running -> (running | complete | blocked | aborted)
```

`running` is re-entered after every agent turn. The supervisor runs at
`session.idle` (OpenCode hook `experimental.idle`), before the session goes quiet:

1. Load state, criteria, tasks.
2. **Re-run every check itself** with a timeout; write evidence.
3. Apply `verify` results to tasks (fixed point over `blocked_by` chains). A check
   that was green in `state.check_baseline` cannot verify a task; checks added by a
   re-plan start red. Optional mutation control re-runs a check after removing the
   task's files to reject vacuous checks.
4. Update turn, cost (summed across **all** mission sessions), strategy tier.
5. Decide:
   - `STOP` / `PAUSE` / hard budget / wall-clock deadline / `test-erosion` -> terminal.
   - `blocked` verdict -> terminal in `standard`, forced re-plan in `never_give_up`.
   - all checks green, requirements covered, all tasks complete **and** at least one
     real red→green transition -> `complete`.
   - otherwise -> admit one bounded prompt with the failures and the next task.
6. Append the journal line **before** prompting, so a crash never loses the reason.

Strategy tiers: 1 = normal, 2 = "re-read the criteria, change the approach",
3 = same, louder. Progress is defined as **more green checks or more verified
tasks**, never tokens spent. Progress lowers the tier.

## What the model can do

`mission_status`, `mission_write` (workspace-scoped, atomic), `mission_check`
(real checks + evidence), `mission_verdict` (`met` / `blocked` + reason),
`mission_log` (journal).

## Intake: from a sentence to an executable mission

`/mission start <what to do>` is the normal entry point. The supervisor asks a model
(preferably a free one, so an exhausted paid provider does not block planning) for a
JSON plan: objective, executable checks, and tasks with `files`, `verify` and
`blocked_by`. `planner.js` validates it — unsafe commands, cycles, bad ids, path
traversal and missing verify checks are rejected with a retry. If the model cannot be
reached, `fallbackPlan` derives real checks from the objective itself (a named file,
a named string); it never uses a vacuous check such as `node --test` with zero tests.

A path instead of prose keeps the legacy behavior: `/mission start ./some/dir` runs a
pre-authored `.mission/` directory unchanged.

## Roles in one workspace

All agents share the same working tree; no worktrees are created. What separates
them is **permission and stage**, not a checkout:

| Role         | Writes                  | Job                                                 |
| ------------ | ----------------------- | --------------------------------------------------- |
| Investigator | no                      | read the code, report findings via `mission_report` |
| Implementer  | only its task's `files` | do the assigned task                                |
| Tester       | no                      | run checks, report results                          |
| Reviewer     | no                      | review the diff, emit `SEVERITY: high               | medium | low` lines |

The harness owns the stage machine `investigate → implement → verify → review →
done`. An agent cannot skip a stage. Completion requires a clean review; a high
finding reopens the tasks (up to 2 attempts) and then blocks with `review-high`.
All git commits go through the mission write queue.

## Workers: not a single thread

At mission start the supervisor dispatches one child session per ready task, grouped
into waves of at most `maxWorkers` (default 3). Two tasks can share a wave only when
their `files` lists are disjoint and their dependencies are already settled. The lead
becomes a coordinator and does not duplicate **leased** work. Each task is claimed
with a lease (`progress.json`): `claim → report → release`, or `expire → retry`.
Workers report with `mission_task_done(id, status, summary, evidence)`; a `failed`
report releases the lease for another attempt, and attempts are bounded (3). The
harness still runs the criteria itself and is the only writer of task completion and
mission status. A silent worker is reclaimable on the next idle — tasks are never
"dispatched forever" as in v1.

## Liveness: failures and restarts

`experimental.idle` does **not** fire after an interrupted or failed model turn, so the
supervisor also subscribes to `session.execution.failed` and
`session.execution.interrupted`:

- failure 1..N-1: back off (2s, 4s, 8s… capped at 30s), rotate off a quota-limited
  provider, and admit a `[MISSION RECOVERY]` prompt.
- failure N (`max_failures`, default 3): abort with reason `repeated-execution-failure`.

The session→mission registry lives in plugin storage. On plugin load, a mission that
is still `running`, whose session exists and is not busy, and whose last prompt is
older than 30s is auto-resumed with `[MISSION RESUME]`. A reload in the middle of a
turn cannot inject a second prompt.

## Watchdog and hard stops

A `done` report is accepted only when the task's `verify` check is green; a red
check releases the lease for retry. After `STALL_TURNS` (2) turns without verified
progress at strategy tier >= 2, the harness asks the model for a **new plan** and
applies it only if it passes the same validation as the initial plan. The new
criteria/tasks replace the old ones while turn, cost and write counters are kept.

Three independent hard stops supplement the turn and failure ceilings:
`budget_usd` (from reported assistant cost), `max_wallclock_min` (from
`started_at`) and `max_writes` (successful `mission_write` calls).

## Continuous improvement

After the initial criteria are green, the mission does **not** stop. It enters
an audit/improve cycle: a read-only auditor emits `FINDING: impact=… risk=…
files=… description`, the harness ranks them, and worthwhile ones become one
bounded task with owned files. Each cycle is verified as usual.

The loop stops when two consecutive audits find nothing above `min_impact`
(default `medium`), when `max_improve_cycles` (5) is reached, on budget, or on
`STOP`. The final `finish_reason` says why. `continuous_improvement: false` is
the opt-out for deterministic runs.

## Campaign mode and definition of done

A campaign plan may declare up to 60 tasks, 24 checks, `milestones`, a
`definition_of_done` and a `requirements` list. Every requirement names at least
one check id. Completion is legal only when **all checks are green, all tasks are
verified and every requirement is covered by a green check**. A goal auditor can
add tasks (and e2e checks) for uncovered requirements in bounded rounds; an
unresolved gap stops with `goal-gaps` instead of reporting a false success.

Re-planning is monotonic: it may add checks/tasks but may not drop a green check,
weaken its command/expectation, or drop a completed task. This prevents a stalled
mission from "succeeding" by shrinking the contract.

Soft budgets (`max_turns`, `max_writes`, `budget_usd`) are windows in campaign
mode. On a soft stop, the harness extends them automatically if verified progress
happened recently. `hard_budget_usd`, `max_wallclock_min`, `STOP`, `PAUSE`,
`blocked`, `hard-budget` and `test-erosion` are absolute. Campaign defaults are
40 turns/window, 8h wall-clock, $25 hard cap and 50 extensions.

In `autonomy: relentless` / `never_give_up: true`, **all soft ceilings are
unlimited** (`0` = no limit): task attempts, review attempts, goal-audit rounds,
extensions, failure count, turns, writes and improvement cycles. `blocked` forces
a re-plan, `review-high` forces rework, `goal-gaps` keeps looping, failed tasks are
re-queued, and supervisor errors recover instead of aborting. `hard_budget_usd`,
`max_wallclock_min`, `STOP`, `PAUSE` and `test-erosion` remain absolute and are
the only normal ways the run ends; `mission_verdict("blocked")` no longer stops
the mission.

## Research mode

Research tools are opt-in (`/mission research` or a plan with `needs_research`).
The plugin registers a DuckDuckGo websearch provider with OpenCode and exposes
`mission_web_search`, `mission_web_fetch`, `mission_image_search`,
`mission_image_generate`, `mission_research` and `mission_research_note`. Fetch
and download refuse non-http schemes and private/loopback addresses, cap sizes
and timeouts, and record attribution/license for every image. Reports are written
to `research/report.md` with `sources.json` and `images/`.

## Continuity across hours

A mission may declare a `roadmap.md` checklist. On `complete`, the harness ticks
the current item and starts the next one in the same workspace, carrying
`memory.md` into the new brief. `chain_index` / `chain_total` are persisted.

A budget stop (`budget`, `max-turns`, `write-ceiling`, `deadline`) can be extended
by creating `EXTEND`: the file is consumed, budgets grow by a fixed block, and
`extensions` increments. `max_extensions` bounds this; without the file the stop
is absolute. A `blocked` verdict is never extendable.

A 60-second rescue timer re-admits one prompt for a running mission whose session
is idle and whose last prompt is older than three minutes, covering a missed
`experimental.idle` event.

## Memory and context

The journal is an audit log, not the model's memory. Every 4 turns the supervisor
distills it into `memory.md` (decisions, blockers, discarded approaches, constraints)
under a ~4k character budget and regenerates `summary.md`. The injected brief is
rebuilt from disk on **every** model request and carries: distilled memory, summary,
the current task, workers in flight, check results and a short journal tail. It is
never reconstructed from conversation history, so compaction and session handoff
cannot erase it.

The journal is append-only in the hot path: writes are queued per file, each line
is capped at 2,000 characters and `readJournalTail()` reads only the requested
window instead of the whole file. When the active file exceeds 512 KB it rotates
to `journal.<timestamp>.md`, leaves a pointer line, and keeps the last 3 archives.
Set `MISSION_JOURNAL_MAX_BYTES` to change the threshold and `MISSION_JOURNAL_FSYNC=1`
to fsync every line.

## Context handoff

`handoff_every_turns` (default 0 = off) closes the current session and creates a new
one carrying only the mission brief built from disk. The state, journal, evidence,
tasks and git history are the memory; the conversation is disposable. The old session
gets a `[MISSION HANDOFF]` notice and is unbound, so it cannot keep the loop alive.

## Integrity and checkpoints

- The `.mission/` directory is **harness-owned**. `mission_write` refuses any path
  under it, so the model cannot rewrite `criteria.json`, `tasks.json` or `state.json`.
- Before every decision the harness hashes existing test files
  (`*.test.*`, `*.spec.*`, `test_*.py`, `tests/`…). Adding tests is fine; **editing or
  deleting an existing test aborts the mission** with `test-erosion`.
- On every turn with verified progress it runs `git add -A` + `git commit` in the
  workspace, and records the short SHA in `state.last_commit`. Non-git workspaces skip
  this with a journal note.

## Budgets and isolation

`budget_usd`, `max_turns` and `max_wallclock_min` are independent hard stops.
`isolation: worktree` creates a sibling git worktree on branch `mission/<id>` and
runs checks and `mission_write` there; the original checkout is untouched and merging
is left to the human. Plugin options: `fallbackModel` (a `{providerID, id}` used on
quota errors) and `notifyUrl` (POSTs terminal-state JSON; `MISSION_WEBHOOK_URL` also works).

## Known limits

Cost accounting reads `cost` from the session's assistant messages, so an unpriced
model shows $0 — `max_turns` and `max_wallclock_min` remain the reliable backstops.
Model rotation is best-effort: if no alternative with tools and output price < $5/M
exists, the mission keeps retrying until `max_failures`. A single mission runs in a
single session at a time; there is no multi-mission scheduler yet.

## Porting to zode

Map this contract onto primitives that already exist in zode:
`taskloop.zig` (budget ladder, stall), `exitgate.zig` (refuse red/unverified),
`goal.zig` (met/blocked + unblock), `taskstore.zig` (task graph), `testguard.zig`
(no test erosion), `checkpoint.zig`, `worktree.zig`, and the harness prompt door
`appendHarnessPrompt`. The supervisor becomes `src/lib/mission.zig` plus a headless
`zode --mission <id>` runner. No new on-disk format.
