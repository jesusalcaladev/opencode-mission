// @ts-nocheck — OpenTUI's published JSX types omit color props supported at runtime.
// Mission Control common components + sidebar card.
import { For, Show } from "solid-js";
import { barParts, budgetColor, money, statusColor, statusGlyph, truncate } from "./format.js";
import { useColors, type MissionSnapshot } from "./types";

// Compatibility re-export: older TUI module graphs import DashboardBody from here.
// Keeps hot reloads in already-open sessions working after the component split.
export { Header, MetricsPanel, DashboardBody } from "./dashboard-parts";

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
  // Keep these as accessors: reading props once at component creation froze the
  // bar at its first value. Expressions inside JSX stay reactive in Solid.
  const parts = () => barParts(props.value, Math.max(4, Number(props.width) || 16));
  const color = () => (parts().pct >= 100 ? g.success : g.accent);
  return (
    <text>
      <span fg={color()}>{"█".repeat(parts().filled) + parts().partial}</span>
      <span fg={g.faint}>{"░".repeat(parts().empty)}</span>
      <span fg={g.muted}> {parts().pct}%</span>
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

export function SidebarCard(props: {
  snapshot: MissionSnapshot | null;
  missions?: Array<{ id: string; objective: string; status: string; pct: number }>;
}) {
  const g = useColors();
  const active = () => (props.missions ?? []).slice(0, 3);
  const fallback = () =>
    active().length ? (
      <box flexDirection="column" gap={0}>
        <text fg={g.faint}>mission activa en otra sesión</text>
        <For each={active()}>
          {(mission) => (
            <text fg={statusColor(g, mission.status)}>
              {statusGlyph(mission.status)} {truncate(mission.objective || mission.id, 26)}{" "}
              <span fg={g.faint}>{mission.pct}%</span>
            </text>
          )}
        </For>
        <text fg={g.faint}>abre /mission-open en esa sesión</text>
      </box>
    ) : (
      <EmptyState />
    );
  return (
    <Section title="MISSION" minWidth={20}>
      {/* The accessor keeps every field live when the snapshot is replaced. */}
      <Show when={props.snapshot} fallback={fallback()}>
        {(snap) => (
          <box flexDirection="column" gap={0}>
            <StatusBadge status={snap().status} />
            <text fg={g.muted}>{truncate(snap().objective, 34)}</text>
            <ProgressBar value={snap().pct} width={18} />
            <Stat
              label="checks"
              value={`${snap().checksGreen}/${snap().checksTotal}`}
              color={
                snap().checksGreen === snap().checksTotal && snap().checksTotal > 0
                  ? g.success
                  : g.warning
              }
            />
            <Stat label="tasks" value={`${snap().tasksDone}/${snap().tasksTotal}`} />
            <Stat
              label="agents"
              value={String(snap().agents.length)}
              color={snap().agents.length > 0 ? g.success : g.muted}
            />
            <Stat label="turn" value={`${snap().turn}/${snap().max_turns}`} />
            <Stat
              label="cost"
              value={`${money(snap().cost_usd)}/${money(snap().budget_usd)}`}
              color={budgetColor(g, snap().cost_usd, snap().budget_usd)}
            />
            <Show when={snap().nextTask}>
              <text fg={g.faint}>
                next #{snap().nextTask!.id} {truncate(snap().nextTask!.subject, 24)}
              </text>
            </Show>
          </box>
        )}
      </Show>
    </Section>
  );
}
