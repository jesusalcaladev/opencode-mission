// TUI part: a real Mission Control surface (HUD, sidebar, dashboard, panel).
// Exported as `./tui` so it loads beside the server part automatically.

import { Plugin } from "@opencode/plugin/tui";
import { Show } from "solid-js";
import { onCleanup } from "solid-js";
import { loadTuiModel } from "./tui/model.js";
import { SidebarCard } from "./tui/components";
import { MODEL_KEY, initialModel, type MissionModel } from "./tui/types";
import { MissionDashboard, MissionPanel } from "./tui/dashboard";

export default Plugin.define({
  id: "mission.cli",
  setup(context) {
    const [model, setModel] = context.storage.memory<MissionModel>(MODEL_KEY, {
      initial: initialModel(),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const refresh = async () => {
      const next = await loadTuiModel({ missionsRoot: context.options?.missionsRoot });
      setModel((draft) => {
        draft.snapshot = next.snapshot;
        draft.missions = next.missions;
        draft.updatedAt = next.updatedAt;
      });
    };

    const schedule = () => {
      if (stopped) return;
      const delay = model.snapshot?.status === "running" ? 1000 : 5000;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, delay);
      (timer as any)?.unref?.();
    };

    void refresh().then(schedule);
    const eventStop = context.data.listen(() => void refresh());

    const location = context.location ?? context.data.location.default();

    const navigate = (sessionID: string) => {
      if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID);
      else context.ui.router.navigate({ type: "session", sessionID });
    };

    const missionCommand = async (text: string, sessionID?: string) => {
      let sid = sessionID || model.snapshot?.sessionID;
      try {
        if (!sid) {
          const created = await context.client.session.create({
            title: "Mission Control",
            location,
          });
          sid = created?.id;
        }
        if (!sid) throw new Error("no session available");
        await context.client.session.command({ sessionID: sid, name: "mission", text });
        navigate(sid);
        context.ui.toast.show({
          title: "Mission",
          message: text,
          variant: "success",
          duration: 3000,
        });
        setTimeout(() => void refresh(), 600);
      } catch (err) {
        context.ui.toast.show({
          title: "Mission",
          message: err instanceof Error ? err.message : String(err),
          variant: "error",
          duration: 5000,
        });
      }
    };

    const slots = [
      context.ui.slot({
        append: "sidebar.content",
        render: () => <SidebarCard snapshot={model.snapshot} />,
      }),
      context.ui.slot({
        append: "session.panel",
        render: (panel) => (
          <Show when={panel.name === "mission.dashboard"}>
            <MissionPanel panel={panel} />
          </Show>
        ),
      }),
    ];

    const unregisterPage = context.ui.router.register({
      name: "mission-dashboard",
      render: () => <MissionDashboard />,
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mission.dashboard",
          title: "Mission Control dashboard",
          group: "Mission",
          bind: "ctrl+shift+m",
          palette: true,
          slash: { name: "mission-dashboard" },
          run: () => context.ui.router.navigate({ type: "plugin", name: "mission-dashboard" }),
        },
        {
          id: "mission.panel",
          title: "Open Mission Control panel",
          group: "Mission",
          palette: true,
          slash: { name: "mission-panel" },
          run: () => {
            if (!context.ui.panel.open("mission.dashboard")) {
              context.ui.router.navigate({ type: "plugin", name: "mission-dashboard" });
            }
          },
        },
        {
          id: "mission.start",
          title: "Start an autonomous mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-start" },
          run: async () => {
            const objective = await context.ui.dialog.prompt({
              title: "New mission",
              description:
                "Describe what must be done. The harness will verify it with executable criteria.",
              placeholder: "build a complete 2D game engine with a headless smoke test",
            });
            if (objective?.trim()) await missionCommand(`start ${objective.trim()}`);
          },
        },
        {
          id: "mission.stop",
          title: "Stop the active mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-stop" },
          run: async () => {
            if (!model.snapshot) {
              context.ui.toast.show({
                title: "Mission",
                message: "No active mission",
                variant: "warning",
              });
              return;
            }
            const ok = await context.ui.dialog.confirm({
              title: "Stop mission",
              message: `Stop ${model.snapshot.id}? State is kept on disk.`,
              label: { confirm: "Stop", cancel: "Cancel" },
            });
            if (ok) await missionCommand("stop", model.snapshot.sessionID);
          },
        },
        {
          id: "mission.pause",
          title: "Pause the active mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-pause" },
          run: async () => {
            if (!model.snapshot) return;
            await missionCommand("pause", model.snapshot.sessionID);
          },
        },
        {
          id: "mission.resume",
          title: "Resume a paused mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-resume" },
          run: async () => {
            const root = model.snapshot?.root;
            await missionCommand(root ? `resume ${root}` : "resume", model.snapshot?.sessionID);
          },
        },
        {
          id: "mission.open",
          title: "Open the mission session",
          group: "Mission",
          palette: true,
          slash: { name: "mission-open" },
          run: () => {
            const sid = model.snapshot?.sessionID;
            if (sid) navigate(sid);
          },
        },
      ],
      bindings: ["mission.dashboard"],
    }));

    const dispose = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      eventStop();
      for (const slot of slots) slot?.();
      unregisterPage?.();
    };

    onCleanup(dispose);
    return dispose;
  },
});
