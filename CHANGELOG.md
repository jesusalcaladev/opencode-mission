# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- End-to-end eval harness integrated with the real Supervisor: 8 deterministic
  cases, `npm run eval`, baseline regression gate and CI step.
- Budget forecast from durable telemetry (cost/tokens/minutes per turn) with
  projected hard-budget/token overrun flags in the TUI dashboard.
- Persistent priority queue for parallel missions: `/mission queue add|list|run`,
  priority + age ordering, bounded `parallelSlots`, optional `autoQueue`, and
  recovery of sessions that died across restarts.
- `max_tokens`: hard, non-extendable token ceiling with per-session accounting.
- `autonomy: relentless` / `never_give_up: true`: unlimited soft effort ceilings.
  `blocked` forces a re-plan, high review findings force rework, goal gaps loop,
  failed tasks retry forever, and supervisor errors recover. Hard budget,
  wall-clock deadline, `STOP`, `PAUSE` and `test-erosion` stay absolute.
- Verified work: `state.check_baseline` prevents an already-green check from
  completing a task; new checks start red; optional mutation control rejects
  vacuous checks; two reviewers use distinct models when available.
- Dynamic parallelism: no 8-worker cap, capacity recomputed per wave, per-file
  locks, quiet-worker re-admission, and a lead-only `mission_spawn` tool.
- External watchdog (`npm run watchdog`) writes `.mission/WAKE`; the internal
  watcher consumes it after host restarts.
- Cost is aggregated across lead, workers, roles and direct model calls; it never
  decreases.

### Added

- Unified disk-backed `context-pack` shared by the lead, workers and roles:
  bounded, task-relevant context with retry history (`attempts`, `last_error`).
- Four optional skills (`mission-workflow`, `mission-review`, `mission-research`,
  `mission-verdict`) registered through OpenCode's skill API; `enableSkills: false`
  disables them. Static contract in skills, dynamic state in briefs.
- Retry-aware worker prompts and brief refresh when a quiet worker is re-admitted.
- Actionable schema feedback for `mission_report` by role.
- Docs consistency check (`npm run check`) and senior review rubric in CONTRIBUTING.
- Opt-in external host supervisor (`npm run host-supervisor`): reacts only to a
  stale `WAKE`, respects `STOP`/`PAUSE`, exponential backoff and a restart cap,
  writes its own ledger, and never edits mission state. TUI shows restart count.
- Optional `sandbox: copy` for criteria: disposable workspace copy + minimal
  environment, with per-check override and dedicated eval.
- Architecture checker in `npm run check`: ≤250 lines per source file, no test
  globals in `src/`, no barrel destructuring in mixins, no terminal writes
  outside `decide()`/`finish`, and injected eval/CI guardrails.
- Three more eval cases (multi-session cost, global memory, model rotation) → 11 total.
- Modularity refactor: main turn loop, telemetry, task splitting, TUI keymap and
  normalization extracted into focused modules; `src/mission.js` is now a barrel.

### Changed

- Cleanup pass: removed 13 blanket lint suppressions and 31 dead constants/imports
  that were hidden behind them; all `src/**` is lint-clean with no suppressions.
- `buildDecision()` centralizes the three turn-time `decide()` call sites so
  stop/pause/baseline inputs cannot drift apart.
- Architecture checker also rejects lint suppressions, `console.log`, TODO/FIXME
  and eval cases missing from the baseline.
- Stricter ESLint gate: unused vars/empty blocks are errors, plus `no-var`,
  `eqeqeq`, `no-throw-literal`, `no-return-assign`, `no-useless-concat` and
  `no-self-compare`. Coverage floors raised to 87/69/82.5.

### Fixed

- Flaky journal rotation test now looks for the newest line across all kept
  files, not only the active journal.
- `recordWorkerCost` now updates the durable token ledger as well as cost.
- Worker cost was clobbered when a mission completed in the same turn: the
  cost snapshot is now refreshed after workers finish (covered by an eval).
- Journal archives are pruned by modification time instead of filename, so a
  random suffix can no longer cause the newest lines to be deleted under load.

