# Runbook: unattended missions

## Start

```text
/mission start Build a CLI with three tests and a README explaining it
```

Use a **path** instead of prose to resume a pre-authored mission:

```text
/mission resume ./missions/build-a-cli-1795312553
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

Monitor it from the TUI with `ctrl+shift+m` (dashboard) or from disk with
`state.json` (look at `history`, `agent_runs`, `goal_audits`, `extensions`).

## Research missions

```text
/mission research compare ECS libraries for a 2D game engine
```

This creates a normal verified mission whose artifacts are `research/report.md`,
`research/sources.json` and `research/images/`. Web search uses OpenCode's
websearch provider (DuckDuckGo by default, Brave when `BRAVE_SEARCH_API_KEY` is
set). Fetching refuses private addresses. Image search uses Openverse with a
Wikimedia fallback; `mission_image_generate` uses an image model if configured.

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
