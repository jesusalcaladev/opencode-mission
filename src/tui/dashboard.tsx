import { Show } from "solid-js";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { usePlugin } from "@opencode/plugin/tui";
import { EmptyState } from "./components";
import { useMissionModel, useColors } from "./types";
import { DashboardBody } from "./dashboard-parts";

export function MissionDashboard() {
  const [model] = useMissionModel();
  const g = useColors();
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <Show when={model.snapshot} fallback={<EmptyState />}>
        {(snapshot) => <DashboardBody snapshot={snapshot()} />}
      </Show>
      <box flexDirection="row" gap={2}>
        <text fg={g.faint}>n new · s stop · p pause · r resume · o open · esc back</text>
        <text fg={g.faint}>updated {new Date(model.updatedAt).toLocaleTimeString()}</text>
      </box>
    </box>
  );
}

export function MissionPanel(props: { panel: PanelInput }) {
  const ctx = usePlugin();
  ctx.keymap.layer(() => ({
    target: () => null,
    commands: [
      {
        id: "mission.panel.close",
        title: "Close mission panel",
        bind: "escape",
        run: () => props.panel.close(),
      },
      {
        id: "mission.panel.full",
        title: "Toggle fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
    ],
  }));
  return <MissionDashboard />;
}
