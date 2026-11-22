// Continuous improvement — pure decisions. After the original objective is met,
// the harness audits the repo, ranks findings, implements the worthwhile ones,
// verifies, and keeps or reverts. It stops on a value threshold or a budget,
// never "because the model said so".

export const IMPACT = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high" });
export const IMPACT_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });
export const DEFAULT_MIN_IMPACT = "medium";
export const DEFAULT_MAX_CYCLES = 5;
export const DEFAULT_CLEAN_ROUNDS = 2;

export function parseFindings(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const match = /\bFINDING\s*:\s*(.*)$/i.exec(raw);
    if (!match) continue;
    const body = match[1].trim();
    const field = (name, fallback = "") => {
      const m = new RegExp(`\\b${name}\\s*=\\s*([^\\s,;]+)`, "i").exec(body);
      return m ? m[1] : fallback;
    };
    const impact = String(field("impact", IMPACT.LOW)).toLowerCase();
    const filesMatch = /\bfiles\s*=\s*([^\s;]+)/i.exec(body);
    out.push({
      impact: IMPACT_RANK[impact] ? impact : IMPACT.LOW,
      risk: String(field("risk", "low")).toLowerCase(),
      files: String(filesMatch?.[1] ?? "").split(/[,|]/).map((f) => f.trim()).filter(Boolean),
      text: body.replace(/\b(impact|risk|files)\s*=\s*[^\s,;]+\s*/gi, "").trim(),
    });
  }
  return out;
}

export function worthImproving(finding, minImpact = DEFAULT_MIN_IMPACT) {
  return IMPACT_RANK[finding.impact] >= IMPACT_RANK[minImpact] && finding.risk !== "high";
}

export function rankFindings(findings, minImpact = DEFAULT_MIN_IMPACT) {
  return findings
    .filter((f) => worthImproving(f, minImpact))
    .sort((a, b) => {
      const score = (f) => IMPACT_RANK[f.impact] * 10 - (f.risk === "low" ? 2 : f.risk === "medium" ? 1 : 0);
      return score(b) - score(a);
    });
}

export function cycleDecision({ finding, improveCycles = 0, maxCycles = DEFAULT_MAX_CYCLES, cleanRounds = 0, maxCleanRounds = DEFAULT_CLEAN_ROUNDS, stopFile = false, outOfBudget = false }) {
  if (stopFile) return { type: "stop", reason: "stop-file" };
  if (outOfBudget) return { type: "stop", reason: "budget" };
  if (improveCycles >= maxCycles) return { type: "stop", reason: "improve-cycle-limit" };
  if (cleanRounds >= maxCleanRounds) return { type: "stop", reason: "no-high-value-improvements" };
  if (finding) return { type: "implement", finding };
  return { type: "audit" };
}
