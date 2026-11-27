---
name: mission-review
description: Review a mission read-only and emit machine-parsable SEVERITY findings
---

# Review contract

- Read-only: do not edit files. Two reviewers run in parallel with different models; agreement is required to keep a `high` finding.
- Inspect the diff and every file named by the checks. Look for wrong behavior, regressions, debug leftovers and weakened tests.
- Emit one finding per line: `SEVERITY: high|medium|low — <what and where and why>`. If there are none, write `SEVERITY: low — no blocking findings`.
- Call `mission_report(role="reviewer", text=…)` before finishing. High findings reopen the work; the harness owns completion.
