#!/usr/bin/env node
// Eval CLI: load cases, run them through the real Supervisor, gate regressions.

// A nested `node --test` criterion skips test files when this is inherited.
delete process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_REPORTER;
// Evals must never pollute the real TUI registry with synthetic missions.
const evalCache = await mkdtemp(path.join(os.tmpdir(), "mission-eval-cache-"));
process.env.OPENCODE_MISSION_CACHE_DIR = evalCache;

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { summarize } from "../src/mission.js";
import { exists, rootDir, runCase } from "./eval-harness.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const filter = value("--filter", "");
const maxTurns = Math.max(1, Number(value("--max-turns", 24)) || 24);
const updateBaseline = args.includes("--update-baseline");
const out = value("--out", "");

const casesDir = path.join(rootDir, "eval", "cases");
const baselineFile = path.join(rootDir, "eval", "baseline.json");

const names = (await readdir(casesDir)).filter((name) => name.endsWith(".json")).sort();
const cases = (
  await Promise.all(
    names.map(async (name) => JSON.parse(await readFile(path.join(casesDir, name), "utf8")))
  )
).filter((testCase) => !filter || testCase.id.includes(filter));
if (cases.length === 0) {
  process.stderr.write(`No eval cases matched "${filter}".\n`);
  process.exit(2);
}

const results = [];
for (const testCase of cases) results.push(await runCase(testCase, maxTurns));
const summary = summarize(results);
const gate = { ok: true, reasons: [] };

if (updateBaseline) {
  const map = {};
  for (const result of results) map[result.id] = { pass: result.pass };
  await writeFile(
    baselineFile,
    `${JSON.stringify({ version: 1, summary, cases: map }, null, 2)}\n`,
    "utf8"
  );
  gate.reasons.push("baseline updated");
} else if (await exists(baselineFile)) {
  const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
  for (const result of results) {
    if (baseline.cases?.[result.id]?.pass === true && !result.pass)
      gate.reasons.push(`regression: ${result.id} ${result.reasons.join("; ")}`);
  }
  if (Number(baseline.summary?.success_rate ?? 1) > summary.success_rate)
    gate.reasons.push(
      `success rate dropped: ${baseline.summary.success_rate} → ${summary.success_rate}`
    );
  gate.ok = gate.reasons.length === 0;
}

const text = `${JSON.stringify({ summary, gate, results }, null, 2)}\n`;
process.stdout.write(text);
if (out) await writeFile(path.resolve(out), text, "utf8");
await rm(evalCache, { recursive: true, force: true }).catch(() => {});
process.exit(gate.ok && summary.failed === 0 ? 0 : 1);
