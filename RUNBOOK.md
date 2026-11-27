# Runbook: unattended missions

## Start

```text
/mission start Build a CLI with three tests and a README explaining it
```

Use a **path** instead of prose to resume a pre-authored mission:

```text
/mission resume ./missions/build-a-cli-1795312553
```

`/mission start` runs the engineering prelude first: 3–4 read-only recon agents,
then one architect that writes `.mission/blueprint.md` and the machine plan. The
harness validates that plan before any implementer starts, reuses cached recon on a
resume, and runs the goal audit before completion. Use `--quick` only for trivial
tasks where recon would cost more than it saves.

When the mission ends, `MISSION_REPORT.md` appears in the project root. Regenerate
it at any time (also while running):

```sh
npm run report -- ./missions/<workspace>
npm run report -- ./missions/<workspace> --print
```

## Budgets that stop a run

Set these in `.mission/mission.md` frontmatter (the planner writes defaults):

| Key                 | Effect                                                  |
| ------------------- | ------------------------------------------------------- |
| `max_turns`         | Lead turns before `max-turns`                           |
| `budget_usd`        | Stops when the provider reports cost >= this            |
| `max_wallclock_min` | Hard wall-clock deadline from `started_at`              |
| `max_writes`        | Successful `mission_write` calls before `write-ceiling` |
| `max_failures`      | Consecutive failed lead turns before abort              |

If the model is unpriced, cost is $0: rely on turns, wall-clock and writes.

## Campaign mode (default for large objectives)

For objectives like “build a complete game engine”, the planner switches to
`autonomy: campaign`. It writes requirements and a definition of done, and the
harness keeps working across many budget windows:

- soft budgets (`max_turns`, `max_writes`, `budget_usd`) auto-extend while
  verified progress continues;
- hard stops are `max_wallclock_min` (8h by default), `hard_budget_usd` ($25 by
  default), `STOP`, `PAUSE`, a blocked verdict and test erosion;
- `PAUSE` stops at the next idle boundary without aborting. Remove the file and
  run `/mission resume <workspace>` to continue;
- the goal auditor checks requirements before completion. Uncovered requirements
  become new tasks/e2e checks instead of a false “complete”.

The dashboard (`ctrl+shift+m`) shows a **forecast** of final cost, tokens and
minutes derived from recorded turns, plus the first queued missions. A red token
counter means the projected spend will cross `max_tokens`.

Monitor it from the TUI with `ctrl+shift+m` (dashboard) or from disk with
`state.json` (look at `history`, `agent_runs`, `goal_audits`, `extensions`).

## Relentless missions (no soft stopping point)

Set `autonomy: relentless` (or `never_give_up: true`) in `.mission/mission.md`:

```yaml
autonomy: relentless
max_turns: 0 # 0 = unlimited
max_failures: 0
max_writes: 0
max_extensions: 0
max_task_attempts: 0
max_review_attempts: 0
max_goal_audits: 0
auto_extend: true
mutation_checks: true
require_e2e: true
strict_checks: true # refuses sudo/rm -rf/vacuous commands even in pre-authored criteria
global_memory: true # distilled decisions flow to the next mission
max_tokens: 2000000 # absolute, non-extendable (0 = off)
hard_budget_usd: 25 # absolute
max_wallclock_min: 480 # absolute (8h)
```

What changes: `blocked` forces a re-plan, high review findings force rework,
goal gaps loop, failed tasks are retried forever, supervisor errors recover, and
soft budgets auto-extend without a ceiling. The harness still requires red→green
checks, requirement coverage and clean reviews. `STOP`, `PAUSE`,
`hard_budget_usd`, `max_wallclock_min` and `test-erosion` are **not** extensible.

Monitor `state.metrics` (`failuresReset`, `extensions`, `replans`, `improvements`)
and the journal tail. The `notifyUrl` webhook receives `blocked-replan`,
`review-rework`, `goal-gaps`, `failure-reset`, `budget-extension` and
`supervisor-recovery` events.

## External watchdog (survive a host restart)

The in-process rescue timer cannot fire while OpenCode is down. A tiny helper
only writes `.mission/WAKE`; the live supervisor consumes it and re-admits the lead:

