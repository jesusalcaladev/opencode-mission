import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRoadmap,
  nextItem,
  markItemDone,
  chainDecision,
  applyExtension,
  DEFAULT_MAX_EXTENSIONS,
} from "../src/mission/chain.js";

const roadmap = [
  "# Roadmap",
  "",
  "- [x] id: setup: prepare the workspace",
  "- [ ] id: cli: build the CLI",
  "- [ ] id: docs: write the README",
].join("\n");

test("chain: roadmap parsing keeps ids, titles and done state", () => {
  const items = parseRoadmap(roadmap);
  assert.equal(items.length, 3);
  assert.equal(items[0].done, true);
  assert.equal(items[1].id, "cli");
  assert.equal(items[1].title, "build the CLI");
  assert.equal(nextItem(items).id, "cli");
});

test("chain: markItemDone only ticks the requested item", () => {
  const updated = markItemDone(roadmap, "cli");
  assert.match(updated, /- \[x\] id: cli/);
  assert.match(updated, /- \[ \] id: docs/);
  assert.equal(nextItem(parseRoadmap(updated)).id, "docs");
});

test("chain: EXTEND only applies to budget stops and respects the ceiling", () => {
  assert.equal(
    chainDecision({
      decision: { type: "stop", reason: "max-turns" },
      extendRequested: true,
      extensions: 0,
    }).type,
    "extend"
  );
  assert.equal(
    chainDecision({
      decision: { type: "stop", reason: "blocked" },
      extendRequested: true,
      extensions: 0,
    }).type,
    "stop"
  );
  assert.equal(
    chainDecision({
      decision: { type: "stop", reason: "budget" },
      extendRequested: true,
      extensions: DEFAULT_MAX_EXTENSIONS,
    }).type,
    "stop"
  );
  assert.equal(
    chainDecision({ decision: { type: "continue" }, extendRequested: true }).type,
    "work"
  );
});

test("chain: an extension grows the active budgets", () => {
  const before = { extensions: 0, max_turns: 16, max_wallclock_min: 30, max_writes: 100 };
  const after = applyExtension(before);
  assert.equal(after.extensions, 1);
  assert.ok(after.max_turns > before.max_turns);
  assert.ok(after.max_wallclock_min > before.max_wallclock_min);
  assert.ok(after.max_writes > before.max_writes);
  assert.equal(before.extensions, 0);
});
