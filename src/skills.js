// Skill registration. Skills carry the static workflow contract; the dynamic
// state still comes from the disk-backed brief injected into every session.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");

const CATALOG = [
  {
    id: "mission-workflow",
    name: "mission",
    description: "Run an autonomous, harness-verified mission with mission_* tools",
    file: "mission.md",
  },
  {
    id: "mission-review",
    name: "mission-review",
    description: "Read-only review with machine-parsable SEVERITY findings",
    file: "mission-review.md",
  },
  {
    id: "mission-research",
    name: "mission-research",
    description: "Research with citations, images and durable notes",
    file: "mission-research.md",
  },
  {
    id: "mission-verdict",
    name: "mission-verdict",
    description: "Harness-owned definition of done before declaring a verdict",
    file: "mission-verdict.md",
  },
];

export async function skillDefinitions(base = SKILLS_DIR) {
  return Promise.all(
    CATALOG.map(async (entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      path: path.join(base, entry.file),
      content: await readFile(path.join(base, entry.file), "utf8"),
      autoinvoke: false,
    }))
  );
}

export async function registerSkills(ctx, { enabled = true } = {}) {
  if (!enabled || !ctx?.skill?.transform) return null;
  const definitions = await skillDefinitions();
  const registration = await ctx.skill.transform((editor) => {
    for (const skill of definitions) {
      if (!editor.get?.(skill.id)) editor.add(skill);
    }
  });
  return registration;
}
