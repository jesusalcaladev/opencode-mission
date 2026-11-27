---
name: mission
description: Run an autonomous, harness-verified mission using mission_* tools
---

# Mission workflow

1. Read `mission_status` and the injected MISSION BRIEF. The brief is rebuilt from disk, not from chat history; trust it over your memory of the conversation.
2. Work only on the assigned files. Use `mission_write`; never edit `.mission/` (criteria, tasks and state are harness-owned).
3. Run `mission_check` after each change. It executes the real criteria and returns evidence paths.
4. Call `mission_verdict(status="met", …)` only when every check is green. A red check always beats any verdict. Use `mission_fact`/`mission_log` to persist decisions that must survive compaction.
5. Workers report with `mission_task_done(id, status, summary, evidence)` and call `mission_heartbeat` while working. A report never completes a task by itself: the harness verifies its check first.
6. If blocked, say why with `what_would_unblock`. In relentless mode blocked becomes a re-plan, not a stop.
