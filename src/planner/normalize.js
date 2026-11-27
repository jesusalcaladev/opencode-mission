// Plan validation and monotonic re-plan rules.
import { SAFE_ID, DENY_CMD, VACUOUS_CMD } from "./prompt.js";
import { normalizeSettings } from "./settings.js";
import { expandTaskList } from "./tasks.js";
import { missionSizing } from "../mission/sizing.js";
import { ensureDeployCheck, repairChecks, repairTasks } from "./repair.js";
import { validateMonotonic } from "./monotonic.js";
export { validateMonotonic };

function parseJson(text) {
  const raw = String(text ?? "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

function safeFiles(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const p = item.trim().replace(/^\.\//, "");
    if (!p || p.length > 160 || p.startsWith("/") || p.split("/").includes("..")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 20);
}

export function normalizePlan(raw, objective, workspace, opts = {}) {
  const data = raw && typeof raw === "object" ? raw : parseJson(raw);
  const errors = [];
  if (!data || typeof data !== "object")
    return { ok: false, errors: ["model returned no JSON object"] };
  const settings = normalizeSettings(data.settings);
  const proposals = opts.proposals ?? {};
  const sizing =
    opts.sizing ??
    missionSizing({
      objective,
      options: opts.options ?? {},
      proposals: { checks: proposals.checks, tasks: proposals.tasks },
    });

  let checks = [];
  if (!Array.isArray(data.checks) || data.checks.length === 0 || data.checks.length > 30) {
    errors.push("checks must be an array of 1..30 items");
  } else {
    for (const c of data.checks) {
      if (!c || typeof c !== "object") continue;
      const id = typeof c.id === "string" ? c.id.trim() : "";
      const cmd = typeof c.cmd === "string" ? c.cmd.trim() : "";
      if (!SAFE_ID.test(id)) {
        errors.push(`bad check id: ${id || "(empty)"}`);
        continue;
      }
      if (!cmd || cmd.length > 500 || DENY_CMD.test(cmd) || VACUOUS_CMD.test(cmd.trim())) {
        errors.push(`unsafe, empty or vacuous command for check ${id}`);
        continue;
      }
      const expect =
        typeof c.expect === "string" && c.expect.startsWith("contains:") && c.expect.length > 9
          ? c.expect
          : "exit0";
      const kind = ["build", "unit", "integration", "e2e", "smoke"].includes(c.kind)
        ? c.kind
        : "unit";
      const retries = clamp(c.retries, 0, 2, 0);
      checks.push({
        id,
        cmd,
        expect,
        timeout_ms: clamp(c.timeout_ms, 1000, 600000, 30000),
        kind,
        retries,
      });
    }
  }

  if (settings.require_e2e || sizing.big) checks = ensureDeployCheck(checks, proposals);
  if (sizing.big) checks = repairChecks(checks, { proposals, minChecks: sizing.minChecks });
  checks = checks.slice(0, 30);
  const checkIds = new Set(checks.map((c) => c.id));

  let tasks = [];
  if (!Array.isArray(data.tasks) || data.tasks.length === 0 || data.tasks.length > 120) {
    errors.push("tasks must be an array of 1..120 items");
  } else {
    data.tasks.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const id = clamp(item.id, 1, 120, index + 1);
      const subject = typeof item.subject === "string" ? item.subject.trim().slice(0, 160) : "";
      if (subject.length < 3) {
        errors.push(`task ${id} has no usable subject`);
        return;
      }
      const verify =
        typeof item.verify === "string" && checkIds.has(item.verify) ? item.verify : "";
      if (!verify) {
        if (sizing.big) return; // drop one bad task, repair the plan instead of rejecting it
        errors.push(`task ${id} has no valid verify check`);
      }
      const blocked_by = Array.isArray(item.blocked_by)
        ? item.blocked_by
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= data.tasks.length && n !== id)
            .slice(0, 6)
        : [];
      const milestone = typeof item.milestone === "string" ? item.milestone.slice(0, 40) : "";
      tasks.push({
        id,
        subject,
        files: safeFiles(item.files),
        verify,
        blocked_by,
        milestone,
        stage: typeof item.stage === "string" ? item.stage.slice(0, 40) : milestone,
      });
    });
  }
  if (sizing.big)
    tasks = repairTasks(tasks, {
      proposals: { ...proposals, planCheckIds: [...checkIds] },
      minTasks: sizing.minTasks,
      objective,
    });
  tasks = expandTaskList(tasks, {
    target: sizing.big ? sizing.targetTasks : settings.autonomy === "standard" ? 4 : 12,
    enabled: settings.expand_tasks === true || sizing.big,
    expandSingle: sizing.big,
  }).slice(0, 120);

  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    seen.add(t.id);
  }
  for (let i = 1; i <= tasks.length; i += 1) {
    if (!seen.has(i)) errors.push(`missing task id ${i}`);
  }
  // Reject cycles by checking that a topological order exists.
  const remaining = [...tasks];
  const settled = new Set();
  while (remaining.length) {
    const ready = remaining.find((t) =>
      t.blocked_by.every((id) => settled.has(id) || !seen.has(id))
    );
    if (!ready) {
      errors.push("task dependencies contain a cycle");
      break;
    }
    settled.add(ready.id);
    remaining.splice(remaining.indexOf(ready), 1);
  }

  // E2E/smoke is repaired deterministically above; never reject an otherwise
  // good plan for a missing label (that rejection drove the tiny fallback).

  const requirements = [];
  if (Array.isArray(data.requirements)) {
    for (const r of data.requirements.slice(0, 24)) {
      const id =
        typeof r?.id === "string" && r.id.trim()
          ? r.id.trim().slice(0, 40)
          : `req-${requirements.length + 1}`;
      const text = typeof r?.text === "string" ? r.text.trim().slice(0, 200) : "";
      const refs = Array.isArray(r?.checks)
        ? r.checks.map(String).filter((c) => checkIds.has(c))
        : [];
      if (refs.length === 0) {
        if (sizing.big && checks.length) refs.push(checks[0].id);
        else {
          errors.push(`requirement ${id} has no valid check`);
          continue;
        }
      }
      if (requirements.some((x) => x.id === id)) errors.push(`duplicate requirement id ${id}`);
      requirements.push({ id, text: text || id, checks: [...new Set(refs)] });
    }
  }

  const milestones = Array.isArray(data.milestones)
    ? data.milestones.slice(0, 16).map((m, i) => ({
        id: typeof m?.id === "string" && m.id.trim() ? m.id.trim().slice(0, 40) : `m${i + 1}`,
        title: typeof m?.title === "string" ? m.title.trim().slice(0, 160) : `Milestone ${i + 1}`,
      }))
    : [];

  const definitionOfDone = Array.isArray(data.definition_of_done)
    ? data.definition_of_done
        .slice(0, 24)
        .map((d) => String(d).trim().slice(0, 200))
        .filter(Boolean)
    : [];

  if (sizing.big) {
    const covered = new Set(requirements.flatMap((r) => r.checks));
    for (const check of checks) {
      if (covered.has(check.id)) continue;
      requirements.push({
        id: `req-${check.id}`.slice(0, 40),
        text: `Verify ${check.id} — ${check.cmd.slice(0, 120)}`,
        checks: [check.id],
      });
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      objective:
        typeof data.objective === "string" && data.objective.trim()
          ? data.objective.trim().slice(0, 280)
          : objective.slice(0, 280),
      workspace,
      definition_of_done: definitionOfDone,
      needs_research: data.needs_research === true,
      checks,
      tasks,
      requirements,
      milestones,
      settings,
    },
    errors: [],
  };
}

// validateMonotonic is re-exported from ./monotonic.js (size cap).
