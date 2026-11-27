import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { updateRegistry, directoryFor, cacheDir } from "../src/supervisor/registry.js";

async function withCache(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mission-registry-publish-"));
  const prevCache = process.env.OPENCODE_MISSION_CACHE_DIR;
  process.env.OPENCODE_MISSION_CACHE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevCache === undefined) delete process.env.OPENCODE_MISSION_CACHE_DIR;
    else process.env.OPENCODE_MISSION_CACHE_DIR = prevCache;
    await rm(dir, { recursive: true, force: true });
  }
}

test("updateRegistry: standalone write does not depend on `this`", async () => {
  await withCache(async (dir) => {
    assert.equal(cacheDir(), dir);
    // The old bug: a standalone updateRegistry read `this.boundDirectory`,
    // threw TypeError under strict-mode ESM, and swallowed it -> nothing written.
    await updateRegistry(
      "/work/ember-engine",
      {
        id: "mission-x",
        session_id: "ses_lead",
        status: "running",
        last_checks: [{ ok: true }, { ok: false }],
      },
      "objetivo",
      { directory: "/work/ember-engine" }
    );

    const pointer = JSON.parse(await readFile(path.join(dir, "current.json"), "utf8"));
    assert.equal(pointer.root, "/work/ember-engine");
    assert.equal(pointer.sessionID, "ses_lead");
    assert.equal(pointer.directory, "/work/ember-engine");
    assert.equal(pointer.status, "running");

    const list = JSON.parse(await readFile(path.join(dir, "missions.json"), "utf8"));
    assert.equal(list.length, 1);
    assert.equal(list[0].sessionID, "ses_lead");
    assert.equal(list[0].directory, "/work/ember-engine");
    assert.equal(list[0].objective, "objetivo");
    assert.equal(list[0].pct, 50);
    assert.equal(list[0].status, "running");
    assert.equal(typeof list[0].updated_at, "number");
  });
});

test("updateRegistry: writes are ordered (sessionID present) and never reject", async () => {
  await withCache(async (dir) => {
    // session_id already set before publishing (lifecycle ordering fix).
    await updateRegistry("/r", { session_id: "ses_after_set", status: "running" }, "", {
      directory: "/r",
    });
    const pointer = JSON.parse(await readFile(path.join(dir, "current.json"), "utf8"));
    assert.equal(pointer.sessionID, "ses_after_set");
    assert.notEqual(pointer.sessionID, "");

    // onError is invoked instead of rejecting on a broken cache dir.
    let reported = null;
    await updateRegistry("/r", { session_id: "s", status: "running" }, "", {
      directory: null,
      onError: (e) => (reported = e),
    });
    assert.equal(reported, null);
  });
});

test("directoryFor: bound session wins, then fallback, then root", () => {
  const bound = new Map([["s", "/bound"]]);
  assert.equal(
    directoryFor("s", { boundDirectory: bound, fallback: "/here", root: "/root" }),
    "/bound"
  );
  assert.equal(
    directoryFor("x", { boundDirectory: bound, fallback: "/here", root: "/root" }),
    "/here"
  );
  assert.equal(directoryFor("x", { boundDirectory: bound, root: "/root" }), "/root");
  assert.equal(directoryFor("x", {}), null);
});
