// Plan validation and monotonic re-plan rules.
import { SAFE_ID, DENY_CMD, VACUOUS_CMD } from "./prompt.js";
import { normalizeSettings } from "./settings.js";

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

export function normalizePlan(raw, objective, workspace) {
  const data = raw && typeof raw === "object" ? raw : parseJson(raw);
  const errors = [];
  if (!data || typeof data !== "object")
    return { ok: false, errors: ["model returned no JSON object"] };

  const checks = [];
  if (!Array.isArray(data.checks) || data.checks.length === 0 || data.checks.length > 24) {
    errors.push("checks must be an array of 1..24 items");
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

  const checkIds = new Set(checks.map((c) => c.id));
  const tasks = [];
  if (!Array.isArray(data.tasks) || data.tasks.length === 0 || data.tasks.length > 60) {
    errors.push("tasks must be an array of 1..60 items");
  } else {
    data.tasks.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const id = clamp(item.id, 1, 60, index + 1);
      const subject = typeof item.subject === "string" ? item.subject.trim().slice(0, 160) : "";
      if (subject.length < 3) {
        errors.push(`task ${id} has no usable subject`);
        return;
      }
      const verify =
        typeof item.verify === "string" && checkIds.has(item.verify) ? item.verify : "";
      if (!verify) errors.push(`task ${id} has no valid verify check`);
      const blocked_by = Array.isArray(item.blocked_by)
        ? item.blocked_by
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= data.tasks.length && n !== id)
            .slice(0, 6)
        : [];
      const milestone = typeof item.milestone === "string" ? item.milestone.slice(0, 40) : "";
      tasks.push({ id, subject, files: safeFiles(item.files), verify, blocked_by, milestone });
    });
  }

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

  const settings = normalizeSettings(data.settings);
  const campaign = settings.autonomy === "campaign";
  if (
    settings.require_e2e &&
    checks.length > 0 &&
    !checks.some((c) => c.kind === "e2e" || c.kind === "smoke")
  )
    errors.push("at least one e2e or smoke check is required in relentless mode");

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
        errors.push(`requirement ${id} has no valid check`);
        continue;
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

  if (
    campaign &&
    objective.length > 8 &&
    /\b(game|engine|app|application|platform|system|cli|server|api|tool|library|framework)\b/i.test(
      objective
    )
  ) {
    const kinds = new Set(checks.map((c) => c.kind));
    if (!kinds.has("e2e") && !kinds.has("smoke"))
      errors.push("campaign objectives require at least one e2e or smoke check");
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

export function validateMonotonic(nextPlan, previousChecks = [], previousTasks = []) {
  const errors = [];
  const nextById = new Map((nextPlan?.checks ?? []).map((c) => [c.id, c]));
  for (const old of previousChecks) {
    const next = nextById.get(old.id);
    if (!next) {
      errors.push(`re-plan dropped existing check ${old.id}`);
      continue;
    }
    if ((old.cmd && next.cmd !== old.cmd) || (old.expect && next.expect !== old.expect)) {
      errors.push(`re-plan weakened existing check ${old.id}`);
    }
  }
  const nextTasks = new Map((nextPlan?.tasks ?? []).map((t) => [t.id, t]));
  for (const old of previousTasks) {
    if (old.status !== "completed") continue;
    if (!nextTasks.has(old.id)) errors.push(`re-plan dropped completed task #${old.id}`);
  }
  return { ok: errors.length === 0, errors };
}