- `/mission-start <objective>` now accepts the objective inline. The TUI slash
  command was registered without `slash.arguments`, so OpenCode discarded the
  text after the command and always opened the dialog — which is why the server
  form `/mission start ...` worked but the slash form did not. It now parses
  the raw input (including the command token, the no-hyphen alias and the
  server spelling) and only prompts when nothing was typed.
- Mission Control no longer renders workspaces that are gone or half-authored.
  `current.json` and `missions.json` are stale by design; `discoverRoots` and
  `loadTuiModel` now verify a root has all four mission files before showing it,
  so a deleted folder or a failed plan can no longer appear as
  "(no objective) / 0 checks" with a path that does not exist.
- A planner/model failure no longer leaves a `.mission/` with only `state.json`:
  `planAndStart` falls back to a complete plan, and removes the just-created
  workspace if even the minimal files cannot be written.
- Mission Control is now scoped to the active session. The TUI used to show the
  single global `current.json` mission in every terminal, so concurrent sessions
  all displayed (and could stop/pause) the same mission. Each terminal now shows
  only the mission bound to its own session; a session without a mission shows
  the empty state. The sidebar and its progress bar are also reactive again:
  the bar used to freeze at its first value and now advances with sub-cell
  resolution as checks and tasks turn green.

## [0.4.0] - 2026-11-22

### Changed

- **Architecture cleanup:** every supervisor mixin now reaches dependencies through
  `this.d` instead of a 40-name destructure. All source files are ≤ 250 lines.
- Split large modules into focused files: supervisor decisions/models/registry/
  planning/roles-pipeline/goal-audit/improvements/scheduler/research-tools,
  mission persistence/bootstrap/journal, planner prompt/normalize/plan, research
  text/search/images/report, and TUI components/lists/dashboard-parts/types.
- Mission Control now renders only the sidebar HUD; the composer and footer HUDs
  were removed. The dashboard and panel remain on demand.

### Added

- Tooling: ESLint 9, Prettier 3 and TypeScript (TUI only) as devDependencies, plus
  `npm run lint`, `format`, `format:check`, `typecheck`, `coverage` and `quality`.
- Coverage gates: ≥85% lines, ≥65% branches, ≥80% functions; 140 tests pass.
- `scripts/check-syntax.mjs` checks all JS/MJS files recursively.
- CONTRIBUTING and ARCHITECTURE updated with the new rules and module map.

## [0.3.1] - 2026-11-22

### Changed

- Mission Control now renders a **single** persistent surface: the sidebar card.
  The composer HUD and the home/prompt footer badges were removed; the dashboard
  and panel remain available on demand via `ctrl+shift+m`.

### Added

- Recovery hardening: deduplicated prompt ledger (`prompt_ledger`) for start,
  nudge, rescue, auto-resume and backoff prompts; handoff lineage (`handoffs`);
  stale-worker lease recovery on plugin load; registry pruning.
- Telemetry: `state.metrics` mirrored to `.mission/metrics.json` with counters for
  turns, checks, tasks, agents, recoveries, extensions, handoffs, replans,
  splits, improvements, writes, research calls and goal audits. The dashboard has
  a TELEMETRY panel.
- Dynamic task splitting: a task with two failed attempts is decomposed into 2–5
  verifiable subtasks by the planner instead of being retried blindly.
- Research cache (24h) and Serper/Tavily providers in addition to DuckDuckGo/Brave.

## [0.3.0] - 2026-11-22

### Added

- **Mission Control TUI**: live HUD in `session.composer.top`, sidebar card,
  home/prompt footer badges, a session panel and a full-screen dashboard with
  checks, tasks, agents, requirements, budget, sparkline and journal tail.
  Empty sessions now show an explicit CTA. `ctrl+shift+m` opens the dashboard;
  commands exist for start/stop/pause/resume/open.
- **Campaign Mode**: plans up to 60 tasks / 24 checks with explicit requirements,
  milestones and a definition of done. Soft budgets auto-extend while verified
  progress continues, bounded by `hard_budget_usd` and `max_wallclock_min`.
  `PAUSE` pauses cleanly at the next idle boundary.
