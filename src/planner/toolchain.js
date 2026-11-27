// Real, project-derived criteria. Used when the planner cannot produce a valid
// plan: instead of inventing an "anything exists" check, we inspect the actual
// project and use its own test/build/lint commands. Nothing here executes code;
// it only reads manifests and returns candidate commands for the harness to run.

import { readFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import { safeCheckCmd } from "./prompt.js";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function check(id, cmd, kind, timeout_ms = 120_000) {
  const value = String(cmd ?? "").trim();
  if (!safeCheckCmd(value) || value.length > 500) return null;
  return { id, cmd: value, expect: "exit0", timeout_ms, kind };
}

/// Detect real verification commands in a project directory.
/// Returns only checks that are safe and actually backed by a manifest/target.
export async function detectToolchain(workspace, options = {}) {
  const root = path.resolve(String(workspace ?? "."));
  const timeout = Math.max(1000, Number(options.timeout_ms) || 120_000);
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };

  const pkg = await readJson(path.join(root, "package.json"));
  const scripts = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const npmScript = (name, id, kind) => {
    const cmd = scripts?.[name];
    if (typeof cmd !== "string" || !cmd.trim()) return;
    add(check(id, `npm run ${name}`, kind, timeout));
  };
  if (typeof scripts.test === "string" && scripts.test.trim())
    add(check("unit", "npm test", "unit", timeout));
  for (const [name, id, kind] of [
    ["build", "build", "build"],
    ["typecheck", "typecheck", "build"],
    ["lint", "lint", "unit"],
    ["verify", "verify", "integration"],
    ["test:unit", "unit", "unit"],
    ["test:integration", "integration", "integration"],
    ["test:e2e", "e2e", "e2e"],
    ["smoke", "smoke", "smoke"],
  ])
    npmScript(name, id, kind);

  if (
    (await exists(path.join(root, "tsconfig.json"))) &&
    (pkg?.devDependencies?.typescript || pkg?.dependencies?.typescript)
  )
    add(check("typecheck", "npx tsc --noEmit", "build", timeout));

  const makefile = await readText(path.join(root, "Makefile"));
  if (/^test[a-zA-Z_-]*\s*:/m.test(makefile)) add(check("unit", "make test", "unit", timeout));
  if (/^build[a-zA-Z_-]*\s*:/m.test(makefile)) add(check("build", "make build", "build", timeout));

  if (
    (await exists(path.join(root, "pyproject.toml"))) ||
    (await exists(path.join(root, "pytest.ini"))) ||
    (await exists(path.join(root, "setup.cfg"))) ||
    (await exists(path.join(root, "tests")))
  )
    add(check("unit", "python -m pytest -q", "unit", timeout));
  else if (await exists(path.join(root, "test")))
    add(check("unit", "python -m unittest discover -s test", "unit", timeout));

  if (await exists(path.join(root, "go.mod"))) add(check("unit", "go test ./...", "unit", timeout));
  if (await exists(path.join(root, "Cargo.toml")))
    add(check("unit", "cargo test", "unit", timeout));
  if (await exists(path.join(root, "build.zig"))) {
    const zigBuild = await readText(path.join(root, "build.zig"));
    if (/\bstep\s*\(\s*["']test["']/.test(zigBuild))
      add(check("unit", "zig build test", "unit", timeout));
    add(check("build", "zig build", "build", timeout));
  }

  // A project with no manifest can still be verified when it ships its own
  // executable test suite. Keep this narrow: only a root test file, never an
  // arbitrary "ls" style existence probe.
  if (!out.length) {
    const hasNodeTests = async (dir) => {
      try {
        return (await readdir(dir)).some((f) => /\.test\.(js|mjs|cjs|ts)$/.test(f));
      } catch {
        return false;
      }
    };
    if (
      (await hasNodeTests(root)) ||
      (await hasNodeTests(path.join(root, "test"))) ||
      (await hasNodeTests(path.join(root, "tests")))
    )
      add(check("unit", "node --test", "unit", timeout));
    else if (
      (await exists(path.join(root, "test", "run.sh"))) ||
      (await exists(path.join(root, "scripts", "test.sh")))
    )
      add(check("unit", "sh ./scripts/test.sh", "unit", timeout));
  }

  return out.slice(0, 24);
}

/// Turn detected commands into a complete, honest plan. Tasks are worker-owned
/// fix loops: the harness only credits one when its real check is green and the
/// worker explicitly reports completion with evidence.
export function toolchainPlan(objective, workspace, checks, settings) {
  const list = Array.isArray(checks) ? checks : [];
  return {
    objective: String(objective ?? "").slice(0, 280),
    workspace,
    definition_of_done: list.map((c) => `${c.id}: ${c.cmd} exits 0`),
    checks: list,
    tasks: list.map((c, i) => ({
      id: i + 1,
      subject: `Make '${c.cmd}' pass — ${String(objective ?? "").slice(0, 100)}`,
      files: [],
      verify: c.id,
      blocked_by: [],
      stage: i === list.length - 1 ? "verify" : "fix",
    })),
    requirements: list.map((c) => ({ id: `req-${c.id}`, text: `${c.cmd} passes`, checks: [c.id] })),
    milestones: [{ id: "m1", title: "Verify the project" }],
    settings,
    criteria_source: "toolchain",
  };
}
