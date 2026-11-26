// Cross-mission memory: distilled decisions shared by missions in the same
// missionsRoot. Bounded and deduplicated so it never becomes a second journal.

export const GLOBAL_MEMORY_FILE = "GLOBAL_MEMORY.md";
export const GLOBAL_MEMORY_BUDGET = 4000;

export function mergeGlobalMemory(existing = "", additions = [], budget = GLOBAL_MEMORY_BUDGET) {
  const lines = String(existing ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set(lines);
  for (const addition of additions) {
    for (const raw of String(addition ?? "").split(/\r?\n/)) {
      const line = raw.trim().slice(0, 200);
      if (line.length < 8 || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  let out = lines.join("\n");
  const cap = Math.max(200, Number(budget) || GLOBAL_MEMORY_BUDGET);
  if (out.length > cap) out = out.slice(-cap).replace(/^[^\n]*\n/, "");
  return `${out}\n`;
}
