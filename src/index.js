// OpenCode plugin entrypoint: /mission commands, mission_* tools, and the two hooks
// that make the supervisor autonomous (context injection + idle continuation).

import { Plugin } from "@opencode/plugin";
import { existsSync } from "node:fs";
import path from "node:path";
import { Supervisor } from "./supervisor.js";
import { duckDuckGoProvider, braveProvider, serperProvider, tavilyProvider } from "./research.js";
import { toolDefinitions } from "./tool-definitions.js";
import { registerSkills } from "./skills.js";

const HELP = [
  "/mission start <what to do>   Run a verified mission in the CURRENT directory (your project)",
  "/mission start --long <what>  Relentless: keep working until genuinely done (unattended)",
  "/mission start --big <what>   Large plan: 15-30 checks, 20-40 tasks, verified deploy",
  "/mission start --quick <what> Skip the recon/blueprint prelude (single planner pass)",
  "/mission start <dir>          Start a pre-authored mission in an existing directory",
  "/mission parallel A | B | C   Start up to 8 independent missions in parallel",
  "/mission queue add A [p:5]   Queue a mission (priority); use list/run/clear",
  "/mission status        Show state, checks and next task",
  "/mission research <q>  Research a question on the web, with images and sources",
  "/mission pause         Pause at the next idle boundary (remove PAUSE to resume)",
  "/mission stop          Stop the mission; state is kept on disk",
  "/mission resume [dir]  Resume a stopped mission",
  "/mission help          Show this help",
].join("\n");

function expandHome(p) {
  return p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p;
}

function looksLikePath(p) {
  if (!p) return false;
  const v = expandHome(p);
  return (
    v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || existsSync(path.resolve(v))
  );
}

