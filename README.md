# opencode-mission

> An autonomous mission supervisor for OpenCode 2. Give it a sentence; it plans the
> work, dispatches parallel sub-agents, and keeps going until executable criteria are
> green — not until the model _feels_ done.

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

Version 0.3.0 adds **Mission Control** (a full TUI dashboard + live HUD),
**Campaign Mode** (auto-extending, requirement-gated runs that survive for hours)
and **Research Mode** (web search, safe fetch, images and image generation).

Earlier versions added **durable distilled memory** (decisions survive hundreds of
turns) and **task leases** (a dead worker's task is reclaimed instead of stuck forever).

## Features

- **Natural-language intake** — `/mission start build a CLI with three tests` creates
  a workspace, plans checks and tasks, and starts the run. A path instead of prose runs
  a pre-authored `.mission/` directory.
- **Parallel sub-agents** — one child session per task, grouped into waves of disjoint
  file sets. The lead coordinates; the harness verifies.
- **Automatic model selection** — OpenCode's default is replaced by a free,
  tools-capable model for the planner, lead and workers. Quota errors rotate models
  with exponential backoff. No model configuration required.
- **Specialized roles in one workspace** — Investigator (read-only), Implementer
  (writes only its assigned files), Tester and Reviewer; no worktrees needed.
- **Review gate** — completion requires a clean `SEVERITY` review; high findings
  reopen the work and then block.
- **Continuous improvement** — after the objective is met, an auditor proposes
  real improvements and the harness implements them in bounded cycles until no
  valuable work remains (or a budget stops it).
- **Mission Control TUI** — a live HUD above the prompt, a sidebar card, footer
  badges, a session panel and a full-screen dashboard. On empty sessions it shows
  a clear call to action instead of nothing. `ctrl+shift+m` opens the dashboard.
- **Campaign Mode** — plans up to 60 tasks / 24 checks / explicit requirements,
  auto-extends budgets while verified progress continues, audits the actual goal
  before completion, and stops only at hard wall-clock/cost caps or `STOP`.
- **Research Mode** — `/mission research <question>` searches the web (OpenCode's
  websearch provider plus DuckDuckGo/Brave), fetches pages safely, finds and
  downloads images with attribution, and can generate images when a model exists.
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
        "model": { "providerID": "opencode", "id": "hy4-flash-free" },
      },
    },
  ],
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
/mission research duckduckgo vs brave search APIs for a research agent
/mission status
/mission pause
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

For a long-horizon example, run `/mission start ./demos/game`. Its campaign plan has
7 executable checks, explicit requirements, a headless smoke test and a roadmap;
the mission auto-extends until the engine is actually complete.

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

| Command                              | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `/mission start <objective or path>` | Plan and start a mission, or run a pre-authored one        |
| `/mission status`                    | Show state, checks, tasks, budget and model                |
| `/mission research <question>`       | Research with web sources, images and a written report     |
| `/mission pause`                     | Pause at the next idle boundary (remove `PAUSE` to resume) |
| `/mission stop`                      | Abort and keep state on disk                               |
| `/mission resume [path]`             | Resume a stopped or interrupted mission                    |
| `/mission help`                      | Show command help                                          |

TUI commands (also in the command palette): `/mission-dashboard`,
`/mission-panel`, `/mission-start`, `/mission-stop`, `/mission-pause`,
`/mission-resume`, `/mission-open`. Default keybind: `ctrl+shift+m`.

| Tool                                              | Purpose                                                |
| ------------------------------------------------- | ------------------------------------------------------ |
| `mission_status`                                  | Read mission state                                     |
| `mission_write`                                   | Atomically write a file inside the workspace           |
| `mission_check`                                   | Run the real criteria and return evidence paths        |
| `mission_verdict`                                 | Declare `met` / `blocked` (harness still verifies)     |
| `mission_task_done`                               | Worker completion report (harness still verifies)      |
| `mission_heartbeat`                               | Renew the worker's task lease while working            |
| `mission_report`                                  | Store read-only stage findings (investigator/reviewer) |
| `mission_fact`                                    | Store a durable fact that survives compaction          |
| `mission_log`                                     | Append to the durable journal                          |
| `mission_web_search` / `mission_web_fetch`        | Search the web / fetch a page safely                   |
| `mission_image_search` / `mission_image_generate` | Find or generate images with attribution               |
| `mission_research` / `mission_research_note`      | Orchestrate research and save artifacts                |

## Configuration

### Plugin options (`opencode.jsonc`)

