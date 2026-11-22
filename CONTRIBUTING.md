# Contributing

Thanks for helping improve `opencode-mission`. This is a small plugin with a strong
invariant: **the harness decides completion, the model only proposes it**. Please keep
that intact.

## Setup

```sh
git clone https://github.com/<owner>/opencode-mission.git
cd opencode-mission
npm install
npm test
```

Requirements: OpenCode 2.x, Node.js 20+.

## Project layout

```text
src/
  index.js       plugin entrypoint: commands, tools, hooks, cleanup
  supervisor.js  the loop: verify, dispatch workers, decide, persist
  mission.js     pure state machine + durable state helpers
  planner.js     natural language -> validated executable plan
  team.js        pure wave scheduling and worker prompt building
  checks.js      criteria runner with timeout and evidence
  verify.js      test hashing, git checkpoints, worktree isolation
test/            node:test suites (no TUI, no network)
demos/cli/       pre-authored example mission
CONTRACT.md      host-agnostic contract
```

## Ground rules

- Plain ESM JavaScript. No TypeScript build step, no transpiler.
- Keep `mission.js`, `planner.js`, `team.js`, `checks.js` and `verify.js` free of
  OpenCode imports: they must stay testable with `node --test` alone.
- Every behavior change needs a test. A feature without a passing test is not done.
- All user-visible text, comments and test names are in English.
- Never let the model set `status: complete`. Only `Supervisor.finish` writes terminal
  state, and only after the harness re-ran the criteria.
- Writes are workspace-scoped and atomic (`writeTextAtomic` / `writeJsonAtomic`). Do not
  add a path that can escape the mission root.
- State updates from parallel workers go through `Supervisor.serialize(root, fn)` to
  avoid lost read-modify-write races on `state.json`.
- Keep prompt injections at the END of the system array; the stable prefix must remain
  cacheable.

## Adding a tool

1. Register it in `src/index.js` inside `ctx.tool.transform`, using the `mission`
   namespace and `codemode: false`.
2. Implement the handler on `Supervisor` in `src/supervisor.js`.
3. Add a test in `test/supervisor.test.js` using `fakeCtx()`.
4. Document it in the tool table in `README.md`.

## Adding a command

Commands are subcommands of `/mission`, parsed in `src/index.js`. Keep `execute` brief:
delegate to a `Supervisor` method, and avoid synthetic notices on `start`/`resume`
because they can create a second idle boundary.

## Adding a check type

`expect` currently supports `exit0` and `contains:<text>`. Extend `evaluateExpect` in
`src/checks.js` and add cases to `test/mission.test.js`. Keep the evaluation pure.

## Tests

```sh
npm test                          # full suite
node --test test/planner.test.js  # one file
```

Tests must not require a running OpenCode service, an API key or the network. Use
`mkdtemp` for filesystem fixtures and clean up in `finally`.

## Pull requests

- One concern per PR; explain the user-visible effect.
- Include the test command output and, for loop changes, a journal excerpt from a real
  mission run.
- Update `README.md` and `CONTRACT.md` when behavior or file formats change.
- Add a `CHANGELOG.md` entry under `Unreleased`.

## Reporting bugs

Open an issue with the OpenCode version, Node version, the plugin options in use
(redact secrets), the relevant `.mission/journal.md` tail and whether a worker or the
lead was involved. Avoid pasting API keys or full transcripts.

## Security

See [SECURITY.md](./SECURITY.md). Never commit generated missions, credentials or
`node_modules/` (both are gitignored).
