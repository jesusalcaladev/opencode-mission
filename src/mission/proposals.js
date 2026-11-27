// Recon proposals: the machine-readable `CHECK:`/`TASK:` lines a recon agent
// emits. Parsed deterministically so a mission can be planned even when the
// architect is unavailable. Pure.

/// `CHECK: id=x | cmd=y | expect=exit0` and `TASK: subject=… | files=… | check=…`.
/// Pipe-separated fields are used because a shell command contains spaces.
export function parseProposals(reports = []) {
  const checks = [];
  const tasks = [];
  const checkIds = new Set();
  for (const report of Array.isArray(reports) ? reports : []) {
    const text = typeof report === "string" ? report : String(report?.text ?? "");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const check = /^CHECK\s*:\s*(.+)$/i.exec(line);
      if (check) {
        const fields = fieldsOf(check[1]);
        const id = sanitizeId(fields.id);
        const cmd = String(fields.cmd ?? "").trim();
        if (!id || !cmd || checkIds.has(id)) continue;
        const expect =
          /^contains:/.test(String(fields.expect ?? "")) && String(fields.expect).length > 9
            ? String(fields.expect).trim()
            : "exit0";
        checkIds.add(id);
        checks.push({ id, cmd, expect });
        continue;
      }
      const task = /^TASK\s*:\s*(.+)$/i.exec(line);
      if (!task) continue;
      const fields = fieldsOf(task[1]);
      const subject = String(fields.subject ?? "")
        .trim()
        .slice(0, 160);
      const check_ref = sanitizeId(fields.check);
      if (!subject || !check_ref) continue;
      const files = String(fields.files ?? "")
        .split(/[,|]/)
        .map((file) => file.trim().replace(/^\.\//, ""))
        .filter((file) => file && !file.startsWith("/") && !file.split("/").includes(".."))
        .slice(0, 12);
      tasks.push({ subject, files, check: check_ref });
    }
  }
  return { checks, tasks };
}

/// Build a plan draft from recon proposals. The architect usually produces a
/// better one; this is the deterministic fallback when it is unavailable, and it
/// still goes through the same validation as any other plan.
export function harvestPlan(reports = [], objective = "", workspace = "") {
  const { checks, tasks } = parseProposals(reports);
  if (checks.length === 0 || tasks.length === 0) return null;
  const byId = new Map(checks.map((check) => [check.id, check]));
  const planned = [];
  for (const task of tasks) {
    if (!byId.has(task.check)) continue;
    planned.push({ subject: task.subject, files: task.files, verify: task.check, blocked_by: [] });
  }
  if (planned.length === 0) return null;
  return {
    objective: String(objective ?? "").slice(0, 280),
    workspace,
    definition_of_done: [],
    needs_research: false,
    checks,
    tasks: planned.map((task, index) => ({ ...task, id: index + 1 })),
    requirements: [],
    milestones: [],
    settings: {},
  };
}

function fieldsOf(body) {
  const out = {};
  for (const part of String(body ?? "").split("|")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    if (!key) continue;
    out[key] = part.slice(index + 1).trim();
  }
  return out;
}

export function sanitizeId(value) {
  const id = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : "";
}