| Option                | Default          | Meaning                                                 |
| --------------------- | ---------------- | ------------------------------------------------------- |
| `model`               | auto             | `{providerID, id}` forced for planner, lead and workers |
| `plannerModel`        | auto             | Override for the planning call only                     |
| `fallbackModel`       | auto             | Override used on quota errors                           |
| `fastModel`           | auto             | Model for read-only roles (investigator/reviewer)       |
| `modelsByRole`        | unset            | Per-role model map, e.g. `{ "reviewer": {...} }`        |
| `missionsRoot`        | `<cwd>/missions` | Where generated mission workspaces live                 |
| `maxWorkers`          | `3`              | Maximum parallel sub-agents per wave                    |
| `imageModel`          | auto             | `{providerID, id}` used by `mission_image_generate`     |
| `workerTimeoutMs`     | `600000`         | Max wait for a read-only role agent                     |
| `enableWorkers`       | `true`           | Set to `false` for single-agent runs                    |
| `notifyUrl`           | unset            | POST terminal-state JSON to this URL                    |
| `MISSION_WEBHOOK_URL` | unset            | Environment alternative to `notifyUrl`                  |

### Mission frontmatter (`.mission/mission.md`)

| Key                      | Default    | Meaning                                                |
| ------------------------ | ---------- | ------------------------------------------------------ |
| `max_turns`              | `16`       | Turn ceiling                                           |
| `budget_usd`             | `5`        | Cost ceiling (when the provider reports cost)          |
| `max_wallclock_min`      | `0`        | Wall-clock ceiling (0 = off)                           |
| `lease_ms`               | `300000`   | Worker lease duration; renew with `mission_heartbeat`  |
| `max_extensions`         | `3`        | How many times the `EXTEND` file may raise the budgets |
| `continuous_improvement` | `true`     | Audit/improve after the objective is met               |
| `max_improve_cycles`     | `5`        | Bounded improvement cycles                             |
| `min_impact`             | `medium`   | Minimum finding impact worth implementing              |
| `max_writes`             | `0`        | Successful file writes before aborting (0 = off)       |
| `max_failures`           | `3`        | Failed turns before aborting                           |
| `handoff_every_turns`    | `4`        | Rotate to a fresh session (0 = off)                    |
| `isolation`              | `none`     | `worktree` runs in a sibling git worktree              |
| `stall_after_turns`      | `2`        | Strategy-escalation threshold                          |
| `autonomy`               | `standard` | `campaign` enables long-horizon defaults               |
| `auto_extend`            | `false`    | Extend soft budgets while progress is verified         |
| `hard_budget_usd`        | `0`        | Absolute cost cap that extensions never cross          |
| `extension_turns`        | `8`        | Turns granted per extension                            |
| `extension_writes`       | `50`       | Writes granted per extension                           |
| `goal_audit`             | `false`    | Audit objective coverage before completion             |
| `max_goal_audits`        | `3`        | Rounds of goal-gap repair                              |
| `worker_timeout_ms`      | `1800000`  | Max lifetime of a worker without heartbeat             |
| `needs_research`         | `false`    | Dispatch a researcher alongside the investigator       |

## Mission files

```text
<workspace>/.mission/
  charter.md        immutable goal + acceptance criteria
  mission.md        frontmatter + objective
  criteria.json     the definition of done: [{id, cmd, expect, timeout_ms}]
  tasks.json        task graph: {id, subject, files, verify, blocked_by}
  state.json        durable supervisor state
  journal.md        append-only audit log; tail injected, rotates to journal.<ts>.md
  memory.md         distilled decisions/constraints (~4k), injected into every request
  summary.md        regenerated short memory summary
  progress.json     task leases: owner, attempts, lease_until, last_error
  roadmap.md        optional checklist of chained missions
  EXTEND            consume to grant one bounded budget extension
  evidence/*.txt    stdout, stderr, exit code and timing per check
  PAUSE             pause at the next idle boundary (remove + resume to continue)
  STOP              kill switch, checked at every idle boundary
  research/         reports, sources.json, pages/ and images/ (Research Mode)
```

`expect` is `exit0` or `contains:<text>` (requires exit 0 and the substring).

## Documentation

| File                                   | For                                                                |
| -------------------------------------- | ------------------------------------------------------------------ |
| [`CONTRACT.md`](./CONTRACT.md)         | Host-agnostic contract and file formats                            |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Module map, data flow and the invariants that must not break       |
| [`RUNBOOK.md`](./RUNBOOK.md)           | Running unattended for hours: budgets, monitoring, stop and resume |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Development rules and PR checklist                                 |
| [`SECURITY.md`](./SECURITY.md)         | Threat model and reporting                                         |

## Development

```sh
npm install
npm run check          # syntax check every source and test file
npm test               # full suite, no network or TUI required
node --test --watch test/*.test.js
```

The plugin has a server part (`@opencode/plugin`) and a TUI part (`./tui`,
`@opencode/plugin/tui`). Mission Control renders **one** persistent surface: a
compact card in the sidebar (including a clear CTA on empty sessions). A fuller
dashboard opens on demand as a session panel or full-screen route via
`ctrl+shift+m`; there are no duplicate composer/footer HUDs.

The dashboard shows progress, requirement coverage, checks, tasks, live agents,
budget, a sparkline of verified progress and the journal tail. Pure rendering
data lives in `src/tui/model.js` and `src/tui/format.js` and is covered by tests.
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
