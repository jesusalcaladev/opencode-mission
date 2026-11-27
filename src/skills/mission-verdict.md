---
name: mission-verdict
description: Understand the harness-owned definition of done before declaring a verdict
---

# Definition of done

`complete` is written only by the harness when **all checks are green**, **every requirement is covered by a green check**, and **every task passed its verify check after a real red→green transition**.

- A check green at baseline cannot verify work; new checks start red.
- Optional mutation control re-runs a check after removing the task's files to reject vacuous checks.
- Hard stops: `STOP`, `PAUSE`, `hard_budget_usd`, `max_tokens`, `max_wallclock_min`, `test-erosion`.
- Relentless mode removes soft ceilings but never hard ones: blocked → re-plan, review findings → rework, goal gaps → more tasks.

Your verdict is a proposal. Evidence wins.