export default Plugin.define({
  id: "mission",
  async setup(ctx) {
    const supervisor = new Supervisor(ctx, {
      model: ctx.options?.model,
      fastModel: ctx.options?.fastModel,
      modelsByRole: ctx.options?.modelsByRole,
      fallbackModel: ctx.options?.fallbackModel,
      notifyUrl: ctx.options?.notifyUrl,
      plannerModel: ctx.options?.plannerModel,
      maxWorkers: ctx.options?.maxWorkers,
      missionsRoot: ctx.options?.missionsRoot,
      workspaceMode: ctx.options?.workspaceMode,
      enableWorkers: ctx.options?.enableWorkers,
      enableChaining: ctx.options?.enableChaining,
      defaultAutonomy: ctx.options?.defaultAutonomy,
      discovery: ctx.options?.discovery,
      reconAgents: ctx.options?.reconAgents,
      rescueIntervalMs: ctx.options?.rescueIntervalMs,
      generate: async ({ prompt, model }) => {
        const out = await ctx.experimental.generate.text({ prompt, model });
        return typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
      },
    });
    await supervisor.init();
    supervisor.startEventRecovery();
    supervisor.startRescueTimer();
    supervisor.startWakeWatcher();
    supervisor.startQueueTimer();
    const registrations = [];

    // Skills are optional: older OpenCode builds may not expose ctx.skill.
    try {
      const skillRegistration = await registerSkills(ctx, {
        enabled: ctx.options?.enableSkills !== false,
      });
      if (skillRegistration) registrations.push(skillRegistration);
    } catch {
      // Plugin still works with brief injection alone.
    }

    registrations.push(
      await ctx.websearch.transform((editor) => {
        editor.add(duckDuckGoProvider);
        if (process.env.BRAVE_SEARCH_API_KEY)
          editor.add(braveProvider(process.env.BRAVE_SEARCH_API_KEY));
        if (process.env.SERPER_API_KEY) editor.add(serperProvider(process.env.SERPER_API_KEY));
        if (process.env.TAVILY_API_KEY) editor.add(tavilyProvider(process.env.TAVILY_API_KEY));
        if (editor.default.get() === undefined) editor.default.set("mission-duckduckgo");
      })
    );

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "mission",
          description: "Run an autonomous, criteria-verified mission until it is actually done",
          execute: async ({ sessionID, prompt }) => {
            const args = (prompt?.text ?? "").trim();
            const [sub, ...rest] = args.split(/\s+/);
            const arg = rest.join(" ");
            let reply;
            switch (sub) {
              case "":
              case "help":
                reply = HELP;
                break;
              case "start": {
                const quick = /^--(quick|fast|no-discovery)\s+/i.exec(arg);
                const rest = quick ? arg.slice(quick[0].length) : arg;
                const long = /^--(long|relentless|campaign)\s+/.exec(rest);
                const afterLong = long ? rest.slice(long[0].length) : rest;
                const big = /^--big\s+/i.exec(afterLong);
                const cleanArg = big ? afterLong.slice(big[0].length) : afterLong;
                const autonomy = long ? (long[1] === "campaign" ? "campaign" : "relentless") : null;
                const explicitPath = looksLikePath(cleanArg);
                if (explicitPath) {
                  reply = await supervisor.start(sessionID, path.resolve(expandHome(cleanArg)));
                } else if (cleanArg) {
                  reply = await supervisor.planAndStart(sessionID, cleanArg, {
                    autonomy,
                    ...(big ? { big: true } : {}),
                    ...(quick ? { discovery: false } : {}),
                  });
                } else {
                  reply = `Missing objective.\n${HELP}`;
                }
                break;
              }
              case "parallel": {
                reply = await supervisor.startParallel(sessionID, arg);
                break;
              }
              case "queue": {
                const [action, ...queueArgs] = arg.split(/\s+/);
                const priorityToken = queueArgs.find((t) => /^p:-?\d+$/.test(t));
                const priority = priorityToken ? Number(priorityToken.slice(2)) : 0;
                if (action === "list") {
                  const entries = await supervisor.loadQueue();
                  const stats = supervisor.d.queueStats(entries);
                  reply = [
                    `Queue: ${stats.pending} pending · ${stats.running} running · ${stats.done} done · ${stats.failed} failed`,
                    ...supervisor.d
                      .sortQueue(entries)
                      .map(
                        (e) =>
                          `- ${e.id} [${e.status}] p:${e.priority ?? 0} ${String(e.objective).slice(0, 100)}`
                      ),
                  ].join("\n");
                } else if (action === "run") {
                  reply = await supervisor.runQueue(Number(queueArgs[0]) || 0);
                } else if (action === "clear") {
                  await supervisor.saveQueue([]);
                  reply = "Queue cleared.";
                } else {
                  const text = (action ? [action, ...queueArgs] : []).join(" ").trim();
                  reply = await supervisor.enqueueMission(text, priority);
                }
                break;
              }
              case "research": {
                reply = await supervisor.planAndResearch(sessionID, arg);
                break;
              }
              case "pause": {
                reply = await supervisor.pause(sessionID);
                break;
              }
              case "resume": {
                const root = arg || supervisor.rootFor(sessionID) || supervisor.currentDirectory;
                reply = await supervisor.resume(sessionID, root);
                break;
              }
              case "status": {
                const root = supervisor.rootFor(sessionID);
                reply = root
                  ? await supervisor.statusText(root)
                  : "No mission is active in this session.";
                break;
              }
              case "stop":
                reply = await supervisor.stop(sessionID, "manual /mission stop");
                break;
              default:
                reply = `Unknown /mission subcommand: ${sub}\n${HELP}`;
            }
            // On start/resume the queued prompt already begins the turn; adding a
            // synthetic notice there risks two idle boundaries for one command.
            if (sub !== "start" && sub !== "resume" && sub !== "research") {
              await ctx.session
                .synthetic({ sessionID, text: `[mission] ${reply}` })
                .catch(() => {});
            }
          },
        });
      })
    );

    registrations.push(await toolDefinitions(ctx, supervisor));

    registrations.push(
      await ctx.session.hook("context", (event) => {
        supervisor.inject(event);
      })
    );

    registrations.push(
      await ctx.session.hook("experimental.idle", (event) => {
        return supervisor.handleIdle(event.sessionID);
      })
    );

    return async () => {
      supervisor.dispose();
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {});
      }
    };
  },
});
