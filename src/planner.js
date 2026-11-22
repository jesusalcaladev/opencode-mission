// Turns a natural-language objective into an executable mission plan.
// The model proposes; this module validates. A malformed or unavailable model
// degrades to a minimal but honest plan instead of blocking the user.

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DENY_CMD = /\b(rm\s+-rf?\s+(\/|~|\$HOME)|sudo\b|mkfs\b|dd\s+if=|chmod\s+-R\s+777|curl[^\n|]*\|\s*(ba)?sh|wget[^\n|]*\|\s*(ba)?sh)\b/i;

export function planPrompt(objective, workspace) {
  return [
    "You are the planner of an autonomous coding harness. Convert the objective below into an EXECUTABLE mission plan.",
    "Output ONLY one JSON object. No markdown, no explanation, no code fences.",
    "",
    "SHAPE",
    '{',
    '  "objective": "one precise sentence restating the goal",',
    '  "checks": [{"id":"short_id","cmd":"shell command","expect":"exit0 | contains:text","timeout_ms":30000}],',
    '  "tasks": [{"id":1,"subject":"short imperative","files":["relative/path.js"],"verify":"check_id","blocked_by":[]}],',
    '  "settings": {"max_turns":16,"budget_usd":5,"handoff_every_turns":4,"max_failures":3,"isolation":"none"}',
    '}',
    "",
    "HARD RULES",
    "- 1..10 checks. Each `cmd` must finish in under 30s, be deterministic, run from the workspace root, and be safe (no sudo/rm -rf/network pipes).",
    "- Prefer real verifications: test runners, compilers, grep for required strings, tiny node/python probes. Never use `true` as the only check.",
    "- 1..12 tasks. ids are sequential starting at 1. `verify` MUST name a check id (that check proves the task). `blocked_by` uses task ids.",
    "- `files` lists the paths the task will touch. Tasks that can run in parallel MUST have DISJOINT file lists; use dependencies for the rest.",
    "- Put the final end-to-end test check last and make the last task verify it.",
    "- No destructive commands. No changes outside the workspace.",
    "",
    `WORKSPACE: ${workspace}`,
    `OBJECTIVE: ${objective}`,
  ].join("\n");
}

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
  if (!data || typeof data !== "object") return { ok: false, errors: ["model returned no JSON object"] };

  const checks = [];
  if (!Array.isArray(data.checks) || data.checks.length === 0 || data.checks.length > 10) {
    errors.push("checks must be an array of 1..10 items");
  } else {
    for (const c of data.checks) {
      if (!c || typeof c !== "object") continue;
      const id = typeof c.id === "string" ? c.id.trim() : "";
      const cmd = typeof c.cmd === "string" ? c.cmd.trim() : "";
      if (!SAFE_ID.test(id)) {
        errors.push(`bad check id: ${id || "(empty)"}`);
        continue;
      }
      if (!cmd || cmd.length > 500 || DENY_CMD.test(cmd)) {
        errors.push(`unsafe or empty command for check ${id}`);
        continue;
      }
      const expect = typeof c.expect === "string" && c.expect.startsWith("contains:") && c.expect.length > 9
        ? c.expect
        : "exit0";
      checks.push({ id, cmd, expect, timeout_ms: clamp(c.timeout_ms, 1000, 60000, 30000) });
    }
  }

  const checkIds = new Set(checks.map((c) => c.id));
  const tasks = [];
  if (!Array.isArray(data.tasks) || data.tasks.length === 0 || data.tasks.length > 12) {
    errors.push("tasks must be an array of 1..12 items");
  } else {
    data.tasks.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const id = clamp(item.id, 1, 12, index + 1);
      const subject = typeof item.subject === "string" ? item.subject.trim().slice(0, 160) : "";
      if (subject.length < 3) {
        errors.push(`task ${id} has no usable subject`);
        return;
      }
      const verify = typeof item.verify === "string" && checkIds.has(item.verify) ? item.verify : "";
      if (!verify) errors.push(`task ${id} has no valid verify check`);
      const blocked_by = Array.isArray(item.blocked_by)
        ? item.blocked_by.filter((n) => Number.isInteger(n) && n >= 1 && n <= data.tasks.length && n !== id).slice(0, 6)
        : [];
      tasks.push({ id, subject, files: safeFiles(item.files), verify, blocked_by });
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
    const ready = remaining.find((t) => t.blocked_by.every((id) => settled.has(id) || !seen.has(id)));
    if (!ready) {
      errors.push("task dependencies contain a cycle");
      break;
    }
    settled.add(ready.id);
    remaining.splice(remaining.indexOf(ready), 1);
  }

  const s = data.settings && typeof data.settings === "object" ? data.settings : {};
  const settings = {
    max_turns: clamp(s.max_turns, 4, 200, 16),
    budget_usd: clamp(s.budget_usd, 0.1, 100, 5),
    handoff_every_turns: clamp(s.handoff_every_turns, 0, 20, 4),
    max_failures: clamp(s.max_failures, 1, 8, 3),
    isolation: s.isolation === "worktree" ? "worktree" : "none",
  };

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      objective: typeof data.objective === "string" && data.objective.trim() ? data.objective.trim().slice(0, 280) : objective.slice(0, 280),
      workspace,
      checks,
      tasks,
      settings,
    },
    errors: [],
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// When the model is unavailable the fallback still derives REAL criteria from
// the objective (a named file, a named string). A vacuous check like
// `node --test` with zero tests would let the mission "complete" without work.
export function fallbackPlan(objective, workspace) {
  const checks = [];
  const tasks = [];
  const stop = new Set(["the", "a", "and", "with", "inside", "workspace", "containing", "exactly", "word", "must", "create", "file", "files", "named", "make", "write", "build"]);
  const files = [...objective.matchAll(/\b([\w-]+(?:\.[\w-]+)+)\b/g)]
    .map((m) => m[1])
    .filter((f) => /\.[a-z0-9]{1,5}$/i.test(f))
    .slice(0, 8);
  const wordPatterns = [
    /(?:\bcontaining\b|\bexactly\b|\bhas\b)(?:\s+(?:the|word))*\s+([a-zA-Z][\w-]{2,30})/gi,
    /\bword\s+(?:the\s+)?([a-zA-Z][\w-]{2,30})/gi,
  ];
  const words = [...new Set(wordPatterns.flatMap((re) => [...objective.matchAll(re)].map((m) => m[1])))]
    .filter((w) => !stop.has(w.toLowerCase()))
    .slice(0, 8);

  if (files.length) {
    files.forEach((file, i) => {
      checks.push({ id: `file${i + 1}`, cmd: `test -f ${shellQuote(file)}`, expect: "exit0", timeout_ms: 10000 });
    });
    words.forEach((word, i) => {
      const file = files[Math.min(i, files.length - 1)];
      checks.push({ id: `content${i + 1}`, cmd: `grep -q ${shellQuote(word)} ${shellQuote(file)}`, expect: "exit0", timeout_ms: 10000 });
    });
    files.forEach((file, i) => {
      const word = words[Math.min(i, words.length - 1)];
      const verify = word ? `content${Math.min(i, words.length - 1) + 1}` : `file${i + 1}`;
      tasks.push({ id: i + 1, subject: `Create ${file}${word ? ` containing ${word}` : ""}`, files: [file], verify, blocked_by: [] });
    });
  } else {
    checks.push({
      id: "progress",
      cmd: `test -n "$(ls -A | grep -v '^\\.mission$')"`,
      expect: "exit0",
      timeout_ms: 10000,
    });
    tasks.push({ id: 1, subject: objective.slice(0, 120), files: [], verify: "progress", blocked_by: [] });
  }

  return {
    objective: objective.slice(0, 280),
    workspace,
    checks,
    tasks,
    settings: { max_turns: 16, budget_usd: 5, handoff_every_turns: 4, max_failures: 3, isolation: "none" },
  };
}

export async function createPlan(objective, workspace, generate, options = {}) {
  const attempts = options.attempts ?? 2;
  let lastErrors = ["no attempt made"];
  for (let i = 0; i < attempts; i += 1) {
    try {
      const prompt = i === 0
        ? planPrompt(objective, workspace)
        : `${planPrompt(objective, workspace)}\n\nThe previous answer was rejected for: ${lastErrors.join("; ")}. Return corrected JSON only.`;
      const out = await generate({ prompt, model: options.model });
      const text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
      const result = normalizePlan(text, objective, workspace);
      if (result.ok) return { plan: result.plan, source: "model" };
      lastErrors = result.errors;
    } catch (err) {
      lastErrors = [err instanceof Error ? err.message : String(err)];
    }
  }
  return { plan: fallbackPlan(objective, workspace), source: "fallback", errors: lastErrors };
}
