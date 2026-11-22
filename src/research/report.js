/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// Research mode: web search, safe page fetch, image search/download/generation.
// No third-party dependencies; all network access goes through fetch with hard
// timeouts and an SSRF guard. Deterministic parsers are unit-testable.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = "opencode-mission/0.3 (+research)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;
const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 200;
export function buildReport(question, { results = [], pages = [], images = [] } = {}) {
  const lines = [
    `# Research: ${String(question ?? "").trim()}`,
    "",
    "## Findings",
    ...(pages.length
      ? pages.map(
          (p, i) =>
            `### ${i + 1}. ${p.title || p.url}\n${p.description ? `${p.description}\n` : ""}${p.text.slice(0, 2200)}\n\nSource: ${p.url}`
        )
      : results.map(
          (r, i) => `### ${i + 1}. ${r.title || r.url}\n${r.content}\n\nSource: ${r.url}`
        )),
    "",
    "## Sources",
    ...results.map((r, i) => `${i + 1}. [${r.title || r.url}](${r.url})`),
    "",
    "## Images",
    ...images.map(
      (img) =>
        `- ${img.title || img.url} · ${img.license || "license unknown"} · ${img.creator || "author unknown"} · ${img.localPath || img.url}`
    ),
    "",
    "## Recommendation",
    "Based on the sources above, choose the approach with the strongest evidence and note the trade-offs.",
    "",
    "## Open Questions",
    "- What is still unverified?",
  ];
  return lines.join("\n");
}

export async function saveResearch(workspace, { report, sources = [], images = [] } = {}) {
  const dir = path.join(workspace, "research");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report.md"), `${String(report ?? "").trim()}\n`, "utf8");
  await writeFile(
    path.join(dir, "sources.json"),
    `${JSON.stringify({ at: new Date().toISOString(), sources, images }, null, 2)}\n`,
    "utf8"
  );
  return { report: path.join(dir, "report.md"), sources: path.join(dir, "sources.json") };
}

export function researchPlan(question, workspace) {
  const clean = String(question ?? "").trim();
  return {
    objective: `Research: ${clean.slice(0, 240)}`,
    workspace,
    checks: [
      {
        id: "report",
        cmd: "test -f research/report.md",
        expect: "exit0",
        timeout_ms: 10000,
        kind: "smoke",
      },
      {
        id: "sources",
        cmd: "grep -q '## Sources' research/report.md",
        expect: "exit0",
        timeout_ms: 10000,
        kind: "unit",
      },
      {
        id: "citations",
        cmd: "test $(grep -oE 'https?://[^ )]+' research/report.md | wc -l) -ge 3",
        expect: "exit0",
        timeout_ms: 10000,
        kind: "unit",
      },
      {
        id: "recommendation",
        cmd: "grep -q '## Recommendation' research/report.md",
        expect: "exit0",
        timeout_ms: 10000,
        kind: "unit",
      },
      {
        id: "images",
        cmd: "test $(find research/images -type f 2>/dev/null | wc -l) -ge 1",
        expect: "exit0",
        timeout_ms: 10000,
        kind: "smoke",
      },
    ],
    tasks: [
      {
        id: 1,
        subject: "Search the web and fetch authoritative sources",
        files: ["research/report.md"],
        verify: "citations",
        blocked_by: [],
      },
      {
        id: 2,
        subject: "Download or generate relevant images with attribution",
        files: ["research/images"],
        verify: "images",
        blocked_by: [1],
      },
      {
        id: 3,
        subject: "Write the research report with sources and recommendation",
        files: ["research/report.md"],
        verify: "recommendation",
        blocked_by: [1, 2],
      },
    ],
    requirements: [
      { id: "r-report", text: "A written research report exists", checks: ["report"] },
      { id: "r-sources", text: "At least three cited sources", checks: ["citations"] },
      { id: "r-images", text: "At least one attributed image", checks: ["images"] },
    ],
    settings: {
      max_turns: 12,
      budget_usd: 2,
      max_wallclock_min: 30,
      auto_extend: true,
      max_extensions: 3,
      handoff_every_turns: 4,
      continuous_improvement: false,
    },
    definition_of_done: ["Report written", "3+ sources", "1+ image", "Recommendation"],
    needs_research: true,
    research: true,
  };
}
