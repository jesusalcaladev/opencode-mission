// TUI part: a live mission progress line in OpenCode's footer.
// Exported as `./tui` so it loads beside the server part automatically.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const POINTER = path.join(os.homedir(), ".cache", "opencode-mission", "current.json")

type MissionState = {
  status?: string
  turn?: number
  max_turns?: number
  cost_usd?: number
  last_checks?: Array<{ ok: boolean }>
  improve_cycles?: number
}

async function progress(): Promise<string> {
  try {
    const pointer = JSON.parse(await readFile(POINTER, "utf8")) as { root?: string }
    if (!pointer.root) return ""
    const state = JSON.parse(await readFile(path.join(pointer.root, ".mission", "state.json"), "utf8")) as MissionState
    const tasks = JSON.parse(await readFile(path.join(pointer.root, ".mission", "tasks.json"), "utf8")) as { tasks?: Array<{ status: string }> }
    const checks = state.last_checks ?? []
    const green = checks.filter((c) => c.ok).length
    const done = (tasks.tasks ?? []).filter((t) => t.status === "completed").length
    const ratio = checks.length > 0 ? green / checks.length : (tasks.tasks?.length ?? 0) > 0 ? done / tasks.tasks!.length : 0
    const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)))
    const bar = "▓".repeat(filled) + "░".repeat(10 - filled)
    return `MISSION ${bar} ${green}/${checks.length} checks · ${done}/${tasks.tasks?.length ?? 0} tasks · $${(state.cost_usd ?? 0).toFixed(2)} · cycle ${state.improve_cycles ?? 0}`
  } catch {
    return ""
  }
}

export default Plugin.define({
  id: "mission.cli",
  setup(context) {
    const [line, setLine] = createSignal("")
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = async () => setLine(await progress())

    void refresh()
    timer = setInterval(() => void refresh(), 2000)
    const eventStop = context.data.listen(() => void refresh())
    const slot = context.ui.slot({
      append: "home.footer.status",
      render: () => <text fg={context.theme.text.base}>{line()}</text>,
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "mission.status",
          title: "Show mission progress",
          group: "Mission",
          palette: true,
          slash: { name: "mission-status" },
          run: async () => {
            const text = await progress()
            context.ui.toast.show({ title: "Mission", message: text || "No active mission", variant: "info", duration: 4000 })
          },
        },
      ],
    }))

    onCleanup(() => {
      if (timer) clearInterval(timer)
      eventStop()
      slot?.()
    })
    return () => {
      if (timer) clearInterval(timer)
      eventStop()
      slot?.()
    }
  },
})