- **Goal audit**: before completion an independent auditor checks the objective
  against requirements and evidence. `GAP:` lines become tasks (and, when safe,
  new e2e checks) in bounded rounds; completion is impossible with uncovered
  requirements.
- **Monotonic re-planning**: a re-plan cannot drop a green check or a completed
  task; completed work is preserved and new work is appended.
- **Continuous worker pool**: workers run for their lease/heartbeat instead of a
  120 s timeout, the next ready task starts as soon as one finishes, and lead
  ticks are scheduled from worker completion events.
- **Parallel roles**: investigator + researcher and two reviewers now run in
  parallel; a new Integrator role fixes cross-module issues before review.
- **Research Mode**: `DuckDuckGo` websearch provider registered with OpenCode,
  Brave/Serper-ready, plus `mission_web_search`, `mission_web_fetch` (SSRF
  guard), `mission_image_search` (Openverse/Wikimedia), `mission_image_generate`,
  `mission_research` and `mission_research_note`. `/mission research <question>`
  creates a verified research mission.
- Telemetry: `state.history`, `state.agent_runs`, `last_checks_at`, `phase` and a
  global mission registry for the TUI.

### Changed

- Planner now emits `kind`, `retries`, requirements and campaign settings; checks
  may run up to 10 minutes and retry flaky failures.
- Role stages in campaign mode: `investigate → implement → integrate → verify →
review → goal-audit → improve`.

## [Unreleased]

### Added

- **TUI part** (`./tui`): live mission progress in `home.footer.status` plus a
  `/mission-status` command and toast. Server can now write a pointer file so
  the TUI reads durable state without polling the server.
- Second-opinion review: two independent reviewers; `SEVERITY: high` only blocks
  if both agree, otherwise it is downgraded to `medium`.
- Repeat guard: three turns without verified progress force strategy tier 3.
- Model-driven memory compaction with the keyword distiller as fallback.
- Planner asks for `cost_hint` / `time_hint` per task.

### Added

- Parallel criteria execution (`maxParallel`, default 3) with workspace-fingerprint
  caching: unchanged work reuses the last verified results instead of re-running.
- Model per role: `fastModel` for read-only roles, `model` for implementers, and
  `modelsByRole` overrides. `AGENTS.md`/`CLAUDE.md` hierarchy is injected into every brief.
- Structured `mission_fact` store that survives compaction, plus a progress bar in
  `/mission status`.

### Fixed

- `gitCommit` no longer uses `git add -A`: only mission-owned `files` are staged.
  Added `gitRevert` and automatic rollback of improvement cycles that break checks.

### Changed

- `src/supervisor.js` shrank from 1400 to ~240 lines. Behavior moved into six
  cohesive mixins under `src/supervisor/` (state, recovery, lifecycle,
  intelligence, workers, tools) with a shared dependency barrel. No behavior
  changed: all 76 tests still pass.

### Added

- Continuous improvement is **on by default**: after the original criteria are
  green, a read-only auditor proposes findings, worthwhile ones become bounded
  implementation cycles, and each cycle is verified. Stops on a value threshold
  (2 clean audits), cycle limit, budget or `STOP` — never infinitely.
- `.mission/improvements.md` backlog and `src/mission/improve.js` pure decision
  module. `finish_reason` now reports `no-high-value-improvements` or
  `improve-cycle-limit`.

### Added

- Specialized roles in the **same workspace** (no worktrees): Investigator
  (read-only research), Implementer (writes only assigned `files`), Tester and
  Reviewer (read-only). The harness owns stage transitions and tool permissions.
- Review gate: completion requires a clean review; `SEVERITY: high` reopens the
  tasks (max 2 attempts) and then blocks with `review-high`.
- `mission_report(role, text)` for read-only stage findings stored in
  `state.stage_reports`.
- Git commits are serialized through the mission write queue.

### Added

- Mission chaining: `.mission/roadmap.md` checklists; a completed mission starts
  the next item in the same workspace with distilled memory carried forward.
