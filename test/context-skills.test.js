import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildContextPack,
  clip,
  taskAttemptLine,
  relevantChecks,
  relevantRequirements,
  WORKER_LIMITS,
} from "../src/mission/context-pack.js";
import { workerBrief, roleBrief, workerPrompt } from "../src/team.js";
import { skillDefinitions, registerSkills, SKILLS_DIR } from "../src/skills.js";
import { Supervisor } from "../src/supervisor.js";

test("context pack is bounded and task-relevant", () => {
  assert.equal(clip("abcdef", 3), "ab…");
  const pack = buildContextPack({
    state: { strategy_tier: 3 },
    memory: "discarded approach A".repeat(200),
    facts: [{ subject: "stack", text: "use ECS" }],
    instructions: "be concise",
    journal: "old line\nnew line",
    results: [
      { id: "own", ok: false, summary: "red" },
      { id: "other", ok: true, summary: "green" },
    ],
    requirements: [
      { id: "r1", text: "CLI prints version", checks: ["own"] },
      { id: "r2", text: "unrelated", checks: ["other"] },
    ],
    task: { id: 1, verify: "own", subject: "Fix CLI" },
    limits: WORKER_LIMITS,
    role: "implementer",
  });
  assert.ok(pack.includes("MISSION CONTEXT (implementer"));
  assert.ok(pack.includes("use ECS"));
  assert.ok(pack.includes("CLI prints version"));
  assert.ok(!pack.includes("unrelated"));
  assert.ok(pack.includes("STRATEGY"));
  assert.ok(pack.length <= WORKER_LIMITS.total + 120);
  assert.equal(
    relevantChecks(
      [
        { id: "own", ok: false },
        { id: "other", ok: true },
      ],
      { verify: "own" }
    ).length,
    1
  );
  assert.equal(
    relevantRequirements(
      [
        { id: "r1", checks: ["own"] },
        { id: "r2", checks: ["x"] },
      ],
      {
        verify: "own",
      }
    ).length,
    1
  );
});

test("worker briefs carry retry history and role briefs carry role context", () => {
  const task = { id: 2, subject: "Retry work", verify: "ok", files: ["a.js"] };
  const context = {
    state: {},
    facts: [{ subject: "decision", text: "use snapshots" }],
    results: [{ id: "ok", ok: false, summary: "exit 1" }],
    requirements: [],
    progress: [{ id: 2, attempts: 2, last_error: "test failed", status: "pending" }],
    memory: "previous approach failed",
  };
  const brief = workerBrief({ task, objective: "o", workspace: "/w", context });
  assert.match(brief, /attempt 3/);
  assert.match(brief, /test failed/);
  assert.match(brief, /use snapshots/);
  assert.match(brief, /Verify: ok/);
  const prompt = workerPrompt({
    task,
    objective: "o",
    workspace: "/w",
    progress: context.progress,
  });
  assert.match(prompt, /RETRY CONTEXT: Task #2 attempt 3/);
  const role = roleBrief({
    role: "reviewer",
    objective: "o",
    workspace: "/w",
    prompt: "read only",
    context,
  });
  assert.match(role, /MISSION REVIEWER BRIEF/);
  assert.match(role, /use snapshots/);
  assert.match(role, /mission_report/);
  assert.match(taskAttemptLine(context.progress, task), /do NOT repeat/);
});

test("skills are registered with absolute paths and are opt-out-able", async () => {
  const defs = await skillDefinitions();
  assert.equal(defs.length, 4);
  for (const skill of defs) {
    assert.ok(path.isAbsolute(skill.path));
    assert.ok(skill.content.length > 50);
    assert.equal(skill.autoinvoke, false);
  }
  assert.equal(SKILLS_DIR, path.dirname(defs[0].path));

  const added = [];
  const ctx = {
    skill: {
      transform: async (fn) => {
        const editor = { get: () => undefined, add: (s) => added.push(s) };
        await fn(editor);
        return { dispose() {} };
      },
    },
  };
  const registration = await registerSkills(ctx);
  assert.ok(registration);
  assert.equal(added.length, 4);
  assert.equal(await registerSkills(ctx, { enabled: false }), null);
  assert.equal(await registerSkills({}), null);
});

test("stage reports get actionable schema feedback", () => {
  const sup = new Supervisor({});
  assert.match(sup.validateStageReport("reviewer", "looks fine"), /SEVERITY/);
  assert.equal(sup.validateStageReport("reviewer", "SEVERITY: high — bug in a.js"), "");
  assert.match(sup.validateStageReport("auditor", "some notes"), /FINDING/);
  assert.equal(sup.validateStageReport("auditor", "NO FINDINGS"), "");
  assert.match(sup.validateStageReport("goal-auditor", "maybe missing"), /GAP/);
  assert.equal(sup.validateStageReport("goal-auditor", "NO GAPS"), "");
  assert.equal(sup.validateStageReport("investigator", "file map"), "");
});
