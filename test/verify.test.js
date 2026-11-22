import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { runCommand } from "../src/checks.js";
import { checkTestIntegrity, createWorktree, gitCommit, hashTests, isGitRepo } from "../src/verify.js";

test("hashTests and checkTestIntegrity: additions are fine, edits and deletions are not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-verify-"));
  try {
    await writeFile(path.join(root, "a.test.js"), "test('a', () => {});\n");
    const baseline = await hashTests(root);
    assert.deepEqual(Object.keys(baseline), ["a.test.js"]);

    assert.equal((await checkTestIntegrity(root, baseline)).ok, true);
    await writeFile(path.join(root, "b.test.js"), "test('b', () => {});\n");
    assert.equal((await checkTestIntegrity(root, baseline)).ok, true);

    await writeFile(path.join(root, "a.test.js"), "test('a', () => {}); // changed\n");
    let verdict = await checkTestIntegrity(root, baseline);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /modified a\.test\.js/);

    await rm(path.join(root, "a.test.js"));
    verdict = await checkTestIntegrity(root, baseline);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /deleted a\.test\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gitCommit commits a verified unit and is a no-op when nothing changed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-git-"));
  try {
    assert.equal(await isGitRepo(root), false);
    assert.equal((await gitCommit(root, "no repo", ["a.js"])).ok, false);

    await runCommand("git init -q", root, 10000);
    assert.equal(await isGitRepo(root), true);
    await writeFile(path.join(root, "cli.js"), "console.log('1.0.0')\n");
    assert.equal((await gitCommit(root, "unscoped", [])).ok, false);
    const first = await gitCommit(root, "mission(test): turn 1", ["cli.js"]);
    assert.equal(first.ok, true);
    assert.ok(first.sha, "first commit should have a sha");
    const second = await gitCommit(root, "mission(test): turn 2", ["cli.js"]);
    assert.equal(second.ok, true);
    assert.equal(second.sha, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree isolates the mission workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-wt-"));
  try {
    await runCommand("git init -q", root, 10000);
    await writeFile(path.join(root, "seed.txt"), "seed\n");
    await gitCommit(root, "seed", ["seed.txt"]);
    const wt = await createWorktree(root, "demo");
    assert.equal(wt.ok, true, wt.reason);
    assert.equal((await stat(wt.root)).isDirectory(), true);
    assert.equal(wt.branch, "mission/demo");
    const weird = await createWorktree(root, "bad id/!!");
    assert.equal(weird.ok, true, weird.reason);
    assert.equal(weird.branch, "mission/bad-id");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