- `EXTEND` file + `max_extensions` (default 3): a budget stop can be extended a
  bounded number of times without removing the hard stops.
- Rescue timer: every 60 s a running mission whose session went quiet is
  re-admitted once, so the loop survives a missed `experimental.idle`.
- Chain/extensions are shown in `/mission status` and persisted in `state.json`.

### Fixed

- One serialized write queue per mission now covers journal, state and progress;
  25 concurrent journal appends were failing with `ENOENT` on the atomic rename.
- Worker leases are renewable with `mission_heartbeat(id)` and configurable via
  `lease_ms` frontmatter, so a slow worker is no longer reclaimed by mistake.
- `normalizePlan` rejects vacuous checks (`true`, `exit 0`, `echo ok`, `:`) so a
  model cannot define "done" as a command that verifies nothing.

### Added

- Real watchdog: after two verified-stalled turns the harness asks the model for a
  completely new plan, validates it with the same rules as the initial plan, and
  applies it without resetting turn/cost/write counters.
- Per-task report verification: a `done` report whose `verify` check is red is
  rejected and the lease is released for retry.
- `max_writes` ceiling and wall-clock frontmatter are now enforced by `decide()`.
- `ARCHITECTURE.md` and `RUNBOOK.md` for long unattended runs.

## [0.2.0] - 2026-11-21

### Added

- Durable mission memory: `charter.md`, `memory.md`, `summary.md` and periodic
  distillation of the raw journal into a bounded brief (~4k) regenerated from
  disk on every model request. Decisions from turn 5 remain visible at turn 200.
- Task leases in `progress.json` (`claim` / `renew` / `expire` / `retry`): a failed
  or silent worker's task is reclaimed instead of being stuck `in_progress`.
- Structured `mission_task_done(id, status, summary, evidence)`; worker failures
  back off, rotate models and release the lease for retry.
- Automatic v1 → v2 migration of existing missions: criteria, tasks and state are
  preserved and new files are created in place.

### Changed

- Pure logic split into `src/mission/{state,decide,memory,lease}.js`;
  `src/mission.js` is now a persistence facade that re-exports them.
- The injected brief carries distilled memory, a summary, workers in flight and
  a short journal tail instead of a raw 3000-character tail.

[0.2.0]: https://github.com/jesusalcaladev/opencode-mission/releases/tag/v0.2.0

### Fixed

- `mission_write` no longer accepts paths under `.mission/`; criteria, tasks and
  state are harness-owned and cannot be rewritten by the model.
- Duplicate `execution.failed` / `execution.interrupted` events for a single turn are
  counted once instead of consuming the failure budget twice.

### Changed

- Worktree branch and directory names are sanitized before reaching git.
- Added `npm run check` (syntax check) to development and CI.
- Removed dead code and made `mission_task_done` consistently async.

### Documentation

- README, CONTRACT and SECURITY now describe the protected mission-control directory.
- README no longer hardcodes a test count that can drift.

## [0.1.0] - 2026-11-21

### Added

- Autonomous mission loop driven by `session.idle`: the harness re-runs executable
  criteria after every turn and owns completion.
- Natural-language intake (`/mission start <objective>`) with a validated JSON plan,
  safe fallbacks and pre-authored-directory support.
- Parallel sub-agent workers: dependency- and file-conflict-aware waves, per-task
  sessions, `mission_task_done` reports and lead coordination.
- Automatic model/provider selection for planner, lead and workers; quota rotation
  with bounded exponential backoff.
- Durable state, journal, evidence and session registry with auto-resume after
  service restarts.
- Context handoff to fresh sessions, git checkpoints, worktree isolation and a
  test-erosion guard.
- Hard stops: turn, cost, wall-clock and failure ceilings plus a `STOP` kill switch.
- Optional terminal-state webhook notifications.
- Test suite (33 tests) covering the state machine, criteria runner, planner, wave
  scheduling and supervisor integration.

[0.1.0]: https://github.com/jesusalcaladev/opencode-mission/releases/tag/v0.1.0
