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

| File | Purpose |
| --- | --- |
| `mission.md` | Frontmatter (`id`, `max_turns`, `budget_usd`, `stall_after_turns`) + objective and non-goals |
| `criteria.json` | **The** definition of done: `{version, checks:[{id, cmd, expect, timeout_ms}], review}` |
| `tasks.json` | `{version, tasks:[{id, subject, status, blocked_by, verify}]}`. `verify` is the check id whose green state completes the task — the harness, not the model, marks it done |
| `state.json` | Durable supervisor state: status, turn, cost, budget, last checks, strategy tier, last verdict, finish reason |
| `charter.md` | Immutable goal + acceptance criteria. Never rewritten by the supervisor |
| `memory.md` | **Distilled** decisions, constraints, file map and discarded approaches, capped at ~4k characters. This is what the model sees |
| `summary.md` | Regenerated short summary of `memory.md`, written on the compaction schedule |
| `journal.md` | Raw append-only audit log; source material for distillation, not injected wholesale |
| `progress.json` | Task leases: `{id, subject, status, owner, attempts, lease_until, last_error, verify}` |
| `evidence/<check-id>.txt` | stdout, stderr, exit code and timing of each check run |
| `STOP` | Kill switch. Presence stops the mission at the next idle boundary |

`expect` is `exit0` (default) or `contains:<text>` (requires exit 0 **and** the substring
in stdout).

## State machine

```
init -> running -> (running | complete | blocked | aborted)
```

`running` is re-entered after every agent turn. The supervisor runs at
`session.idle` (OpenCode hook `experimental.idle`), before the session goes quiet:

1. Load state, criteria, tasks.
2. **Re-run every check itself** with a timeout; write evidence.
3. Apply `verify` results to tasks (fixed point over `blocked_by` chains).
4. Update turn, cost (from the session's assistant messages), strategy tier.
5. Decide:
   - `STOP` file / budget / turn ceiling / `blocked` verdict -> terminal status.
   - all checks green **and** all tasks complete -> `complete`.
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
