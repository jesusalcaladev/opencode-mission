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
npm run quality
```

Requirements: OpenCode 2.x, Node.js 20+. `npm run quality` runs syntax checking,
ESLint, Prettier, TypeScript (TUI) and coverage gates.

## Project layout

```text
src/
  index.js       plugin entrypoint: commands, hooks, cleanup
  tool-definitions.js  mission_* tool registration
  supervisor.js  constructor + main loop; behavior lives in small mixins
  supervisor/    decisions, state, recovery, models, lifecycle, planning,
                 intelligence, roles-pipeline, goal-audit, workers, scheduler, tools
  mission.js     facade; implementation in mission/*.js (pure + persistence)
  planner.js     facade; implementation in planner/*.js
  research.js    facade; implementation in research/*.js
  team.js        pure wave scheduling and worker/role prompt building
  context.js     supervisor mixin: disk-backed briefs for lead/workers/roles
  skills.js      skill catalog registration (static workflow contract)
  skills/        skill markdown files registered with OpenCode
  mission/context-pack.js  pure bounded context shared by every brief
  checks.js      criteria runner with timeout, retries, strict mode and sandbox
  verify.js      test hashing, git checkpoints, worktree isolation
  tui.tsx        single sidebar HUD + on-demand dashboard (no duplicate HUDs)
test/            node:test suites (no TUI, no network)
eval/cases/      end-to-end cases executed through the real Supervisor
scripts/         syntax/architecture/docs checks, watchdog, host supervisor, eval CLI
demos/           pre-authored example missions (cli and game)
CONTRACT.md      host-agnostic contract
```

## Ground rules

- Plain ESM JavaScript for runtime code; TypeScript only for the TUI surface.
- No source file may exceed **250 lines**. Split by responsibility instead.
- Supervisor mixins never destructure the dependency barrel: use `this.d.*` only.
- Keep pure modules free of OpenCode imports: they must stay testable with
  `node --test` alone.
- Never leave an empty `catch {}`. Use `this.warn(root, label, err)` (journal +
  optional debug log); document the rare best-effort exception in a comment.
- Coverage gates: ≥87% lines, ≥69% branches, ≥82.5% functions. Network/TUI paths
  are integration-tested with mocked `fetch` rather than fully unit-tested.
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

1. Register it in `src/tool-definitions.js` using the `mission` namespace and
   `codemode: false`.
2. Implement the handler as a mixin method (workspace tools in `supervisor/tools.js`,
   research tools in `supervisor/research-tools.js`).
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

## Adding a role or a skill

- A role gets: a pure prompt in `team.js`, a `CAN_WRITE` entry in `mission/roles.js`,
  a stage transition in `mission/roles.js`, and a bounded brief via
  `supervisorContext.buildRoleBrief()`. Read-only roles must never be able to write.
- Stage reports have a machine contract: reviewer → `SEVERITY:`, auditor →
  `FINDING:`, goal auditor → `GAP:`. `validateStageReport()` returns an actionable
  correction instead of silently storing unusable text.
- Skills in `src/skills/*.md` describe the **static** workflow. Never duplicate
  dynamic state into them: that belongs in the disk-backed brief. Register them in
  `src/skills.js`; keep skill IDs stable and `autoinvoke: false`.
- Any new tool must be added to `tool-definitions.js` and documented in `README.md`;
  `npm run check` verifies docs consistency.

## Adding an eval

- Put a JSON case in `eval/cases/` with `id`, `mode`, `expect`, and deterministic
  `policy` inputs. Use a temp workspace and the fake OpenCode context in
  `scripts/eval-harness.mjs`; no network, no paid model calls.
- Run `npm run eval -- --update-baseline` **only** after an intentional behavior
  change; commit the new baseline together with the code.
- An invariant check (`complete` with red checks or pending tasks) belongs in
  `mission/eval.js`, not in the individual case.

## Senior review rubric

Before approving a change, confirm:

1. The harness still owns completion; no tool or role can set a terminal status.
2. Every source file is ≤250 lines, no lint suppression, no `console.log`, no TODO.
3. Pure logic stays in `mission/*` and is covered by `node --test` alone.
4. Context added to a brief is bounded and task-relevant (`context-pack.js`).
5. The change has a test **and** an eval if it affects the turn loop or a role.
6. `npm run quality` and `npm run eval` are green; docs and CHANGELOG updated.

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
