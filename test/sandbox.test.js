import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { runChecks } from "../src/checks.js";
import { sandboxMode, sanitizeEnv, isSandboxedPath } from "../src/mission/sandbox.js";

test("sandboxMode honours per-check overrides and defaults to none", () => {
  assert.equal(sandboxMode({}), "none");
  assert.equal(sandboxMode({ sandbox: "copy" }), "copy");
  assert.equal(sandboxMode({ sandbox: "copy" }, { sandbox: "none" }), "none");
  assert.equal(sandboxMode({}, { sandbox: "copy" }), "copy");
});

test("sanitizeEnv drops credentials and keeps only an allowlist", () => {
  const env = sanitizeEnv(
    { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", OPENAI_API_KEY: "y", LANG: "C.UTF-8" },
    "/tmp/sandbox-home"
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/tmp/sandbox-home");
  assert.equal(env.MISSION_SANDBOX, "1");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("isSandboxedPath excludes control and dependency directories", () => {
  assert.equal(isSandboxedPath("a/b.js"), false);
  assert.equal(isSandboxedPath(".mission/state.json"), true);
  assert.equal(isSandboxedPath("src/node_modules/x.js"), true);
});

test("copy sandbox prevents a criterion from mutating the real workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-sandbox-"));
  try {
    await mkdir(path.join(root, ".mission"), { recursive: true });
    const criteria = {
      checks: [
        {
          id: "mut",
          cmd: "echo mutated > marker.txt && echo ok",
          expect: "contains:ok",
          timeout_ms: 5000,
        },
      ],
    };
    const results = await runChecks(root, criteria, { sandbox: "copy", cache: null });
    assert.equal(results[0].ok, true);
    await assert.rejects(() => readFile(path.join(root, "marker.txt"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
