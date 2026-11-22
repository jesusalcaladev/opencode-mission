// Structured, durable facts. Unlike a raw journal tail, a fact has a kind,
// a subject and a body, so a compacted context keeps the *reason*, not just
// the line that happened to be last.

export const MAX_FACTS = 200;
export const MAX_FACT_CHARS = 2000;

export function upsertFact(facts, fact) {
  const list = Array.isArray(facts) ? facts.slice() : [];
  const kind = String(fact?.kind ?? "note").slice(0, 32);
  const subject = String(fact?.subject ?? "")
    .trim()
    .slice(0, 120);
  const text = String(fact?.text ?? "")
    .trim()
    .slice(0, 1000);
  if (!subject || !text) return list;
  const index = list.findIndex((f) => f.kind === kind && f.subject === subject);
  const entry = { kind, subject, text, at: new Date().toISOString() };
  if (index >= 0) list[index] = entry;
  else list.push(entry);
  return list.slice(-MAX_FACTS);
}

export function renderFacts(facts, maxChars = MAX_FACT_CHARS) {
  const lines = (facts ?? []).map((f) => `- [${f.kind}] ${f.subject}: ${f.text}`);
  return lines.join("\n").slice(-maxChars);
}
