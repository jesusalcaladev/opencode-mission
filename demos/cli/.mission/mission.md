---
id: cli-3-tests
max_turns: 12
budget_usd: 5
stall_after_turns: 2
handoff_every_turns: 3
max_wallclock_min: 60
max_failures: 3
isolation: none
---

Create a tiny dependency-free Node CLI in this workspace with three passing tests.

`cli.js --version` must print exactly `1.0.0`. `cli.js 2 3` must print `5`.
`cli.test.js` must contain at least three top-level `test(` calls and `node --test` must pass.

Non-goals: no npm dependencies, no build step, no README, no changes outside this workspace.
