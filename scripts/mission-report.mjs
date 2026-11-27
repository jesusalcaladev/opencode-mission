#!/usr/bin/env node
// Regenerate the detailed mission report from durable files alone.
//
//   npm run report -- [mission-dir] [--print]
//
// Works for a finished mission, a stopped one, or a live one (the run line says
// "running"). Read-only apart from MISSION_REPORT.md.

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPORT_FILE, buildMissionReport, collectReportInputs } from "../src/mission.js";
import { gitSummary } from "../src/verify.js";

const args = process.argv.slice(2);
const print = args.includes("--print");
const target = args.find((arg) => !arg.startsWith("-")) ?? process.cwd();
const root = path.resolve(target);

const exists = await access(path.join(root, ".mission", "state.json"))
  .then(() => true)
  .catch(() => false);

if (!exists) {
  process.stderr.write(`No mission found in ${root} (missing .mission/state.json).\n`);
  process.exit(2);
}

const inputs = await collectReportInputs(root);
const git = await gitSummary(root);
const markdown = buildMissionReport({ ...inputs, git });

if (print) {
  process.stdout.write(markdown);
} else {
  const file = path.join(root, REPORT_FILE);
  await writeFile(file, markdown, "utf8");
  const state = inputs.state;
  process.stdout.write(
    [
      `report: ${file}`,
      `status: ${state.status ?? "unknown"}${state.finish_reason ? ` (${state.finish_reason})` : ""}`,
      `checks: ${(state.last_checks ?? []).filter((c) => c.ok).length}/${(state.last_checks ?? []).length} green · tasks: ${inputs.tasks.filter((t) => t.status === "completed").length}/${inputs.tasks.length} verified`,
      `turns: ${state.turn ?? 0} · cost: $${Number(state.cost_usd ?? 0).toFixed(2)} · tokens: ${state.tokens ?? 0}`,
    ].join("\n") + "\n"
  );
}
