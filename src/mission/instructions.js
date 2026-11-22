// Project instructions: AGENTS.md / CLAUDE.md hierarchy, bounded and deduped.
// The model must see the repo's own rules before it edits anything.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const MAX_INSTRUCTION_CHARS = 6000;

export async function loadProjectInstructions(gpa, root, home = process.env.HOME ?? "") {
  const candidates = [
    path.join(root, "AGENTS.md"),
    path.join(root, "CLAUDE.md"),
    path.join(root, ".zode", "CLAUDE.md"),
    path.join(root, ".opencode", "AGENTS.md"),
    home ? path.join(home, ".config", "zode", "CLAUDE.md") : "",
  ].filter(Boolean);
  const chunks = [];
  const seen = new Set();
  let total = 0;
  for (const file of candidates) {
    const text = (await readFile(file, "utf8").catch(() => "")).trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    const room = MAX_INSTRUCTION_CHARS - total;
    if (room <= 0) break;
    chunks.push(`--- ${path.relative(root, file) || file} ---\n${text.slice(0, room)}`);
    total += Math.min(text.length, room);
  }
  return chunks.join("\n\n");
}
