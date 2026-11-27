// Discovery phase: parallel read-only recon agents produce the evidence, one
// architect turns it into a blueprint, and the harness harvests a validated
// plan from it. Pure: no IO, no model, no OpenCode. Artifacts are markdown in
// `.mission/discovery/`, so a resumed mission never pays for the same recon.

export { parseProposals, harvestPlan, sanitizeId } from "./proposals.js";

export const RECON_AREAS = Object.freeze([
  {
    id: "architecture",
    role: "recon-architecture",
    focus: "module layout, entry points, data flow, public contracts and WHERE new code must fit",
    read: ["README.md", "ARCHITECTURE.md", "package.json", "src/"],
  },
  {
    id: "quality",
    role: "recon-quality",
    focus:
      "test runner, existing suites, how a change is proven, coverage gaps, flaky or vacuous tests",
    read: ["test/", "package.json", "Makefile", "pyproject.toml"],
  },
  {
    id: "toolchain",
    role: "recon-toolchain",
    focus:
      "manifests, build/lint/typecheck commands, dependency versions, installability and runtime version",
    read: ["package.json", "package-lock.json", "go.mod", "Cargo.toml", "pyproject.toml"],
  },
  {
    id: "risks",
    role: "recon-risks",
    focus: "known bugs, risks, security constraints, dead ends and migrations that break the goal",
    read: ["SECURITY.md", "TASK.md", "CHANGELOG.md", "src/"],
  },
]);

export function reconAreas(limit = 3) {
  const value = Number(limit);
  const count = Number.isFinite(value) ? Math.min(4, Math.max(1, Math.trunc(value))) : 3;
  return RECON_AREAS.slice(0, count);
}

export const RECON_BEGIN = "<!-- mission:recon -->";
export const RECON_END = "<!-- /mission:recon -->";
export function reconPrompt({ objective, workspace, area }) {
  return [
    `[MISSION RECON · ${area.id}]`,
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "READ-ONLY STAGE. Do not write, edit, install or delete anything.",
    `Your area: ${area.focus}`,
    `Start with: ${area.read.join(", ")}`,
    "",
    "Inspect the real files. Quote real paths, never invent one. Sections:",
    "FILES: path:line-range — what it does (one per line)",
    "CURRENT BEHAVIOR: what exists today, including commands that already run",
    "CONSTRAINTS: invariants, style, versions and contract rules that must not break",
    "PROPOSED CHECKS: one per line, pipe-separated:",
    "CHECK: id=<slug> | cmd=<safe shell command run from the workspace root> | expect=exit0|contains:text",
    "PROPOSED TASKS: one per line, pipe-separated:",
    "TASK: subject=<imperative, one file or one unit> | files=<a.js,b.js> | check=<check id>",
    "RISKS: what can silently break the objective",
    "",
    "Check rules: deterministic, safe (no sudo/rm -rf/network pipes), red before the work and green after it.",
    "Task rules: one subagent turn each, disjoint files, every task names a proposed check id.",
    `Finish with mission_report(role='${area.role}', text='<the whole report>').`,
  ].join("\n");
}

export function architectPrompt({ objective, workspace, memo }) {
  return [
    "[MISSION ARCHITECT]",
    `Objective: ${objective}`,
    `Workspace: ${workspace}`,
    "",
    "You are the single architect of this mission. Recon agents inspected the project;",
    "their reports are below and in your brief. Turn them into ONE implementation plan",
    "that a harness can verify without trusting anyone's opinion.",
    "",
    "RECON REPORTS",
    String(memo ?? "").slice(0, 12000) || "(no reports)",
    "",
    "OUTPUT, in this order:",
    "1. A markdown blueprint: milestones, file ownership per task, build order, risks,",
    "   and how each milestone is proven. Be concrete: real paths, real commands.",
    "2. Exactly one fenced ```json block with the machine plan:",
    '{"objective":"...","definition_of_done":["..."],"checks":[{"id":"slug","cmd":"shell","expect":"exit0|contains:text","timeout_ms":60000,"kind":"build|unit|integration|e2e|smoke"}],"tasks":[{"id":1,"subject":"imperative","files":["path"],"verify":"check-id","blocked_by":[],"milestone":"m1","stage":"foundation|build|integration|verify|polish"}],"requirements":[{"id":"req-1","text":"user-visible requirement","checks":["check-id"]}],"milestones":[{"id":"m1","title":"..."}],"settings":{}}',
    "",
    "PLAN RULES",
    "- 8..24 checks. At least one e2e or smoke check for an app, CLI, server or game.",
    "- 20..100 tasks (more for large objectives). One verifiable unit each, disjoint files.",
    "- Every task `verify` MUST name a check id. Every requirement MUST name check ids.",
    "- Checks must be red before the work exists: never `true`, `echo ok`, `ls` or `pwd`.",
    "- `blocked_by` uses task ids and must be acyclic. ids are sequential from 1.",
    "- A task that cannot be verified is not a task: drop it or propose the check first.",
    "",
    "No explanations outside the blueprint. The harness validates and may reject your JSON.",
    "Finish with mission_report(role='architect', text='<blueprint + json block>').",
  ].join("\n");
}

const BLOCK = /```(?:json)?\s*\n([\s\S]*?)```/gi;

/// Extract the machine plan from the architect's blueprint. Any JSON block that
/// looks like a plan is accepted; validation still happens in normalizePlan.
export function parseBlueprint(text) {
  const source = String(text ?? "");
  const blocks = [...source.matchAll(BLOCK)];
  for (const match of blocks) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    if (!Array.isArray(data.checks) || !Array.isArray(data.tasks)) continue;
    if (data.checks.length === 0 || data.tasks.length === 0) continue;
    return {
      plan: data,
      markdown:
        `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`.trim(),
      error: "",
    };
  }
  return {
    plan: null,
    markdown: source.trim(),
    error: "no plan json block found in the blueprint",
  };
}

export function reconMemo(reports, max = 9000) {
  const parts = (Array.isArray(reports) ? reports : [])
    .filter((report) => String(report?.text ?? "").trim())
    .map(
      (report) =>
        `### RECON · ${report.area}${report.cached ? " (cached)" : ""}\n${String(report.text).trim()}`
    );
  return parts.join("\n\n").slice(0, Math.max(0, Number(max) || 0));
}

/// The recon memo is injected into every later brief, so it must be replaced,
/// never appended twice. Markers keep it bounded across resumes and re-plans.
export function mergeReconMemo(memory, memo) {
  const base = String(memory ?? "");
  const start = base.indexOf(RECON_BEGIN);
  const end = base.indexOf(RECON_END);
  const withoutBlock =
    start >= 0 && end > start
      ? `${base.slice(0, start)}${base.slice(end + RECON_END.length)}`
      : base;
  const clean = withoutBlock.trim();
  const block = String(memo ?? "").trim()
    ? `${RECON_BEGIN}\n## WHAT THE PROJECT ACTUALLY LOOKS LIKE\n${String(memo).trim()}\n${RECON_END}`
    : "";
  return [clean, block].filter(Boolean).join("\n\n").slice(-6000);
}
