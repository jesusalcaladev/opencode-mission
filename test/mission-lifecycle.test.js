import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { Supervisor } from "../src/supervisor.js";
import { loadState, saveState } from "../src/mission.js";
import { loadTuiModel } from "../src/tui/model.js";

function ctx(directory) {
  const c = {
    prompts: [],
    synthetic: [],
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async ({ text }) => c.prompts.push(String(text)),
      synthetic: async ({ text }) => c.synthetic.push(String(text)),
      create: async ({ parentID }) => ({ id: parentID ? "ses_worker" : "ses_new" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
      wait: async () => {},
      switchModel: async () => {},
      context: async () => [],
    },
    model: { default: async () => null, list: async () => [] },
    event: { subscribe: async function* () {} },
    location: { directory },
  };
  return c;
}

const plan = {
  objective: "Build and verify the tiny CLI",
  checks: [
    { id: "unit", cmd: "test -f src/app.js", expect: "exit0", kind: "unit" },
    { id: "e2e", cmd: "test -f src/e2e.marker", expect: "exit0", kind: "e2e" },
  ],
  tasks: [
    { id: 1, subject: "Implement the CLI", files: ["src/app.js"], verify: "unit" },
    { id: 2, subject: "Verify the CLI end to end", files: ["src/e2e.marker"], verify: "e2e" },
  ],
  requirements: [
    { id: "req-unit", text: "CLI source exists", checks: ["unit"] },
    { id: "req-e2e", text: "CLI was exercised end to end", checks: ["e2e"] },
  ],
  settings: { autonomy: "standard" },
};

async function lifecycle({ git = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-lifecycle-"));
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  const previousCache = process.env.OPENCODE_MISSION_CACHE_DIR;
  process.env.OPENCODE_MISSION_CACHE_DIR = path.join(root, ".cache");
  const c = ctx(root);
  const sup = new Supervisor(c, {
    enableWorkers: false,
    enableRoles: false,
    discovery: false,
    generate: async () => JSON.stringify(plan),
  });
  try {
    await sup.planAndStart("lead", plan.objective, { discovery: false });
    // Exercise the deployment gate on a small mission too.
    let state = await loadState(root);
    state.require_deploy = true;
    state.deploy = { verified: false };
    await saveState(root, state);

    await sup.handleIdle("lead"); // baseline: both checks red
    state = await loadState(root);
    assert.equal(state.status, "running");
    assert.equal(state.check_baseline?.unit, false);
    assert.equal(state.deploy.verified, false);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.js"), "console.log(5)\n");
    await writeFile(path.join(root, "src", "e2e.marker"), "verified\n");

    await sup.handleIdle("lead"); // green transition + task commits + deploy gate
    state = await loadState(root);
    assert.equal(state.deploy.verified, true, JSON.stringify(state.deploy));
    assert.ok(state.deploy.lastCommit?.ok === true);
    assert.equal(state.status, "complete", `status: ${state.status}`);
    assert.match(await readFile(path.join(root, "MISSION_REPORT.md"), "utf8"), /## Deployment/);

    const model = await loadTuiModel({ sessionID: "lead", directory: root });
    assert.ok(model.snapshot, "TUI must see the completed mission");
    assert.equal(model.snapshot.checksGreen, 2);
    assert.equal(model.snapshot.tasksDone, 2);
    assert.equal(model.snapshot.deployVerified, true);
    assert.equal(model.snapshot.pct, 100);
    return { state, model };
  } finally {
    sup.dispose();
    if (previousCache === undefined) delete process.env.OPENCODE_MISSION_CACHE_DIR;
    else process.env.OPENCODE_MISSION_CACHE_DIR = previousCache;
    await rm(root, { recursive: true, force: true });
  }
}

test("lifecycle: red checks → verified deploy → complete, visible in the TUI", async () => {
  await lifecycle();
});

test("lifecycle: a mission without git still reaches a verified deploy", async () => {
  const { state, model } = await lifecycle({ git: false });
  assert.equal(state.deploy.lastCommit.ok, true);
  assert.match(state.deploy.lastCommit.reason, /not a git repository/);
  assert.equal(model.snapshot.deployVerified, true);
  assert.equal(model.snapshot.pct, 100);
});
