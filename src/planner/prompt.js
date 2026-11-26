// Turns a natural-language objective into an executable mission plan.
// The model proposes; this module validates. A malformed or unavailable model
// degrades to a minimal but honest plan instead of blocking the user.

export const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const DENY_CMD =
  /\b(rm\s+-rf?\s+(\/|~|\$HOME)|sudo\b|mkfs\b|dd\s+if=|chmod\s+-R\s+777|curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh)\b/i;
export const VACUOUS_CMD =
  /^(true|false|:|exit\s+0|echo\s+(ok|yes|true|done)|printf\s+(ok|yes|true|done)\s*)$/i;

export function safeCheckCmd(cmd) {
  const value = String(cmd ?? "").trim();
  if (!value || value.length > 500) return false;
  if (DENY_CMD.test(value) || VACUOUS_CMD.test(value)) return false;
  return true;
}

export function planPrompt(objective, workspace) {
  return [
    "You are the planner of an autonomous coding harness. Convert the objective below into an EXECUTABLE mission plan.",
    "Output ONLY one JSON object. No markdown, no explanation, no code fences.",
    "",
    "SHAPE",
    "{",
    '  "objective": "one precise sentence restating the goal",',
    '  "definition_of_done": ["observable property 1", "observable property 2"],',
    '  "needs_research": false,',
    '  "checks": [{"id":"short_id","cmd":"shell command","expect":"exit0 | contains:text","timeout_ms":30000,"kind":"build|unit|integration|e2e|smoke"}],',
    '  "tasks": [{"id":1,"subject":"short imperative","files":["relative/path.js"],"verify":"check_id","blocked_by":[],"milestone":"optional-id"}],',
    '  "requirements": [{"id":"req-id","text":"user-visible requirement","checks":["check_id"]}],',
    '  "milestones": [{"id":"m1","title":"Foundation"},{"id":"m2","title":"Gameplay"}],',
    '  "settings": {"autonomy":"standard|campaign|relentless","never_give_up":false,"max_turns":40,"budget_usd":5,"hard_budget_usd":25,"max_tokens":0,"max_wallclock_min":480,"auto_extend":true,"max_extensions":50,"goal_audit":true,"max_writes":500,"lease_ms":600000,"handoff_every_turns":8,"max_failures":5,"max_task_attempts":3,"max_review_attempts":2,"strict_checks":false,"sandbox":"none","global_memory":false,"isolation":"none"}',
    "}",
    "",
    "HARD RULES",
    "- 1..24 checks. Each `cmd` must be deterministic, run from the workspace root, and be safe (no sudo/rm -rf/network pipes).",
    "- Prefer real verifications: test runners, compilers, headless runs, grep for required strings, tiny node/python probes. Never use `true` as the only check.",
    "- Include check kinds: build/unit/integration and at least one e2e or smoke for an app, CLI, server or game engine.",
    "- Every requirement MUST name at least one check id. Completion is impossible while a requirement is uncovered.",
    "- 1..60 tasks. ids are sequential starting at 1. `verify` MUST name a check id. `blocked_by` uses task ids.",
    "- `files` lists the paths the task will touch. Tasks that can run in parallel MUST have DISJOINT file lists; use dependencies for the rest.",
    "- For large objectives (game engine, app, platform) use autonomy=campaign: many small verified tasks, not a few giant ones.",
    "- For 'never stop' objectives use autonomy=relentless (or never_give_up=true): the harness re-plans on blocked/review/gaps, retries failed tasks forever, and only hard budget, wall-clock, STOP/PAUSE or test-erosion can end the run.",
    "- Put the final end-to-end test check last and make the last task verify it.",
    "- No destructive commands. No changes outside the workspace.",
    "",
    `WORKSPACE: ${workspace}`,
    `OBJECTIVE: ${objective}`,
  ].join("\n");
}
