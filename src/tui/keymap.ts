// Mission Control keymap/palette commands. Extracted from tui.tsx.
import { parseStartInput } from "./input.js";

export function missionKeymapLayer(
  context: any,
  helpers: { missionCommand: any; scopedSnapshot: any; navigate: any }
) {
  const { missionCommand, scopedSnapshot, navigate } = helpers;
  return {
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
          // Keep a visible separator: the bare `/missionstart` alias looked
          // glued to users and was easy to miss in the palette.
          aliases: ["mission-new"],
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
  };
}
