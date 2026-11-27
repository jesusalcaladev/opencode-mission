// Pure deployment gate. Completion of a large mission means the finished work
// was published: every check green, every task done, a real e2e/smoke check
// green, and a harness checkpoint commit recorded. Only the harness feeds this
// to decide(); the model cannot write `deploy_verified`.

const DEPLOY_KINDS = new Set(["e2e", "smoke", "deploy"]);

export function deployCheckIds(criteria = {}) {
  const checks = Array.isArray(criteria?.checks) ? criteria.checks : [];
  return checks
    .filter(
      (c) => DEPLOY_KINDS.has(c?.kind) || /^(deploy|e2e|smoke)[_-]/i.test(String(c?.id ?? ""))
    )
    .map((c) => String(c.id));
}

export function deploymentVerified({
  criteria = {},
  results = [],
  tasks = [],
  commit = null,
} = {}) {
  const byId = new Map(
    (Array.isArray(results) ? results : []).map((r) => [String(r?.id), Boolean(r?.ok)])
  );
  const deployIds = deployCheckIds(criteria);
  const deployGreen = deployIds.length > 0 && deployIds.every((id) => byId.get(id) === true);
  const allGreen =
    Array.isArray(results) && results.length > 0 && results.every((r) => Boolean(r?.ok));
  const tasksDone =
    Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => t?.status === "completed");
  const committed = commit?.ok === true;
  return {
    verified: allGreen && tasksDone && deployGreen && committed,
    deployIds,
    deployGreen,
    allGreen,
    tasksDone,
    committed,
    commit: commit?.sha ?? "",
  };
}
