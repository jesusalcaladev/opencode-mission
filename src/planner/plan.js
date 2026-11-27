// Plan generation and safe fallbacks.
import { planPrompt } from "./prompt.js";
import { normalizePlan } from "./normalize.js";
import { detectToolchain, toolchainPlan } from "./toolchain.js";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// When the model is unavailable we derive REAL criteria from the objective
// (a named file, a named string). A vacuous check such as "any file exists"
// would let the mission "complete" without doing any work, so an objective
// with no verifiable content is returned with zero checks and must be rejected
// by the caller (or upgraded with toolchainPlan).
export function fallbackPlan(objective, workspace) {
  const checks = [];
  const tasks = [];
  const stop = new Set([
    "the",
    "a",
    "and",
    "with",
    "inside",
    "workspace",
    "containing",
    "exactly",
    "word",
    "must",
    "create",
    "file",
    "files",
    "named",
    "make",
    "write",
    "build",
  ]);
  const files = [...objective.matchAll(/\b([\w-]+(?:\.[\w-]+)+)\b/g)]
    .map((m) => m[1])
    .filter((f) => /\.[a-z0-9]{1,5}$/i.test(f))
    .slice(0, 8);
  const wordPatterns = [
    /(?:\bcontaining\b|\bexactly\b|\bhas\b)(?:\s+(?:the|word))*\s+([a-zA-Z][\w-]{2,30})/gi,
    /\bword\s+(?:the\s+)?([a-zA-Z][\w-]{2,30})/gi,
  ];
  const words = [
    ...new Set(wordPatterns.flatMap((re) => [...objective.matchAll(re)].map((m) => m[1]))),
  ]
    .filter((w) => !stop.has(w.toLowerCase()))
    .slice(0, 8);

  files.forEach((file, i) => {
    checks.push({
      id: `file${i + 1}`,
      cmd: `test -f ${shellQuote(file)}`,
      expect: "exit0",
      timeout_ms: 10000,
    });
  });
  words.forEach((word, i) => {
    const file = files[Math.min(i, files.length - 1)];
    checks.push({
      id: `content${i + 1}`,
      cmd: `grep -q ${shellQuote(word)} ${shellQuote(file)}`,
      expect: "exit0",
      timeout_ms: 10000,
    });
  });
  files.forEach((file, i) => {
    const word = words[Math.min(i, words.length - 1)];
    const verify = word ? `content${Math.min(i, words.length - 1) + 1}` : `file${i + 1}`;
    tasks.push({
      id: i + 1,
      subject: `Create ${file}${word ? ` containing ${word}` : ""}`,
      files: [file],
      verify,
      blocked_by: [],
    });
  });

  return {
    objective: objective.slice(0, 280),
    workspace,
    checks,
    tasks,
    settings: defaultSettings(),
    unstartable: checks.length === 0,
    reason: checks.length === 0 ? "no verifiable criteria could be derived from the objective" : "",
  };
}

function defaultSettings() {
  return {
    max_turns: 16,
    budget_usd: 5,
    max_wallclock_min: 0,
    lease_ms: 300000,
    max_writes: 0,
    handoff_every_turns: 4,
    max_failures: 3,
    isolation: "none",
  };
}

/// The only fallback the supervisor is allowed to start. It either derives
/// real checks from the objective, or uses the project's own toolchain, or
/// refuses to produce a plan at all. There is no "progress" check any more.
export async function safeFallbackPlan(objective, workspace, errors = []) {
  const derived = fallbackPlan(objective, workspace);
  if (derived.checks.length > 0) return { plan: derived, source: "fallback", errors };
  const detected = await detectToolchain(workspace);
  if (detected.length > 0)
    return {
      plan: toolchainPlan(objective, workspace, detected, defaultSettings()),
      source: "toolchain",
      errors,
    };
  return {
    plan: { ...derived, checks: [], tasks: [], unstartable: true },
    source: "no-criteria",
    errors: [...errors, "no test/build command found in the project; define real criteria first"],
  };
}

/// A re-plan may ADD or STRENGTHEN checks, but may never drop a check that was
/// already green. This prevents "completing" a mission by shrinking its scope.

export async function createPlan(objective, workspace, generate, options = {}) {
  const attempts = options.attempts ?? 2;
  let lastErrors = ["no attempt made"];
  for (let i = 0; i < attempts; i += 1) {
    try {
      const base = planPrompt(objective, workspace, options.extra);
      const prompt =
        i === 0
          ? base
          : `${base}\n\nThe previous answer was rejected for: ${lastErrors.join("; ")}. Return corrected JSON only.`;
      const out = await generate({ prompt, model: options.model });
      const text = typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
      const result = normalizePlan(text, objective, workspace);
      if (result.ok) return { plan: result.plan, source: "model" };
      lastErrors = result.errors;
    } catch (err) {
      lastErrors = [err instanceof Error ? err.message : String(err)];
    }
  }
  return safeFallbackPlan(objective, workspace, lastErrors);
}
