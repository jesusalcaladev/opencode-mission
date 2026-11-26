import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSources, MAX_SOURCE_LINES } from "../scripts/check-architecture.mjs";

test("analyzeSources accepts a clean codebase", () => {
  const violations = analyzeSources([
    { path: "/repo/src/mission/cost.js", content: "export const x = 1;\n" },
    { path: "/repo/src/supervisor/cost.js", content: "export const cost = {};\n" },
    {
      path: "/repo/src/supervisor/tools.js",
      content: 'if (rel.startsWith(".mission/")) return;\n',
    },
  ]);
  assert.deepEqual(violations, []);
});

test("analyzeSources reports size, test globals, barrel imports and terminal writes", () => {
  const long = `${"x\n".repeat(MAX_SOURCE_LINES + 1)}`;
  const violations = analyzeSources([
    { path: "/repo/src/big.js", content: long },
    { path: "/repo/src/mission/bad.test.js", content: 'import test from "node:test";\n' },
    {
      path: "/repo/src/supervisor/bad.js",
      content: 'import { STATUS } from "./deps.js";\nstatus = "complete";\n',
    },
    { path: "/repo/src/supervisor/tools.js", content: "writeTextAtomic(target, content);\n" },
  ]);
  assert.ok(violations.some((v) => v.includes("lines (max")));
  assert.ok(violations.some((v) => v.includes("test globals")));
  assert.ok(violations.some((v) => v.includes("this.d")));
  assert.ok(violations.some((v) => v.includes("terminal status")));
  assert.ok(violations.some((v) => v.includes("mission_write")));
});
