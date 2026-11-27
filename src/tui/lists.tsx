// @ts-nocheck — OpenTUI's published JSX types omit color props supported at runtime.
// Mission Control list components.
import { For, Show } from "solid-js";
import { checkGlyph, duration, shortID, statusColor, statusGlyph, truncate } from "./format.js";
import { useColors, type MissionSnapshot } from "./types";

export function CheckList(props: { checks: MissionSnapshot["checks"] }) {
  const g = useColors();
  return (
    <Show
      when={props.checks.length > 0}
      fallback={<text fg={g.faint}>No checks recorded yet.</text>}
    >
      <For each={props.checks.slice(0, 24)}>
        {(check) => (
          <text fg={check.ok ? g.success : g.error}>
            <span>{checkGlyph(check.ok)} </span>
            <span fg={g.base}>{check.id.padEnd(12, " ")}</span>
            <span>{truncate(check.summary || (check.ok ? "pass" : "fail"), 34)}</span>
            <span fg={g.faint}> {check.ms}ms</span>
          </text>
        )}
      </For>
    </Show>
  );
}

export function TaskList(props: { tasks: MissionSnapshot["tasks"] }) {
  const g = useColors();
  return (
    <Show when={props.tasks.length > 0} fallback={<text fg={g.faint}>No tasks planned.</text>}>
      <For each={props.tasks.slice(0, 24)}>
        {(task) => (
          <text fg={statusColor(g, task.status)}>
            <span>{statusGlyph(task.status)} </span>
            <span fg={g.faint}>#{task.id} </span>
            <span fg={g.base}>{truncate(task.subject, 34)}</span>
            <Show when={task.stage}>
              <span fg={g.faint}> [{truncate(task.stage, 10)}]</span>
            </Show>
            <Show when={task.verify}>
              <span fg={g.faint}> → {task.verify}</span>
            </Show>
            <Show when={task.attempts > 0}>
              <span fg={g.faint}> ×{task.attempts}</span>
            </Show>
            <Show when={task.duration_ms > 0}>
              <span fg={g.faint}> {duration(task.duration_ms)}</span>
            </Show>
          </text>
        )}
      </For>
    </Show>
  );
}

export function AgentList(props: { agents: MissionSnapshot["agents"] }) {
  const g = useColors();
  return (
    <Show when={props.agents.length > 0} fallback={<text fg={g.faint}>No agents in flight.</text>}>
      <For each={props.agents}>
        {(agent) => (
          <text fg={g.success}>
            <span>◆ </span>
            <span fg={g.base}>{agent.role.padEnd(12, " ")}</span>
            <span fg={g.faint}>#{agent.taskId || "—"} </span>
            <span>{shortID(agent.sessionID, 10)}</span>
            <Show when={agent.started_at}>
              <span fg={g.faint}> {duration(Date.now() - agent.started_at)}</span>
            </Show>
          </text>
        )}
      </For>
    </Show>
  );
}

export function RequirementList(props: { requirements: MissionSnapshot["requirements"] }) {
  const g = useColors();
  return (
    <Show
      when={props.requirements.length > 0}
      fallback={<text fg={g.faint}>No explicit requirements.</text>}
    >
      <For each={props.requirements}>
        {(req) => (
          <text fg={req.covered ? g.success : g.warning}>
            <span>{req.covered ? "✓" : "○"} </span>
            <span fg={g.base}>{truncate(req.text, 44)}</span>
            <span fg={g.faint}> [{req.checks.join(",")}]</span>
          </text>
        )}
      </For>
    </Show>
  );
}

export function Timeline(props: { journal: string }) {
  const g = useColors();
  const lines = () =>
    (props.journal || "")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
      .slice(-9);
  return (
    <Show when={lines().length > 0} fallback={<text fg={g.faint}>Journal is empty.</text>}>
      <For each={lines()}>
        {(line) => <text fg={g.muted}>{truncate(line.replace(/^\[[^\]]+\]\s*/, ""), 58)}</text>}
      </For>
    </Show>
  );
}
