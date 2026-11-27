// Turn coarse planned tasks into a longer, well-separated task list. Each
// child owns exactly one file, so waves can run them in parallel without file
// conflicts, and each child keeps the parent's verifiable check.

export function expandTaskList(
  tasks = [],
  { target = 8, enabled = true, expandSingle = false } = {}
) {
  if (!enabled || !Array.isArray(tasks) || tasks.length >= target) return tasks;
  const childrenByParent = new Map();
  let nextId = tasks.reduce((max, t) => Math.max(max, Number(t?.id) || 0), 0) + 1;
  const out = [];
  const stages = [
    ["implement", "Implement"],
    ["test", "Add coverage for"],
    ["verify", "Verify and deploy"],
  ];

  for (const task of tasks) {
    const files = Array.isArray(task?.files) ? task.files.filter(Boolean) : [];
    if (files.length > 1) {
      const ids = [];
      for (const file of files) {
        const id = nextId++;
        ids.push(id);
        out.push({
          ...task,
          id,
          subject: `${String(task.subject ?? "Work").slice(0, 90)} — ${file}`,
          files: [file],
          status: task.status ?? "pending",
        });
      }
      childrenByParent.set(Number(task.id), ids);
    } else if (expandSingle && files.length === 1) {
      const ids = [];
      const base = String(task.subject ?? "Work").slice(0, 80);
      for (const [stage, verb] of stages) {
        const id = nextId++;
        ids.push(id);
        out.push({
          ...task,
          id,
          subject: `${verb} ${base} (${files[0]})`.slice(0, 160),
          files: [files[0]],
          stage,
          status: task.status ?? "pending",
        });
      }
      childrenByParent.set(Number(task.id), ids);
    } else {
      out.push({ ...task });
    }
  }

  if (childrenByParent.size === 0) return tasks;
  for (const task of out) {
    const refs = Array.isArray(task.blocked_by) ? task.blocked_by : [];
    task.blocked_by = [...new Set(refs.flatMap((id) => childrenByParent.get(Number(id)) ?? [id]))];
  }
  const renumber = new Map();
  out.forEach((task, index) => renumber.set(Number(task.id) || index + 1, index + 1));
  for (const task of out) {
    task.blocked_by = task.blocked_by.map((id) => renumber.get(Number(id)) ?? id);
    task.id = renumber.get(Number(task.id)) ?? task.id;
  }
  return out;
}
