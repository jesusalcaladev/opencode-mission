---
id: game-engine-demo
max_turns: 60
budget_usd: 8
hard_budget_usd: 30
max_wallclock_min: 240
auto_extend: true
max_extensions: 20
extension_turns: 20
extension_writes: 200
goal_audit: true
max_goal_audits: 3
lease_ms: 600000
worker_timeout_ms: 1800000
max_writes: 500
max_failures: 5
handoff_every_turns: 8
needs_research: false
continuous_improvement: true
max_improve_cycles: 10
min_impact: medium
isolation: none
---

Build a complete, deterministic 2D game engine core with a fixed-step loop, entity
management, AABB collision, sprite assets and a headless demo that renders a frame.

Original request: make a game-engine completo

Completion is defined ONLY by criteria.json. All tasks must be verified by the harness.

- DONE: fixed-step loop advances exactly one frame per step
- DONE: entity create/destroy works
- DONE: AABB collision detects overlap
- DONE: sprite assets load from a manifest
- DONE: headless demo prints a rendered frame
