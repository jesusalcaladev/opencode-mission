import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { loadState, loadTasks, missionDir } from "../src/mission.js";

const CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0"); process.exit(0); }
console.log(String(Number(args[0]) + Number(args[1])));
`;

const CLI_TEST = `const test = require("node:test");
const assert = require("node:assert/strict");
test("version", () => assert.equal("1.0.0", "1.0.0"));
test("sum", () => assert.equal(2 + 3, 5));
test("five", () => assert.equal(String(5), "5"));
`;

test("smoke: the real demos/cli mission reaches complete with real checks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mission-smoke-"));
  const root = path.join(temp, "cli");
  // A nested `node --test` skips test files when NODE_TEST_CONTEXT is inherited.
  const savedContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await cp(path.resolve("demos/cli"), root, { recursive: true });
    const store = new Map();
    let wrote = false;
    const ctx = {
      storage: {
        get: async (k) => store.get(k),
        set: async (k, v) => store.set(k, v),
      },
      session: {
        context: async () => [{ info: { role: "assistant", cost: 0.01 } }],
        prompt: async ({ text }) => {
          if (text.startsWith("[MISSION SUPERVISOR") && !wrote) {
            await writeFile(path.join(root, "cli.js"), CLI, "utf8");
            await writeFile(path.join(root, "cli.test.js"), CLI_TEST, "utf8");
            wrote = true;
          }
        },
        synthetic: async () => {},
        create: async () => ({ id: "worker" }),
        wait: async () => {},
        switchModel: async () => {},
        get: async ({ sessionID }) => ({ id: sessionID, time: { created: 0, updated: 0 } }),
      },
      model: { default: async () => null, list: async () => [] },
      event: { subscribe: async function* () {} },
      location: { directory: temp },
    };
    const sup = new Supervisor(ctx, { enableWorkers: false, enableRoles: false });
    await sup.start("lead", root);
    for (let i = 0; i < 5; i += 1) {
      const state = await loadState(root);
      if (state.status !== "running") break;
      await sup.handleIdle("lead");
    }
    const final = await loadState(root);
    assert.equal(
      final.status,
      "complete",
      `finish=${final.finish_reason} turn=${final.turn} red=${final.last_checks
        .filter((check) => !check.ok)
        .map((check) => check.id)
        .join(",")} tasks=${JSON.stringify((await loadTasks(root)).map((t) => [t.id, t.status]))}`
    );
    assert.equal(final.last_checks.length, 4);
    assert.ok(final.last_checks.every((check) => check.ok));
    assert.deepEqual(final.check_baseline, {
      version: false,
      sum: false,
      "tests-present": false,
      tests: false,
    });
    assert.equal(wrote, true);
    const journal = await readFile(path.join(missionDir(root), "journal.md"), "utf8");
    assert.match(journal, /all criteria green/);
    sup.dispose();
  } finally {
    if (savedContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedContext;
    await rm(temp, { recursive: true, force: true });
  }
});
