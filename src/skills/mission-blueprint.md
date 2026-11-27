---
name: mission-blueprint
description: Engineering loop for a mission — recon, blueprint, verified tasks, review, report
---

# Mission engineering loop

A mission is not one agent guessing. It is a loop where every phase leaves durable evidence on disk:

1. **Recon (read-only, parallel).** Several agents inspect different areas of the project and report real files, real commands, risks, and proposed checks/tasks. Reports live in `.mission/discovery/`; a resumed mission reuses them instead of paying twice.
2. **Blueprint (one architect).** The reports are collected into a single implementation plan: milestones, file ownership, build order, and a machine plan (checks + tasks). Written to `.mission/blueprint.md` (and `blueprint.json`).
3. **Harness validation.** The blueprint plan passes the same validation as any planner plan: safe commands, no vacuous checks, acyclic dependencies, every task names a check. Invalid parts are rejected, never trusted.
4. **Implementation (parallel workers).** 3–4 implementers per wave, one task each, disjoint files, verified by the harness.
5. **Review and repair.** Two independent reviewers, an integrator for cross-module breakage, a goal auditor for requirement gaps, and bounded improvement cycles. Any high finding reopens work.
6. **Report.** `MISSION_REPORT.md` records what was done, how it was verified, agents/models/costs, files changed, dependencies added, decisions and next steps.

Rules that never change:

- The model proposes; the harness verifies. A red check beats any verdict.
- `.mission/` is harness-owned: never write criteria, tasks or state.
- Checks must be red before the work and green after it. No `true`, `echo ok`, `ls` or `pwd`.
- One task owns one verifiable unit with a disjoint file list.
- Prefer inspected reality over assumptions: cite paths you actually read.
