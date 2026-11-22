// TUI part: a real Mission Control surface (HUD, sidebar, dashboard, panel).
// Exported as `./tui` so it loads beside the server part automatically.

import { Plugin } from "@opencode/plugin/tui";
import { createEffect, onCleanup, Show } from "solid-js";
import { loadTuiModel } from "./tui/model.js";
import { parseStartInput } from "./tui/input.js";
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

    // One TUI process owns many sessions. The route is the focused terminal;
    // tabs are the fallback when a fullscreen plugin page covers the router.
    const activeSession = (): string | undefined => {
      const route = context.ui.router.current();
      if (route.type === "session") return route.sessionID;
      if (context.ui.tabs.enabled()) {
        const active = context.ui.tabs.list().find((tab) => tab.active);
        if (active) return active.sessionID;
      }
      return undefined;
    };

    let activeSessionID = activeSession();

    const refresh = async (sessionID = activeSessionID) => {
      const next = await loadTuiModel({
        missionsRoot: context.options?.missionsRoot,
        sessionID,
      });
      setModel((draft) => {
        draft.snapshot = next.snapshot;
        draft.missions = next.missions;
        draft.updatedAt = next.updatedAt;
      });
    };

    // Commands must act on the mission of the terminal they were invoked from.
    const scopedSnapshot = () => {
      const snap = model.snapshot;
      if (!snap) return null;
      const sid = activeSession();
      if (!sid) return snap;
      return snap.sessionID === sid ? snap : null;
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
    createEffect(() => {
      const sid = activeSession();
      if (sid === activeSessionID) return;
      activeSessionID = sid;
      void refresh(sid);
    });
    const eventStop = context.data.listen(() => void refresh());

    const location = context.location ?? context.data.location.default();

    const navigate = (sessionID: string) => {
      // Always route to the session. Tabs are opened as a side effect, never as
      // a replacement for navigation (focus() is a no-op for a session that has
      // not been added to the tab strip yet, which left new missions invisible).
      if (context.ui.tabs.enabled()) context.ui.tabs.open(sessionID);
      context.ui.router.navigate({ type: "session", sessionID });
    };

    const missionCommand = async (text: string, sessionID?: string) => {
      let sid = sessionID || activeSession() || scopedSnapshot()?.sessionID;
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
          // `arguments: true` is what makes `/mission-start <objective>`
          // deliver its text to run(). Without it OpenCode consumed the line
          // and always opened the dialog — which is why `/mission start ...`
          // (the server command) worked while the slash form did not.
          slash: {
            name: "mission-start",
            aliases: ["missionstart", "mission-new"],
            arguments: true,
          },
          run: async (input) => {
            let objective = parseStartInput(input);
            // Only prompt when no objective was typed: palette and keyboard
            // dispatch have no input, and keep the original dialog flow.
            if (!objective) {
              objective =
                (
                  await context.ui.dialog.prompt({
                    title: "New mission",
                    description:
                      "Describe what must be done. The harness will verify it with executable criteria.",
                    placeholder: "build a complete 2D game engine with a headless smoke test",
                  })
                )?.trim() ?? "";
            }
            if (objective) await missionCommand(`start ${objective}`);
          },
        },
        {
          id: "mission.stop",
          title: "Stop the active mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-stop" },
          run: async () => {
            const snap = scopedSnapshot();
            if (!snap) {
              context.ui.toast.show({
                title: "Mission",
                message: "No active mission in this session",
                variant: "warning",
              });
              return;
            }
            const ok = await context.ui.dialog.confirm({
              title: "Stop mission",
              message: `Stop ${snap.id}? State is kept on disk.`,
              label: { confirm: "Stop", cancel: "Cancel" },
            });
            if (ok) await missionCommand("stop", snap.sessionID);
          },
        },
        {
          id: "mission.pause",
          title: "Pause the active mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-pause" },
          run: async () => {
            const snap = scopedSnapshot();
            if (!snap) return;
            await missionCommand("pause", snap.sessionID);
          },
        },
        {
          id: "mission.resume",
          title: "Resume a paused mission",
          group: "Mission",
          palette: true,
          slash: { name: "mission-resume" },
          run: async () => {
            const snap = scopedSnapshot();
            const root = snap?.root;
            await missionCommand(root ? `resume ${root}` : "resume", snap?.sessionID);
          },
        },
        {
          id: "mission.open",
          title: "Open the mission session",
          group: "Mission",
          palette: true,
          slash: { name: "mission-open" },
          run: () => {
            const sid = scopedSnapshot()?.sessionID;
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
