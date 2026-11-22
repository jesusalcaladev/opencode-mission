import test from "node:test";
import assert from "node:assert/strict";
import { parseStartInput } from "../src/tui/input.js";

test("tui input: an inline objective is forwarded verbatim", () => {
  assert.equal(
    parseStartInput("build a tiny CLI with three tests"),
    "build a tiny CLI with three tests"
  );
});

test("tui input: the slash token is stripped when OpenCode keeps it", () => {
  assert.equal(parseStartInput("/mission-start build a CLI"), "build a CLI");
  assert.equal(parseStartInput("/missionstart build a CLI"), "build a CLI");
  assert.equal(parseStartInput("/mission-new build a CLI"), "build a CLI");
  assert.equal(parseStartInput("/MISSION-START build a CLI"), "build a CLI");
});

test("tui input: the server spelling is accepted too", () => {
  assert.equal(parseStartInput("mission start build a CLI"), "build a CLI");
});

test("tui input: empty input means 'open the dialog'", () => {
  assert.equal(parseStartInput(""), "");
  assert.equal(parseStartInput("   "), "");
  assert.equal(parseStartInput(undefined), "");
  assert.equal(parseStartInput("/mission-start"), "");
  assert.equal(parseStartInput(42), "");
});

test("tui input: whitespace around the objective is trimmed, inner text kept", () => {
  assert.equal(parseStartInput("  /mission-start   fix  the  bug  "), "fix  the  bug");
});
