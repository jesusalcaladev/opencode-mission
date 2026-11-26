#!/usr/bin/env node
// Architecture guardrails from ARCHITECTURE.md, enforced in CI.
// Pure analyzer first, IO only in main().

export const MAX_SOURCE_LINES = 250;

export function analyzeSources(files = []) {
  const violations = [];
  for (const { path: file, content = "" } of files) {
    const lines = content.split(/\r?\n/).length;
    if (lines > MAX_SOURCE_LINES)
      violations.push(`${file}: ${lines} lines (max ${MAX_SOURCE_LINES})`);
    if (/from\s+["']node:test["']|require\("node:test"\)/.test(content))
      violations.push(`${file}: test globals are not allowed in src/`);
    if (file.includes("/supervisor/") && !file.endsWith("/deps.js")) {
      if (/import\s*\{[^}]*\}\s*from\s*["'][^"']*deps\.js["']/.test(content))
        violations.push(`${file}: mixins must reach dependencies through this.d`);
    }
    if (file.includes("/supervisor/") && /status\s*[:=]\s*["']complete["']/.test(content))
      violations.push(`${file}: only decide()/finish may produce a terminal status`);
  }
  const writeTool = files.find((f) => f.path.endsWith("/supervisor/tools.js"));
  if (writeTool && !writeTool.content.includes(".mission/"))
    violations.push("src/supervisor/tools.js: mission_write must refuse .mission/ paths");
  return violations;
}

async function main() {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (/\.(js|ts|tsx)$/.test(entry.name))
        out.push({ path: full, content: await readFile(full, "utf8") });
    }
    return out;
  }

  const files = await walk(path.join(root, "src"));
  const violations = analyzeSources(files).map((v) => v.replace(`${root}/`, ""));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (!pkg.scripts?.eval) violations.push("package.json: missing npm run eval");
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8").catch(() => "");
  if (!ci.includes("npm run eval")) violations.push("CI: npm run eval is not wired");

  if (violations.length) {
    process.stderr.write(
      `architecture check failed:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`architecture ok: ${files.length} source files\n`);
}

const invokedDirectly = process.argv[1]?.endsWith("check-architecture.mjs");
if (invokedDirectly) await main();
