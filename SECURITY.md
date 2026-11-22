# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Open a private security issue or contact the maintainer directly. Include:

- OpenCode and Node versions
- Plugin options (redact tokens, URLs with credentials and API keys)
- The relevant `.mission/journal.md` tail
- Steps to reproduce

Do not publish the issue until a fix is available.

## Threat model

This plugin runs commands. Understand what it trusts:

- **`criteria.json` commands execute in a shell** with the workspace as the working
  directory. Only run missions whose criteria you authored or reviewed. The planner
  rejects `sudo`, `rm -rf /`, destructive `dd`/`mkfs` and network-to-shell pipes, but
  that denylist is a guard, not a sandbox.
- **`mission_write` is workspace-scoped and atomic.** Absolute paths, `..` traversal
  and paths outside the mission root are refused. Paths under `.mission/` are also
  refused: criteria, tasks and state are harness-owned, so the model cannot redefine
  what "done" means.
- **The model cannot declare completion.** It can write files and call
  `mission_verdict`; the harness re-runs the criteria and is the only writer of
  terminal state.
- **The test guard hashes existing test files.** Editing or deleting one aborts the
  mission with `test-erosion`.
- **Webhooks are best-effort.** `notifyUrl` / `MISSION_WEBHOOK_URL` receive terminal
  status JSON only; a failed delivery never changes mission state.
- **State files contain transcripts and evidence**, not secrets by design. They are
  written atomically next to the workspace; do not commit them unless intended.

Generated mission directories (`runs/`), `node_modules/` and logs are gitignored.
