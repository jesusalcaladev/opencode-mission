# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
