import test from "node:test";
import assert from "node:assert/strict";
import {
  bar,
  budgetColor,
  checkGlyph,
  duration,
  money,
  palette,
  sparkline,
  statusColor,
  statusGlyph,
  truncate,
} from "../src/tui/format.js";

test("format: bar is bounded and uses filled/empty glyphs", () => {
  assert.equal(bar(0, 4), "░░░░");
  assert.equal(bar(50, 4), "██░░");
  assert.equal(bar(100, 4), "████");
  assert.equal(bar(150, 4), "████");
  assert.equal(bar(-10, 4), "░░░░");
});

test("format: sparkline maps values to blocks", () => {
  assert.equal(sparkline([0, 5, 10], 3), " ▄█");
  assert.equal(sparkline([], 4), "····");
  assert.equal(sparkline([3, 3, 3], 3).length, 3);
});

test("format: duration covers seconds, minutes, hours and days", () => {
  assert.equal(duration(500), "500ms");
  assert.equal(duration(42_000), "42s");
  assert.equal(duration(9 * 60_000 + 5000), "09:05");
  assert.equal(duration(3_723_000), "01:02:03");
  assert.equal(duration(26 * 3_600_000), "1d 02:00");
});

test("format: glyphs and money", () => {
  assert.equal(statusGlyph("running"), "◉");
  assert.equal(statusGlyph("paused"), "◐");
  assert.equal(statusGlyph("blocked"), "✕");
  assert.equal(checkGlyph(true), "✓");
  assert.equal(checkGlyph(false), "✕");
  assert.equal(money(1.5), "$1.50");
  assert.equal(money("x"), "$0.00");
});

test("format: truncate collapses whitespace", () => {
  assert.equal(truncate("a  b   c", 10), "a b c");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});

test("format: palette and status colors use theme tokens", () => {
  const theme = {
    text: {
      base: "b",
      muted: "m",
      faint: "f",
      feedback: {
        success: { base: "s" },
        warning: { base: "w" },
        error: { base: "e" },
        info: { base: "i" },
      },
    },
    hue: { accent: { 500: "a" }, interactive: { 500: "n" } },
    border: { base: "br" },
    background: { raised: { base: "r", high: "rh" } },
  };
  const p = palette(theme);
  assert.equal(p.accent, "a");
  assert.equal(p.success, "s");
  assert.equal(statusColor(p, "running"), "s");
  assert.equal(statusColor(p, "blocked"), "e");
  assert.equal(budgetColor(p, 9, 10), "w");
  assert.equal(budgetColor(p, 10, 10), "e");
});
