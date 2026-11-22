// @ts-nocheck — OpenTUI's published JSX types omit color props supported at runtime.
// Mission Control dashboard components.
import { For, Show } from "solid-js";
import {
  budgetColor,
  duration,
  money,
  shortID,
  sparkline,
  statusColor,
  statusGlyph,
  truncate,
} from "./format.js";
import { useColors, type MissionSnapshot } from "./types";
import { CheckList, RequirementList, TaskList, AgentList, Timeline } from "./lists";
import { Section, Stat, ProgressBar, StatusBadge } from "./components";

export function Header(props: { snapshot: MissionSnapshot }) {
  const g = useColors();
  const s = () => props.snapshot;
  return (
    <box flexDirection="column">
      <text fg={g.accent}>
        <b>MISSION CONTROL</b>
        <span fg={g.faint}> · telemetry</span>
      </text>
      <text fg={g.muted}>{truncate(s().objective, 100)}</text>
      <box flexDirection="row" gap={2}>
        <StatusBadge status={s().status} />
        <Stat label="id" value={s().id} />
        <Stat label="phase" value={s().phase || s().stage || "—"} />
        <Stat label="turn" value={`${s().turn}/${s().max_turns}`} />
        <Stat label="elapsed" value={duration(s().elapsed_ms)} />
        <Stat
          label="cost"
          value={`${money(s().cost_usd)}/${money(s().budget_usd)}`}
          color={budgetColor(g, s().cost_usd, s().budget_usd)}
        />
      </box>
      <box flexDirection="row" gap={2}>
        <ProgressBar value={s().pct} width={24} />
        <text fg={g.muted}>
          {s().checksGreen}/{s().checksTotal} checks · {s().tasksDone}/{s().tasksTotal} tasks ·{" "}
          {s().reqCovered}/{s().reqTotal} reqs
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={g.faint}>history </text>
        <text fg={g.interactive}>{sparkline(s().history, 20)}</text>
        <text fg={g.faint}>
          tier {s().strategy_tier} · ext {s().extensions}/{s().max_extensions} · chain{" "}
          {s().chain_index}/{s().chain_total}
        </text>
      </box>
    </box>
  );
}

export function MetricsPanel(props: { snapshot: MissionSnapshot }) {
  const g = useColors();
  const s = () => props.snapshot;
  return (
    <box flexDirection="column" gap={0}>
      <For each={s().metrics_lines}>{(line) => <text fg={g.faint}>{truncate(line, 58)}</text>}</For>
      <Show when={s().handoffs.length > 0}>
        <text fg={g.interactive}>
          handoffs:{" "}
          {s()
            .handoffs.map((h) => `t${h.turn} ${shortID(h.to, 6)}`)
            .join(" · ")}
        </text>
      </Show>
    </box>
  );
}

export function DashboardBody(props: { snapshot: MissionSnapshot }) {
  const g = useColors();
  const s = () => props.snapshot;
  return (
    <box flexDirection="column" gap={1}>
      <Header snapshot={s()} />
      <box flexDirection="row" gap={1} flexGrow={1}>
        <box flexDirection="column" gap={1} flexGrow={1} minWidth={28}>
          <Section title="CHECKS" flex={1}>
            <CheckList checks={s().checks} />
          </Section>
          <Section title="REQUIREMENTS" flex={1}>
            <RequirementList requirements={s().requirements} />
          </Section>
        </box>
        <box flexDirection="column" gap={1} flexGrow={1} minWidth={30}>
          <Section title="TASKS" flex={1}>
            <TaskList tasks={s().tasks} />
          </Section>
          <Section title="AGENTS" flex={1}>
            <AgentList agents={s().agents} />
          </Section>
        </box>
        <box flexDirection="column" gap={1} flexGrow={1} minWidth={28}>
          <Section title="TIMELINE" flex={1}>
            <Timeline journal={s().journal} />
          </Section>
          <Section title="DETAILS" flex={1}>
            <Stat label="workspace" value={truncate(s().root, 30)} />
            <Stat label="session" value={shortID(s().sessionID, 12)} />
            <Stat label="finish" value={s().finish_reason || "—"} />
            <Show when={s().worktree_branch}>
              <Stat label="branch" value={s().worktree_branch} />
            </Show>
            <Stat label="writes" value={`${s().writes}/${s().max_writes || "∞"}`} />
            <Stat label="improve" value={`${s().improve_cycles}/${s().max_improve_cycles}`} />
            <Show when={s().nextTask}>
              <text fg={g.accent}>
                next #{s().nextTask!.id} {truncate(s().nextTask!.subject, 26)}
              </text>
            </Show>
          </Section>
          <Section title="TELEMETRY" flex={1}>
            <MetricsPanel snapshot={s()} />
          </Section>
        </box>
      </box>
    </box>
  );
}
