import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { discoverRoots, isMissionRoot } from "../src/tui/registry.js";

async function authored(root) {
  const dir = path.join(root, ".mission");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "state.json"), "{}");
  await writeFile(path.join(dir, "criteria.json"), "{}");
  await writeFile(path.join(dir, "tasks.json"), "{}");
  await writeFile(path.join(dir, "mission.md"), "---\n---\nDo the thing\n");
}

test("tui registry: isMissionRoot rejects missing and half-authored workspaces", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-registry-"));
  const good = path.join(base, "good");
  const half = path.join(base, "half");
  const empty = path.join(base, "empty");
  try {
    await authored(good);
    await mkdir(path.join(half, ".mission"), { recursive: true });
    await writeFile(path.join(half, ".mission", "state.json"), "{}");
    await mkdir(empty, { recursive: true });
    assert.equal(await isMissionRoot(good), true);
    assert.equal(await isMissionRoot(half), false);
    assert.equal(await isMissionRoot(empty), false);
    assert.equal(await isMissionRoot(path.join(base, "deleted")), false);
    assert.equal(await isMissionRoot(""), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("tui registry: discoverRoots drops stale pointer and registry entries", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-registry-"));
  const fakeHome = await mkdtemp(path.join(os.tmpdir(), "mission-registry-home-"));
  const oldHome = process.env.HOME;
  const good = path.join(base, "real-mission");
  const deleted = path.join(base, "deleted-mission");
  const half = path.join(base, "half-mission");
  try {
    await authored(good);
    await mkdir(path.join(half, ".mission"), { recursive: true });
    await writeFile(path.join(half, ".mission", "state.json"), "{}");

    process.env.HOME = fakeHome;
    const cache = path.join(fakeHome, ".cache", "opencode-mission");
    await mkdir(cache, { recursive: true });
    // The pointer and registry are stale by design: they keep the last path
    // after the workspace is deleted. The TUI must not render those folders.
    await writeFile(path.join(cache, "current.json"), JSON.stringify({ root: deleted }));
    await writeFile(
      path.join(cache, "missions.json"),
      JSON.stringify([{ root: deleted }, { root: half }])
    );

    const roots = await discoverRoots(base, 12);
    assert.deepEqual(roots, [good]);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(base, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});
