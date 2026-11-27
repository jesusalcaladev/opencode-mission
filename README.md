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

Version 0.4.0 adds **Relentless Mode** (blocked → re-plan, review → rework,
failed tasks → unlimited retries, only hard caps/STOP can end the run),
**verified work** (baseline red→green + optional mutation control), dynamic
parallelism with per-file locks and `mission_spawn`, and an **external watchdog**
that can revive a quiet mission after a host restart. 0.3.0 added Mission
Control, Campaign Mode and Research Mode.

Earlier versions added **durable distilled memory** (decisions survive hundreds of
turns) and **task leases** (a dead worker's task is reclaimed instead of stuck forever).

## Features

- **Discovery before planning** — `/mission start` first dispatches 3–4 read-only
  recon agents in parallel (architecture, tests, toolchain, risks), collects their
  reports in `.mission/discovery/`, and a single architect turns them into a
  blueprint with milestones, file ownership and a machine plan in
  `.mission/blueprint.md`. The harness validates that plan like any other, then
  hands it to parallel implementers. `--quick` skips the prelude.
- **Natural-language intake** — `/mission start build a CLI with three tests` writes
  `.mission/` in the **current directory** (your real project), plans checks and tasks,
  and starts the run. A path instead of prose runs a pre-authored `.mission/` directory.
- **No fake completion** — if the planner fails, the harness uses the project's own
  `npm test` / `build` / `lint` / `pytest` / `go test` commands as criteria. If no real
  criterion can be found, the mission refuses to start instead of passing a vacuous
  "any file exists" check.
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
- **Long, separated task plans** — campaign/relentless missions auto-split
  multi-file tasks into one-file subtasks with preserved dependencies, stage
  labels and per-task timing. The progress bar is monotonic and computed from
  the same durable state the harness uses, so a re-plan never moves it backwards.
- **Shared durable context** — a bounded `context-pack` rebuilt from disk feeds the
  lead, every worker and every role. Workers get their check status, requirements,
  facts, discarded approaches and previous errors on retries; quiet workers get a
  refreshed brief when re-admitted. Five optional skills carry the static workflow
  contract, including the recon→blueprint engineering loop (`enableSkills: false`
  disables them).
- **Detailed final report** — every terminal state writes `MISSION_REPORT.md` in the
  project: what was done, how it was verified, agents/models/cost, files changed,
  dependencies added, decisions and next steps. `npm run report -- <dir>`
  regenerates it from durable files at any time.
- **Budget forecast** — the TUI extrapolates cost/tokens/minutes from the mission's
  own history and flags projected hard-budget/token overruns; the persistent
  mission queue is also visible in the dashboard.
- **Mission Control TUI** — a live HUD above the prompt, a sidebar card, footer
  badges, a session panel and a full-screen dashboard. On empty sessions it shows
  a clear call to action instead of nothing. `ctrl+shift+m` opens the dashboard.
- **Campaign Mode** — plans up to 120 tasks / 30 checks / explicit requirements;
  `/mission start --big` targets 15–30 checks and 20–40 tasks with a verified
  deployment gate,
  auto-extends budgets while verified progress continues, audits the actual goal
  before completion, and stops only at hard wall-clock/cost caps or `STOP`.
- **Relentless Mode** — `autonomy: relentless` (or `never_give_up: true`) turns
  every soft ceiling into unlimited effort: `blocked` forces a re-plan, high
  review findings force rework, goal gaps loop, failed tasks are re-queued, and
  supervisor errors recover. `STOP`, `PAUSE`, `hard_budget_usd`,
  `max_wallclock_min` and `test-erosion` remain absolute.
- **Verified work, not just green checks** — a check that was already green at
  baseline cannot complete a task; new checks start red; relentless missions
  optionally re-run each check after deleting the task's files to reject vacuous
  checks; two reviewers use distinct models when the catalog allows.
- **Dynamic parallelism** — `maxWorkers` is no longer capped at 8, capacity is
  recomputed per wave, per-file locks prevent overlapping writes, quiet workers
  are re-admitted before their lease is lost, and the lead can call
  `mission_spawn` to create a new verifiable task plus subagent on demand.
- **Research Mode** — `/mission research <question>` searches the web (OpenCode's
  websearch provider plus DuckDuckGo/Brave), fetches pages safely, finds and
  downloads images with attribution, and can generate images when a model exists.
- **Durable state** — `state.json`, `journal.md`, `evidence/` and a session→mission
  registry survive restarts; `/mission resume` and auto-resume pick up where it left off.
  Cost is aggregated across the lead, every worker/role session and direct model calls.
- **External watchdog** — `npm run watchdog` writes `.mission/WAKE` for quiet
  running missions; the in-process watcher consumes it and re-admits the lead.
  Safe to run from cron/systemd.
- **Opt-in host supervisor** — `npm run host-supervisor` reacts only to a WAKE
  marker that stayed stale (the in-process watchdog is gone). It respects
  `STOP`/`PAUSE`, backs off exponentially, caps restarts per window and writes
  its own ledger; it never edits mission state. Disabled until a command is set.
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
        "workspaceMode": "project",
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
/mission start --long build the whole game engine and keep going for hours
/mission start --quick write only the README (skip recon/blueprint)
/mission parallel build alpha CLI | build beta CLI | write the docs
/mission queue add write the docs p:5
/mission queue list
/mission queue run 2
/mission research duckduckgo vs brave search APIs for a research agent
/mission status
/mission pause
/mission stop
/mission resume
/mission help
```

The plugin prints the generated plan, schedules the workers, and then verifies the
criteria itself. By default the mission works **in the directory you launched it from**:
its control files are in `<project>/.mission/` and checks run against your real files.
Set `"workspaceMode": "sandbox"` to get isolated workspaces under `missionsRoot`
(used automatically for `/mission parallel`). A mission never follows you into another
project: switching directories makes the previous mission inactive until you resume it
with `/mission resume <dir>`.

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
recon agents (3-4, parallel, read-only) -> .mission/discovery/*.md
        |
        v
architect (1 agent) -> .mission/blueprint.md + machine plan
        |
        v
harness validation -> criteria.json + tasks.json (many checks, many tasks)
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

| Command                              | Purpose                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `/mission start <objective or path>` | Plan and start a mission, or run a pre-authored one          |
| `/mission parallel A \| B \| C`      | Start up to 8 independent missions in parallel lead sessions |
| `/mission queue add A [p:N]`         | Add a mission to the persistent priority queue               |
| `/mission queue list` / `run [n]`    | Inspect or launch queued missions                            |
| `/mission status`                    | Show state, checks, tasks, budget and model                  |
| `/mission research <question>`       | Research with web sources, images and a written report       |
| `/mission pause`                     | Pause at the next idle boundary (remove `PAUSE` to resume)   |
| `/mission stop`                      | Abort and keep state on disk                                 |
| `/mission resume [path]`             | Resume a stopped or interrupted mission                      |
| `/mission help`                      | Show command help                                            |

TUI commands (also in the command palette): `/mission-dashboard`,
`/mission-panel`, `/mission-start`, `/mission-stop`, `/mission-pause`,
`/mission-resume`, `/mission-open`. Default keybind: `ctrl+shift+m`.

`/mission-start <objective>` takes the objective inline — no dialog. Typing it
alone still opens the "New mission" prompt. `/mission-new` is an alias; the bare
`/missionstart` spelling is no longer advertised (use `/mission start` or
`/mission-start`) but old input is still parsed for compatibility.

| Tool                                              | Purpose                                                   |
| ------------------------------------------------- | --------------------------------------------------------- |
| `mission_status`                                  | Read mission state                                        |
| `mission_write`                                   | Atomically write a file inside the workspace              |
| `mission_check`                                   | Run the real criteria and return evidence paths           |
| `mission_verdict`                                 | Declare `met` / `blocked` (harness still verifies)        |
| `mission_task_done`                               | Worker completion report (harness still verifies)         |
| `mission_heartbeat`                               | Renew the worker's task lease while working               |
| `mission_spawn`                                   | Lead tool: create a verifiable task + dispatch a subagent |
| `mission_report`                                  | Store read-only stage findings (investigator/reviewer)    |
| `mission_fact`                                    | Store a durable fact that survives compaction             |
| `mission_log`                                     | Append to the durable journal                             |
| `mission_web_search` / `mission_web_fetch`        | Search the web / fetch a page safely                      |
| `mission_image_search` / `mission_image_generate` | Find or generate images with attribution                  |
| `mission_research` / `mission_research_note`      | Orchestrate research and save artifacts                   |

## Configuration

### Plugin options (`opencode.jsonc`)

| Option                            | Default          | Meaning                                                                         |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `model`                           | auto             | `{providerID, id}` forced for planner, lead and workers                         |
| `plannerModel`                    | auto             | Override for the planning call only                                             |
| `fallbackModel`                   | auto             | Override used on quota errors                                                   |
| `fastModel`                       | auto             | Model for read-only roles (investigator/reviewer)                               |
| `modelsByRole`                    | unset            | Per-role model map, e.g. `{ "reviewer": {...} }`                                |
| `workspaceMode`                   | `project`        | `project` = current directory; `sandbox` = isolated dirs                        |
| `defaultAutonomy`                 | unset            | `relentless` / `campaign`: every new mission runs unattended (same as `--long`) |
| `discovery`                       | `true`           | Recon + architect blueprint before planning (`false` = single planner pass)     |
| `reconAgents`                     | `3`              | Parallel read-only recon agents (1–4 areas)                                     |
| `missionsRoot`                    | `<cwd>/missions` | Sandbox/queue root (not used for normal `/mission start`)                       |
| `maxWorkers`                      | `3`              | Max parallel sub-agents per wave (no hard cap)                                  |
| `wakeIntervalMs`                  | `15000`          | How often the internal WAKE watcher scans                                       |
| `parallelSlots`                   | `8`              | Max running missions from the persistent queue                                  |
| `autoQueue`                       | `false`          | Auto-launch queued missions on a timer                                          |
| `queueIntervalMs`                 | `30000`          | Queue scheduler interval                                                        |
| `maxQueueAttempts`                | `3`              | Failed queue launches before an entry is marked failed                          |
| `maxWorkerRevives`                | `1` / `∞`        | Quiet-worker re-admits (unlimited in relentless)                                |
| `imageModel`                      | auto             | `{providerID, id}` used by `mission_image_generate`                             |
| `workerTimeoutMs`                 | `600000`         | Max wait for a read-only role agent                                             |
| `enableWorkers`                   | `true`           | Set to `false` for single-agent runs                                            |
| `enableSkills`                    | `true`           | Register the four static mission skills                                         |
| `notifyUrl`                       | unset            | POST terminal-state JSON to this URL                                            |
| `MISSION_WEBHOOK_URL`             | unset            | Environment alternative to `notifyUrl`                                          |
| `MISSION_HOST_RESTART_COMMAND`    | unset            | Command used by the opt-in host supervisor                                      |
| `MISSION_HOST_RESTART_MAX`        | `3`              | Restarts per window before giving up                                            |
| `MISSION_HOST_RESTART_BACKOFF_MS` | `60000`          | Base exponential backoff                                                        |

### Mission frontmatter (`.mission/mission.md`)

| Key                      | Default    | Meaning                                                                               |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| `max_turns`              | `16`       | Turn ceiling                                                                          |
| `budget_usd`             | `5`        | Cost ceiling (when the provider reports cost)                                         |
| `max_wallclock_min`      | `0`        | Wall-clock ceiling (0 = off)                                                          |
| `lease_ms`               | `300000`   | Worker lease duration; renew with `mission_heartbeat`                                 |
| `max_extensions`         | `3`        | How many times the `EXTEND` file may raise the budgets                                |
| `continuous_improvement` | `true`     | Audit/improve after the objective is met                                              |
| `max_improve_cycles`     | `5`        | Bounded improvement cycles                                                            |
| `min_impact`             | `medium`   | Minimum finding impact worth implementing                                             |
| `max_writes`             | `0`        | Successful file writes before aborting (0 = off)                                      |
| `max_failures`           | `3`        | Failed turns before aborting                                                          |
| `handoff_every_turns`    | `4`        | Rotate to a fresh session (0 = off)                                                   |
| `isolation`              | `none`     | `worktree` runs in a sibling git worktree                                             |
| `stall_after_turns`      | `2`        | Strategy-escalation threshold                                                         |
| `autonomy`               | `standard` | `standard`, `campaign` or `relentless`                                                |
| `never_give_up`          | `false`    | Unlimited soft effort ceilings; hard caps still apply                                 |
| `max_task_attempts`      | `3`        | Per-task retries (`0` = unlimited)                                                    |
| `max_review_attempts`    | `2`        | Review rework rounds (`0` = unlimited)                                                |
| `mutation_checks`        | `false`    | Reject checks that stay green without the owned files                                 |
| `require_e2e`            | `false`    | Require an e2e/smoke check (default in relentless)                                    |
| `strict_checks`          | `false`    | Refuse unsafe/vacuous criteria commands from **any** source (default in relentless)   |
| `sandbox`                | `none`     | `copy` runs checks in a disposable workspace copy with a minimal env                  |
| `global_memory`          | `false`    | Share distilled decisions across missions under the same root (default in relentless) |
| `auto_extend`            | `false`    | Extend soft budgets while progress is verified                                        |
| `hard_budget_usd`        | `0`        | Absolute cost cap that extensions never cross                                         |
| `max_tokens`             | `0`        | Absolute token cap (`0` = off); non-extendable                                        |
| `extension_turns`        | `8`        | Turns granted per extension                                                           |
| `extension_writes`       | `50`       | Writes granted per extension                                                          |
| `goal_audit`             | `false`    | Audit objective coverage before completion                                            |
| `max_goal_audits`        | `3`        | Rounds of goal-gap repair                                                             |
| `worker_timeout_ms`      | `1800000`  | Max lifetime of a worker without heartbeat                                            |
| `needs_research`         | `false`    | Dispatch a researcher alongside the investigator                                      |

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
  discovery/*.md    recon reports per area (architecture, quality, toolchain, risks)
  blueprint.md      architect blueprint (milestones, ownership, build order)
  blueprint.json    machine plan extracted from the blueprint and validated
  MISSION_REPORT.md written at the project root on every terminal state
  evidence/*.txt    stdout, stderr, exit code and timing per check
  PAUSE             pause at the next idle boundary (remove + resume to continue)
  STOP              kill switch, checked at every idle boundary
  WAKE              external watchdog request; consumed by the live supervisor
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
npm run check          # syntax + architecture guardrails (size, test globals, boundaries)
npm test               # full suite, no network or TUI required
npm run eval           # end-to-end eval cases through the real supervisor
npm run doctor -- ./missions/<workspace>  # read-only mission health report
npm run report -- ./missions/<workspace>  # regenerate MISSION_REPORT.md (--print for stdout)
npm run eval -- --filter cli-standard --json
npm run test:watch     # watch tests while developing
npm run lint           # eslint (strict rules)
npm run format         # prettier --write .
npm run format:check   # prettier --check .
npm run typecheck      # tsc --noEmit (TUI)
npm run quality        # check + lint + format + typecheck + coverage
```

The plugin has a server part (`@opencode/plugin`) and a TUI part (`./tui`,
`@opencode/plugin/tui`). Mission Control renders **one** persistent surface: a
compact card in the sidebar (including a clear CTA on empty sessions). A fuller
dashboard opens on demand as a session panel or full-screen route via
`ctrl+shift+m`; there are no duplicate composer/footer HUDs.

### Evaluation

`eval/cases/*.json` defines end-to-end scenarios (standard completion, baseline
vacuity, blocked → re-plan, review rework, token ceiling, strict checks, WAKE
watchdog, parallel queue, multi-session cost, global memory, model rotation,
sandboxed checks). `scripts/mission-eval.mjs` runs them through the real
`Supervisor` with a deterministic fake OpenCode context — no network, no paid
models, no writes outside temp dirs. `eval/baseline.json` gates regressions in CI.

The dashboard shows progress, requirement coverage, checks, tasks, live agents,
budget, a sparkline of verified progress and the journal tail. Pure rendering
data lives in `src/tui/model.js` and `src/tui/format.js` and is covered by tests.
See [CONTRIBUTING.md](./CONTRIBUTING.md) before sending changes.

## Known limitations

- Each mission runs in one lead session; several missions run in parallel only via
  `/mission parallel` or the persistent queue.
- The TUI reads durable files: it refreshes every second while a mission is running,
  but a write that has not reached disk yet is invisible by design.
- Cost is aggregated across all mission sessions, but unpriced models still report $0.
  The turn/wall-clock ceilings and `hard_budget_usd` remain the reliable backstops.
- `relentless` removes soft ceilings, not hard ones. No harness can guarantee 100%
  correctness for an objective that cannot be expressed as real executable checks;
  baseline and mutation controls reduce, but do not eliminate, false positives.
- Model rotation is best-effort: if no free tools-capable model is available, the
  mission retries until `max_failures`.
- Criteria commands run in a shell inside the workspace. Only use criteria you trust.

## License

MIT — see [LICENSE](./LICENSE).
