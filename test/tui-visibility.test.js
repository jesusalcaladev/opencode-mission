import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cacheDir, loadTuiModel } from "../src/tui/model.js";
import { ensureMission, missionDir } from "../src/mission.js";

async function fixture(base) {
  const root = path.join(base, "missions", "active");
  await ensureMission(root, { objective: "Visible mission" });
  await writeFile(
    path.join(missionDir(root), "state.json"),
    JSON.stringify({
      status: "running",
      session_id: "lead-after-handoff",
      turn: 3,
      max_turns: 12,
      last_checks: [{ id: "ok", ok: true }],
    }),
    "utf8"
  );
  return root;
}

test("cacheDir honours the eval/test isolation override", () => {
  const previous = process.env.OPENCODE_MISSION_CACHE_DIR;
  process.env.OPENCODE_MISSION_CACHE_DIR = "/tmp/mission-cache-test";
  assert.equal(cacheDir(), "/tmp/mission-cache-test");
  if (previous === undefined) delete process.env.OPENCODE_MISSION_CACHE_DIR;
  else process.env.OPENCODE_MISSION_CACHE_DIR = previous;
});

test("TUI still finds a running mission when the session id changed", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-ui-"));
  const previous = process.env.OPENCODE_MISSION_CACHE_DIR;
  try {
    const cache = path.join(base, "cache");
    await mkdir(cache, { recursive: true });
    process.env.OPENCODE_MISSION_CACHE_DIR = cache;
    const root = await fixture(base);
    await writeFile(
      path.join(cache, "current.json"),
      `${JSON.stringify({ root, sessionID: "old-lead", status: "running" })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(cache, "missions.json"),
      `${JSON.stringify([{ root, sessionID: "old-lead", status: "running", updated_at: Date.now() }])}\n`,
      "utf8"
    );
    const model = await loadTuiModel({
      missionsRoot: path.join(base, "missions"),
      sessionID: "unrelated-terminal",
    });
    // A foreign session intentionally gets no scoped snapshot, but the active
    // mission must still be in the list so the sidebar can show its fallback.
    assert.equal(model.snapshot, null);
    assert.ok(model.missions.some((m) => m.root === root));
    const global = await loadTuiModel({ missionsRoot: path.join(base, "missions") });
    assert.ok(global.snapshot, "pointer fallback must expose the mission globally");
    assert.equal(global.snapshot.objective, "Visible mission");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_MISSION_CACHE_DIR;
    else process.env.OPENCODE_MISSION_CACHE_DIR = previous;
    await rm(base, { recursive: true, force: true });
  }
});
