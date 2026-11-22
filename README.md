# opencode-mission

> An autonomous mission supervisor for OpenCode 2. Give it a sentence; it plans the
> work, dispatches parallel sub-agents, and keeps going until executable criteria are
> green — not until the model *feels* done.

[![CI](https://github.com/jesusalcaladev/opencode-mission/actions/workflows/ci.yml/badge.svg)](https://github.com/jesusalcaladev/opencode-mission/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Why

An agent that stops when it runs out of iterations is not autonomous. An agent that
declares itself done is not trustworthy. This plugin moves the definition of "done"
out of the model and into the harness:

- The **model proposes** a verdict (`met` / `blocked`) and writes files.
- The **harness re-runs** executable criteria after every turn and writes the verdict.
- A red check always beats a `met` verdict.

The result is a long-running loop that survives failed requests, service restarts and
context compaction, with parallel workers, git checkpoints and hard budgets.

Version 0.2.0 adds **durable distilled memory** (decisions survive hundreds of turns)
and **task leases** (a dead worker's task is reclaimed instead of stuck forever).

## Features

- **Natural-language intake** — `/mission start build a CLI with three tests` creates
  a workspace, plans checks and tasks, and starts the run. A path instead of prose runs
  a pre-authored `.mission/` directory.
- **Parallel sub-agents** — one child session per task, grouped into waves of disjoint
  file sets. The lead coordinates; the harness verifies.
- **Automatic model selection** — OpenCode's default is replaced by a free,
  tools-capable model for the planner, lead and workers. Quota errors rotate models
  with exponential backoff. No model configuration required.
- **Durable state** — `state.json`, `journal.md`, `evidence/` and a session→mission
  registry survive restarts; `/mission resume` and auto-resume pick up where it left off.
- **Context handoff** — rotate to a fresh session on a schedule; the journal is the memory.
- **Integrity guard** — editing or deleting an existing test aborts with `test-erosion`;
  `mission_write` refuses any path under `.mission/`, so the model cannot rewrite the
  criteria, tasks or state that define done.
- **Checkpoints** — verified progress is committed to git; non-git workspaces are skipped.
- **Hard stops** — `max_turns`, `budget_usd`, `max_wallclock_min`, `max_failures`, `STOP`.

## Requirements

- OpenCode 2.x (tested with 2.3.2)
- Node.js 20+ (tested with 26)
- `@opencode/plugin` 2.3.2 (installed with the plugin)

## Install

Copy this directory into your plugins folder or clone it:

```sh
git clone https://github.com/jesusalcaladev/opencode-mission.git ~/.config/opencode/plugins/opencode-mission
cd ~/.config/opencode/plugins/opencode-mission && npm install
```

Then register it in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/opencode-mission",
      "options": {
        "missionsRoot": "~/missions",
        "maxWorkers": 3,
        "model": { "providerID": "opencode", "id": "hy4-flash-free" }
      }
    }
  ]
}
```

All options are optional. Config changes reload without restarting OpenCode; use
`/reload` or `opencode api post /api/location/reload --data '{}'` to force it.

Confirm the install with:

```sh
opencode api get /api/plugin | grep mission
```

## Quick start

```text
/mission start Create alpha.txt containing alpha and beta.txt containing beta
/mission status
/mission stop
/mission resume
/mission help
```

The plugin prints the generated plan, schedules the workers, and then verifies the
criteria itself. Generated missions live under `missionsRoot` (default:
`<current directory>/missions`).

To run the bundled example instead:

```text
/mission start ./demos/cli
```

`demos/cli/.mission/` contains four checks that are red on purpose. The agent writes
`cli.js` and `cli.test.js`, and the loop continues until all four are green.

## How it works

```text
/user: "/mission start <objective>"
        |
        v
planner (model) -> validated criteria.json + tasks.json
        |
        v
worker sessions (parallel waves) ---> mission_write / mission_task_done
        |
        v
session.idle -> harness re-runs criteria -> writes evidence
        |
        +-- red  -> nudge + retry, escalate strategy, rotate model on quota
        +-- green + all tasks verified -> git checkpoint -> status: complete