```sh
npm run watchdog -- --once --age-ms 180000 ~/missions
```

For a resident helper: `node scripts/mission-watchdog.mjs --interval-ms 60000 ~/missions`.
Example cron (every minute):

```cron
* * * * * cd /path/to/opencode-mission && npm run watchdog -- --once ~/missions >> /tmp/mission-watchdog.log 2>&1
```

The watchdog skips missions with `STOP` or `PAUSE`, never prompts a session
itself, and never writes state, criteria or tasks.

### Host supervisor (opt-in, higher risk)

Only enable this if you accept that the helper can restart your editor/host.
It reacts exclusively to a `WAKE` file that is **still stale** after the
in-process watchdog had a chance to act, so it never restarts a healthy host.

```sh
MISSION_HOST_RESTART_COMMAND="systemctl --user restart opencode" \
MISSION_HOST_RESTART_MAX=3 \
npm run host-supervisor -- --missions-root ~/missions
```

Use `npm run host-supervisor -- --dry-run ...` first to see decisions without
running anything. Each restart is recorded in `.mission/host-restart.json`
(attempts, window, next_at, last_error). `STOP`, `PAUSE`, terminal missions,
exponential backoff and `max_restarts` are absolute. The helper never writes
`state.json`, criteria or tasks; after a restart it removes `WAKE` and the
in-process rescue timer re-admits the turn.

systemd user timer example:

```ini
# ~/.config/systemd/user/opencode-mission-supervisor.service
[Service]
Type=oneshot
Environment=MISSIONS_ROOT=%h/missions
Environment=MISSION_HOST_RESTART_COMMAND=systemctl --user restart opencode
ExecStart=/usr/bin/env npm --prefix /path/to/opencode-mission run host-supervisor
```

## Research missions

```text
/mission research compare ECS libraries for a 2D game engine
```

This creates a normal verified mission whose artifacts are `research/report.md`,
`research/sources.json` and `research/images/`. Web search uses OpenCode's
websearch provider (DuckDuckGo by default, Brave when `BRAVE_SEARCH_API_KEY` is
set). Fetching refuses private addresses. Image search uses Openverse with a
Wikimedia fallback; `mission_image_generate` uses an image model if configured.

## Parallel missions

```text
/mission parallel build alpha CLI | build beta CLI | write the docs
```

Each objective gets its own lead session, workspace and worker pool. Up to 8
objectives per command; the current session is untouched. `/mission status` in
any lead session shows that mission only. `GLOBAL_MEMORY.md` shares distilled
decisions across them when `global_memory: true`.

For more than 8 objectives, or to survive restarts, use the persistent queue
at `<missionsRoot>/mission-queue.json`:

```text
/mission queue add build alpha CLI p:5
/mission queue add write the docs p:1
/mission queue list
/mission queue run 2
```

`parallelSlots` (default 8) bounds how many queued missions run at once; with
`autoQueue: true` the scheduler launches pending entries every `queueIntervalMs`
(30 s) and recovers sessions that died. Queue entries are sorted by priority,
then age. Failed launches are retried up to `maxQueueAttempts` (3).

## Chaining missions for hours

Write `.mission/roadmap.md` with one item per mission:

```markdown
# Roadmap

- [ ] id: cli: build the CLI
- [ ] id: docs: write the README
- [ ] id: polish: fix the remaining checks
```

When a mission completes, the harness ticks the item and starts the next one in
the **same workspace**, carrying `memory.md` forward. No human input needed.

If a budget stop fires, create `EXTEND` to grant one more block of turns/writes
(max `max_extensions` times). Without `EXTEND`, the stop is final.

## Sandboxing criteria (opt-in)

Set `sandbox: copy` in `.mission/mission.md` (or per check with `sandbox: "copy"`).
Each criterion then runs in a disposable copy of the workspace with a minimal
environment (`PATH`, locale, `HOME` pointing at the copy, `CI=1`). Credentials
and unrelated env vars are removed, and writes made by a check cannot touch the
real project. `node_modules` is symlinked so test runners keep working.

