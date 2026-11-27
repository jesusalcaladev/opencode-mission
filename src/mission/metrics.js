// Durable mission telemetry. Pure counters; written to state.metrics and
// mirrored to .mission/metrics.json for external dashboards.

export const METRIC_KEYS = Object.freeze([
  "turns",
  "checksRun",
  "checksGreen",
  "checksRed",
  "tasksCompleted",
  "agentsSpawned",
  "agentsFailed",
  "agentReclaims",
  "recoveries",
  "rescues",
  "autoResumes",
  "failures",
  "extensions",
  "handoffs",
  "replans",
  "splits",
  "improvements",
  "writes",
  "researchCalls",
  "goalAudits",
  "reviews",
  "reconAgents",
]);

export const initialMetrics = () => Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));

export function metricsFromState(state) {
  const base = initialMetrics();
  const raw = state?.metrics ?? {};
  const out = { ...base };
  for (const key of METRIC_KEYS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = Math.trunc(value);
  }
  return out;
}

export function recordMetric(metrics, event, value = 1) {
  const out = metricsFromState({ metrics });
  const n = Number(value);
  const step = Number.isFinite(n) ? n : 1;
  out[String(event)] = (Number(out[String(event)]) || 0) + step;
  return out;
}

export function recordMetrics(metrics, events = {}) {
  let out = metricsFromState({ metrics });
  for (const [event, value] of Object.entries(events ?? {})) out = recordMetric(out, event, value);
  return out;
}

export function metricsLines(metrics) {
  const m = metricsFromState({ metrics });
  return [
    `turns ${m.turns} · checks ${m.checksRun} (${m.checksGreen}✓ ${m.checksRed}✕) · tasks ${m.tasksCompleted}`,
    `agents ${m.agentsSpawned} spawned / ${m.agentsFailed} failed / ${m.agentReclaims} reclaimed`,
    `recovery ${m.recoveries} · rescues ${m.rescues} · auto-resumes ${m.autoResumes} · failures ${m.failures}`,
    `extensions ${m.extensions} · handoffs ${m.handoffs} · replans ${m.replans} · audits ${m.goalAudits}`,
    `improvements ${m.improvements} · writes ${m.writes} · research ${m.researchCalls}`,
  ];
}