```

The contract is host-agnostic and documented in [CONTRACT.md](./CONTRACT.md). It is
designed to be ported to other harnesses (a zode implementation is planned).

## Commands and tools

| Command | Purpose |
| --- | --- |
| `/mission start <objective or path>` | Plan and start a mission, or run a pre-authored one |
| `/mission status` | Show state, checks, tasks, budget and model |
| `/mission stop` | Abort and keep state on disk |
| `/mission resume [path]` | Resume a stopped or interrupted mission |
| `/mission help` | Show command help |

| Tool | Purpose |
| --- | --- |
| `mission_status` | Read mission state |
| `mission_write` | Atomically write a file inside the workspace |
| `mission_check` | Run the real criteria and return evidence paths |
| `mission_verdict` | Declare `met` / `blocked` (harness still verifies) |
| `mission_task_done` | Worker completion report (harness still verifies) |
| `mission_log` | Append to the durable journal |

## Configuration

### Plugin options (`opencode.jsonc`)

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | auto | `{providerID, id}` forced for planner, lead and workers |
| `plannerModel` | auto | Override for the planning call only |
| `fallbackModel` | auto | Override used on quota errors |
| `missionsRoot` | `<cwd>/missions` | Where generated mission workspaces live |
| `maxWorkers` | `3` | Maximum parallel sub-agents per wave |
| `enableWorkers` | `true` | Set to `false` for single-agent runs |
| `notifyUrl` | unset | POST terminal-state JSON to this URL |
| `MISSION_WEBHOOK_URL` | unset | Environment alternative to `notifyUrl` |

### Mission frontmatter (`.mission/mission.md`)

| Key | Default | Meaning |
| --- | --- | --- |
| `max_turns` | `16` | Turn ceiling |
| `budget_usd` | `5` | Cost ceiling (when the provider reports cost) |
| `max_wallclock_min` | `0` | Wall-clock ceiling (0 = off) |
| `max_writes` | `0` | Successful file writes before aborting (0 = off) |
| `max_failures` | `3` | Failed turns before aborting |
| `handoff_every_turns` | `4` | Rotate to a fresh session (0 = off) |
| `isolation` | `none` | `worktree` runs in a sibling git worktree |
| `stall_after_turns` | `2` | Strategy-escalation threshold |

## Mission files

```text
<workspace>/.mission/
  charter.md        immutable goal + acceptance criteria
  mission.md        frontmatter + objective
  criteria.json     the definition of done: [{id, cmd, expect, timeout_ms}]
  tasks.json        task graph: {id, subject, files, verify, blocked_by}
  state.json        durable supervisor state
  journal.md        raw audit log (not injected wholesale)
  memory.md         distilled decisions/constraints (~4k), injected into every request
  summary.md        regenerated short memory summary
  progress.json     task leases: owner, attempts, lease_until, last_error
  evidence/*.txt    stdout, stderr, exit code and timing per check
  STOP              kill switch, checked at every idle boundary
```

`expect` is `exit0` or `contains:<text>` (requires exit 0 and the substring).

## Documentation

| File | For |
| --- | --- |
| [`CONTRACT.md`](./CONTRACT.md) | Host-agnostic contract and file formats |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Module map, data flow and the invariants that must not break |
| [`RUNBOOK.md`](./RUNBOOK.md) | Running unattended for hours: budgets, monitoring, stop and resume |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Development rules and PR checklist |
| [`SECURITY.md`](./SECURITY.md) | Threat model and reporting |

## Development

```sh
npm install
npm run check          # syntax check every source and test file
npm test               # full suite, no network or TUI required
node --test --watch test/*.test.js
```

The server part only is implemented (`@opencode/plugin`); there is no TUI or GUI part.
See [CONTRIBUTING.md](./CONTRIBUTING.md) before sending changes.

## Known limitations

- One mission runs in one lead session at a time; there is no multi-mission scheduler.
- Cost is read from assistant messages, so unpriced models report $0. The turn and
  wall-clock ceilings are the reliable backstops.
- Model rotation is best-effort: if no free tools-capable model is available, the
  mission retries until `max_failures`.
- Criteria commands run in a shell inside the workspace. Only use criteria you trust.

## License

MIT — see [LICENSE](./LICENSE).
