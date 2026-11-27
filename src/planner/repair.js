// Deterministic plan repair. The model proposes; the harness never accepts a
// large objective with a token plan. Recon proposals and discovered file paths
// are used to grow checks/tasks up to the sizing target before validation.

import { sanitizeId } from "../mission/proposals.js";
import { safeCheckCmd } from "./prompt.js";

const KINDS = new Set(["build", "unit", "integration", "e2e", "smoke"]);
const DEPLOY = new Set(["e2e", "smoke", "deploy"]);

export function proposalFiles(reports = []) {
  const files = [];
  const seen = new Set();
  for (const report of Array.isArray(reports) ? reports : []) {
    const text = typeof report === "string" ? report : String(report?.text ?? "");
    for (const line of text.split(/\r?\n/)) {
      if (!/^FILES\s*:/i.test(line.trim())) continue;
      for (const match of line.matchAll(/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):\d+/g)) {
        const file = match[1].replace(/^\.\//, "");
        if (!file.startsWith("/") && !seen.has(file)) {
          seen.add(file);
          files.push(file);
        }
      }
    }
  }
  return files.slice(0, 20);
}

const kindOf = (kind) => (KINDS.has(kind) ? kind : "unit");

function fileCheck(file, used) {
  const base = sanitizeId(file.split(/[/.]/).filter(Boolean).slice(-2).join("-"));
  let id = sanitizeId(`file-${base || "artifact"}`).slice(0, 32);
  let suffix = 2;
  while (used.has(id)) id = sanitizeId(`${id}-${suffix++}`).slice(0, 32);
  return {
    id,
    cmd: `test -f ${file}`,
    expect: "exit0",
    timeout_ms: 30000,
    kind: "unit",
    retries: 0,
  };
}

/** Grow checks with recon proposals first, then with real artifact checks. */
export function repairChecks(checks = [], { proposals = {}, minChecks = 1 } = {}) {
  const out = Array.isArray(checks) ? checks.map((c) => ({ ...c })) : [];
  const used = new Set(out.map((c) => c.id));
  for (const proposal of Array.isArray(proposals.checks) ? proposals.checks : []) {
    if (out.length >= minChecks) break;
    const id = sanitizeId(proposal?.id).slice(0, 32);
    const cmd = String(proposal?.cmd ?? "").trim();
    if (!id || used.has(id) || !safeCheckCmd(cmd)) continue;
    used.add(id);
    const expect = String(proposal?.expect ?? "").startsWith("contains:")
      ? String(proposal.expect).slice(0, 200)
      : "exit0";
    out.push({
      id,
      cmd: cmd.slice(0, 500),
      expect,
      timeout_ms: 30000,
      kind: kindOf(proposal?.kind),
      retries: 0,
    });
  }
  for (const file of proposalFiles(proposals.reports)) {
    if (out.length >= minChecks) break;
    const check = fileCheck(file, used);
    used.add(check.id);
    out.push(check);
  }
  return out;
}

/** Add a real e2e/smoke check when the plan lacks one (never reject the plan). */
export function ensureDeployCheck(checks = [], proposals = {}) {
  const out = Array.isArray(checks) ? checks.map((c) => ({ ...c })) : [];
  if (out.some((c) => DEPLOY.has(c.kind) || /^(deploy|e2e|smoke)[_-]/i.test(String(c.id))))
    return out;
  const preferred = (list) =>
    Array.isArray(list)
      ? list.find((c) => /test|build|verify|check/i.test(String(c?.cmd ?? "")))
      : null;
  const source =
    preferred(proposals.checks) ??
    preferred(out) ??
    (Array.isArray(proposals.checks) ? proposals.checks[0] : null) ??
    out[0];
  if (!source || !safeCheckCmd(source.cmd)) return out;
  let id = sanitizeId(`e2e-${source.id ?? "final"}`).slice(0, 32);
  let suffix = 2;
  while (out.some((c) => c.id === id)) id = sanitizeId(`${id}-${suffix++}`).slice(0, 32);
  out.push({ ...source, id, kind: "e2e" });
  return out;
}

/** Grow tasks from recon proposals, discovered files, then uncovered checks. */
export function repairTasks(tasks = [], { proposals = {}, minTasks = 1, objective = "" } = {}) {
  const out = Array.isArray(tasks) ? tasks.map((t) => ({ ...t })) : [];
  const checks = Array.isArray(proposals.checks)
    ? proposals.checks.map((c) => sanitizeId(c?.id))
    : [];
  const validChecks = new Set([
    ...(proposals.checkIds ?? checks),
    ...(proposals.planCheckIds ?? []),
  ]);
  const knownFiles = [
    ...new Set([
      ...(Array.isArray(proposals.tasks) ? proposals.tasks.flatMap((t) => t.files ?? []) : []),
      ...proposalFiles(proposals.reports),
    ]),
  ];
  const add = (subject, files, verify) => {
    const id = out.length + 1;
    // Every synthesized task owns a file when recon found any: without it two
    // parallel workers can write the same paths and the harness cannot commit
    // a meaningful checkpoint for that task.
    const owned =
      Array.isArray(files) && files.length
        ? files
        : knownFiles.length
          ? [knownFiles[id % knownFiles.length]]
          : [];
    out.push({
      id,
      subject: String(subject).trim().slice(0, 160) || `Verify ${verify || id}`,
      files: owned.slice(0, 5),
      verify: verify ?? "",
      blocked_by: [],
      milestone: "",
      stage: "verify",
    });
  };
  for (const proposal of Array.isArray(proposals.tasks) ? proposals.tasks : []) {
    if (out.length >= minTasks) break;
    const verify = sanitizeId(proposal?.check);
    if (!validChecks.has(verify)) continue;
    add(proposal.subject, proposal.files, verify);
  }
  for (const file of proposalFiles(proposals.reports)) {
    if (out.length >= minTasks) break;
    const check = [...validChecks][out.length % Math.max(1, validChecks.size)] ?? "";
    add(`Implement and verify ${file}`, [file], check);
  }
  for (const check of validChecks) {
    if (out.length >= minTasks) break;
    if (out.some((t) => t.verify === check)) continue;
    add(`Verify ${check} — ${String(objective).slice(0, 60)}`, [], check);
  }
  // Still short: split verification into independently assignable follow-ups.
  const ids = [...validChecks];
  while (out.length < minTasks && ids.length) {
    const check = ids[out.length % ids.length];
    add(`Polish and re-verify deliverable ${out.length + 1}`, [], check);
  }
  out.forEach((task, index) => {
    task.id = index + 1;
    const known = new Set(out.map((t) => t.id));
    task.blocked_by = (Array.isArray(task.blocked_by) ? task.blocked_by : [])
      .filter((id) => known.has(Number(id)) && Number(id) !== task.id)
      .slice(0, 6);
  });
  return out;
}
