# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
