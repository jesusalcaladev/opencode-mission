import test from "node:test";
import assert from "node:assert/strict";
import { reportsText, wavesFor, workerBrief, workerPrompt } from "../src/team.js";

test("wavesFor parallelizes disjoint tasks up to maxWorkers", () => {
  const tasks = [
    { id: 1, subject: "a", files: ["a.js"] },
    { id: 2, subject: "b", files: ["b.js"] },
    { id: 3, subject: "c", files: ["c.js"] },
  ];
  const waves = wavesFor(tasks, 2);
  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [[1, 2], [3]]);
});

test("wavesFor respects dependencies and file conflicts", () => {
  const tasks = [
    { id: 1, subject: "a", files: ["a.js"], blocked_by: [] },
    { id: 2, subject: "b", files: ["a.js"], blocked_by: [] },
    { id: 3, subject: "c", files: ["c.js"], blocked_by: [1] },
  ];
  const waves = wavesFor(tasks, 3);
  assert.deepEqual(waves.map((w) => w.map((t) => t.id)), [[1], [2, 3]]);
});

test("wavesFor tolerates tasks without a files field", () => {
  const waves = wavesFor([{ id: 1, subject: "a" }], 3);
  assert.equal(waves.length, 1);
  assert.equal(waves[0][0].id, 1);
});

test("worker prompts scope the task and route completion through mission_task_done", () => {
  const task = { id: 4, subject: "Write the parser", files: ["parser.js"] };
  const prompt = workerPrompt({ task, objective: "Build a tool", workspace: "/tmp/ws" });
  assert.match(prompt, /task #4/);
  assert.match(prompt, /parser\.js/);
  assert.match(prompt, /mission_task_done\(id=4/);
  const brief = workerBrief({ task, objective: "Build a tool", workspace: "/tmp/ws" });
  assert.match(brief, /#4 Write the parser/);
});

test("reportsText summarizes worker reports", () => {
  const text = reportsText({ 1: { summary: "wrote cli.js" }, 2: { summary: "wrote tests" } });
  assert.match(text, /task #1: wrote cli\.js/);
  assert.match(text, /task #2: wrote tests/);
});
