#!/usr/bin/env node
// Docs consistency: public surface (scripts, tools, commands) must be documented.

export function analyzeDocs({
  readme = "",
  runbook = "",
  contract = "",
  scripts = [],
  tools = [],
  commands = [],
} = {}) {
  const docs = `${readme}\n${runbook}\n${contract}`;
  const problems = [];
  for (const name of scripts) {
    if (name === "check" || name === "test") continue;
    if (!docs.includes(name)) problems.push(`npm script "${name}" is undocumented`);
  }
  for (const tool of tools) {
    if (!readme.includes(`mission_${tool}`) && !readme.includes(`| \`${tool}\``))
      problems.push(`tool mission_${tool} is undocumented`);
  }
  for (const command of commands) {
    if (!readme.includes(`/mission ${command}`))
      problems.push(`command /mission ${command} is undocumented`);
  }
  if (!contract.includes("state.json")) problems.push("CONTRACT.md must document state.json");
  return problems;
}

async function main() {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const read = (file) => readFile(path.join(root, file), "utf8").catch(() => "");
  const [readme, runbook, contract, pkg, toolsSource, indexSource] = await Promise.all([
    read("README.md"),
    read("RUNBOOK.md"),
    read("CONTRACT.md"),
    read("package.json"),
    read("src/tool-definitions.js"),
    read("src/index.js"),
  ]);
  const scripts = Object.keys(JSON.parse(pkg).scripts ?? {});
  const tools = [...toolsSource.matchAll(/editor\.add\(\{\s*name: "([a-z_]+)"/g)].map((m) => m[1]);
  const commands = [...indexSource.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
  const problems = analyzeDocs({ readme, runbook, contract, scripts, tools, commands });
  if (problems.length) {
    process.stderr.write(`docs check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `docs ok: ${scripts.length} scripts, ${tools.length} tools, ${commands.length} commands\n`
  );
}

const invokedDirectly = process.argv[1]?.endsWith("check-docs.mjs");
if (invokedDirectly) await main();