This is a **soft** sandbox (no OS namespaces, no root required): it protects the
workspace and credentials, not the host from a malicious local binary. Combine
it with `strict_checks: true`. Default `none` preserves existing criteria.

## Skills vs. brief

Five skills (`mission-workflow`, `mission-review`, `mission-research`,
`mission-verdict`, `mission-blueprint`) describe **how** to work; they are static and registered with
OpenCode unless `enableSkills: false`. The injected MISSION BRIEF carries **what is
true right now** (disk state, facts, memory, journal, checks, retry history). Never
put dynamic mission facts into a skill: it would go stale. Workers and roles receive
the same bounded context pack as the lead, filtered to their task.

## Doctor (read-only)

```sh
npm run doctor -- ~/missions/<workspace>
npm run doctor -- ~/missions/<workspace> --json
```

It reports terminal status, turn/budget/tokens, check and task progress, stale
leases, failed tasks, strategy tier, extensions, baseline coverage, queue stats,
host restarts and **schema problems** in the durable state. It never writes files.
`loadState` now normalizes malformed fields to safe defaults, so a hand-edited or
truncated `state.json` cannot crash the supervisor.

## Verify the harness itself

```sh
npm run eval
npm run eval -- --filter blocked-relentless --json
```

The JSON reports per-case `pass`, `reasons`, terminal `status`, `finish_reason`,
green checks, completed tasks, turns and stop reason. `eval/baseline.json` is the
regression gate: any previously passing case that fails makes the command (and CI)
fail. Update it deliberately with `npm run eval -- --update-baseline` only after
an intentional behavior change.

## Watch it

```text
/mission status
```

For a scripted check, read the durable files directly:

```sh
cat <workspace>/.mission/state.json      # turn, cost, writes, status
cat <workspace>/.mission/progress.json   # task leases, attempts, last_error
tail -20 <workspace>/.mission/journal.md # every transition, in order
cat <workspace>/.mission/memory.md       # distilled decisions the model sees
```

`journal.md` is the audit log. `memory.md` is what the model actually receives;
if a decision disappeared, look there first.

## Stop, pause, resume

Create `STOP` to halt at the next idle boundary:

```sh
touch <workspace>/.mission/STOP
```

The mission ends with `status: aborted` and `finish_reason: stop-file`. Remove
`STOP` and run `/mission resume <workspace>` to continue.

## Common symptoms

| Symptom                          | Meaning                                       | Action                                                          |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `test-erosion`                   | A test file was edited/deleted after baseline | Review the diff, restore the test, resume                       |
| `repeated-execution-failure`     | Provider failing after `max_failures`         | Fix credentials/quota, resume                                   |
| `write-ceiling`                  | Agent writing too much                        | Raise `max_writes` only if the writes are useful                |
| Task stuck `in_progress`         | Worker died / stopped sending heartbeats      | Wait one idle: the `lease_ms` expires and the task is reclaimed |
| `lease expired` on a live worker | Worker did not call `mission_heartbeat`       | Raise `lease_ms`; the worker prompt already asks for heartbeats |
| `re-plan applied`                | Same approach failed twice                    | Read `memory.md` to see the discarded approach                  |
| `lease expired` in journal       | A worker went silent                          | Expected; the harness retried it                                |
| `rescue timer re-admitted`       | A session went quiet without an idle event    | Expected; the supervisor resumed it                             |
| `chain exhausted`                | All roadmap items are done                    | Add more items to `roadmap.md`                                  |
| `review-high`                    | Reviewer found high severity issues twice     | Read `state.stage_reports.review`, fix, resume                  |

## Long-run checklist

- Commit checkpoints are created only on verified progress. Review `git log`.
- `ZODE_MISSION_AGENT` can point to any CLI that takes the prompt as its last
  argument; use it to test the loop without spending provider credits.
- `enableWorkers: false` in plugin options gives a single-agent run for debugging.
- `maxWorkers` above 3 only helps when tasks have disjoint `files` lists.
- On restart, the plugin auto-resumes a running mission whose last prompt is
  older than 30 s. A reload during an active turn does not double-prompt.
