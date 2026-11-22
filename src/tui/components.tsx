// @ts-nocheck — OpenTUI's published JSX types omit color props supported at runtime.
// Mission Control common components + sidebar card.
import { Show } from "solid-js";
import { budgetColor, money, statusColor, statusGlyph, truncate } from "./format.js";
import { useColors, type MissionSnapshot } from "./types";

export function Section(props: { title: string; children: any; flex?: number; minWidth?: number }) {
  const g = useColors();
  return (
    <box
      flexGrow={props.flex ?? 0}
      flexShrink={1}
      border={true}
      borderStyle="rounded"
      borderColor={g.border}
      backgroundColor={g.surface}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      minWidth={props.minWidth ?? 0}
      title={props.title}
      titleColor={g.muted}
    >
      <box flexDirection="column" paddingTop={1} paddingBottom={0}>
        {props.children}
      </box>
    </box>
  );
}

export function Stat(props: { label: string; value: string; color?: any }) {
  const g = useColors();
  return (
    <text fg={props.color ?? g.base}>
      <span fg={g.faint}>{props.label} </span>
      <span>{props.value}</span>
    </text>
  );
}

export function ProgressBar(props: { value: number; width?: number }) {
  const g = useColors();
  const n = Math.round(Math.max(0, Math.min(100, Number(props.value) || 0)));
  const width = Math.max(4, Number(props.width) || 16);
  const filled = Math.round((n / 100) * width);
  return (
    <text>
      <span fg={g.accent}>{"█".repeat(filled)}</span>
      <span fg={g.faint}>{"░".repeat(Math.max(0, width - filled))}</span>
      <span fg={g.muted}> {n}%</span>
    </text>
  );
}

export function StatusBadge(props: { status: string }) {
  const g = useColors();
  const color = () => statusColor(g, props.status);
  return (
    <text fg={color()}>
      <b>
        {statusGlyph(props.status)} {String(props.status ?? "").toUpperCase()}
      </b>
    </text>
  );
}

export function EmptyState() {
  const g = useColors();
  return (
    <box flexDirection="column" gap={1}>
      <text fg={g.accent}>
        <b>◇ MISSION CONTROL</b>
      </text>
      <text fg={g.muted}>No active mission in this session.</text>
      <text fg={g.faint}>Start one: /mission start &lt;objective&gt;</text>
      <text fg={g.faint}>Or press ctrl+shift+m for the dashboard.</text>
    </box>
  );
}

export function SidebarCard(props: { snapshot: MissionSnapshot | null }) {
  const g = useColors();
  const s = () => props.snapshot;
  return (
    <Section title="MISSION" minWidth={20}>
      <Show when={s()} fallback={<EmptyState />}>
        {() => {
          const snap = s()!;
          return (
            <box flexDirection="column" gap={0}>
              <StatusBadge status={snap.status} />
              <text fg={g.muted}>{truncate(snap.objective, 34)}</text>
              <ProgressBar value={snap.pct} width={18} />
              <Stat
                label="checks"
                value={`${snap.checksGreen}/${snap.checksTotal}`}
                color={
                  snap.checksGreen === snap.checksTotal && snap.checksTotal > 0
                    ? g.success
                    : g.warning
                }
              />
              <Stat label="tasks" value={`${snap.tasksDone}/${snap.tasksTotal}`} />
              <Stat
                label="agents"
                value={String(snap.agents.length)}
                color={snap.agents.length > 0 ? g.success : g.muted}
              />
              <Stat label="turn" value={`${snap.turn}/${snap.max_turns}`} />
              <Stat
                label="cost"
                value={`${money(snap.cost_usd)}/${money(snap.budget_usd)}`}
                color={budgetColor(g, snap.cost_usd, snap.budget_usd)}
              />
              <Show when={snap.nextTask}>
                <text fg={g.faint}>
                  next #{snap.nextTask!.id} {truncate(snap.nextTask!.subject, 24)}
                </text>
              </Show>
            </box>
          );
        }}
      </Show>
    </Section>
  );
}
