// Pure scoring for the eval harness. A verdict is never trusted: only durable
// evidence written by the harness counts as a pass.

const KEYS = [
  "status",
  "finish_reason",
  "checks_green",
  "checks_red",
  "checks_total",
  "tasks_done",
  "tasks_pending",
  "turns",
  "review_attempts",
  "running",
  "pending",
  "refused",
  "wake_exists",
];

export function scoreCase(expected = {}, actual = {}) {
  const reasons = [];
  for (const key of KEYS) {
    const want = expected[key];
    if (want === undefined || want === null) continue;
    const got = actual[key];
    if (typeof want === "boolean" || typeof want === "number") {
      if (Number(got) !== Number(want)) reasons.push(`${key}: expected ${want}, got ${got}`);
    } else if (String(got) !== String(want)) {
      reasons.push(`${key}: expected ${want}, got ${got}`);
    }
  }
  for (const [key, needle] of [
    ["journal_contains", actual.journal],
    ["prompt_contains", actual.prompts],
  ]) {
    if (expected[key] && !String(needle ?? "").includes(String(expected[key])))
      reasons.push(`${key}: missing "${expected[key]}"`);
  }
  if (expected.status === "complete" && Number(actual.checks_red) > 0)
    reasons.push("harness invariant broken: complete with red checks");
  if (expected.status === "complete" && Number(actual.tasks_pending) > 0)
    reasons.push("harness invariant broken: complete with pending tasks");
  return { pass: reasons.length === 0, reasons };
}

export function summarize(results = []) {
  const out = {
    total: results.length,
    passed: 0,
    failed: 0,
    success_rate: 0,
    avg_turns: 0,
    avg_checks_green: 0,
    hard_stops: {},
  };
  for (const result of results) {
    if (result.pass) out.passed += 1;
    else out.failed += 1;
    out.avg_turns += Number(result.turns) || 0;
    out.avg_checks_green += Number(result.checks_green) || 0;
    const reason = result.finish_reason || (result.pass ? "verified" : "assertion");
    out.hard_stops[reason] = (out.hard_stops[reason] ?? 0) + 1;
  }
  if (results.length) {
    out.success_rate = Number((out.passed / results.length).toFixed(4));
    out.avg_turns = Number((out.avg_turns / results.length).toFixed(2));
    out.avg_checks_green = Number((out.avg_checks_green / results.length).toFixed(2));
  }
  return out;
}
