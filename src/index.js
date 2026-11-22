// OpenCode plugin entrypoint: /mission commands, mission_* tools, and the two hooks
// that make the supervisor autonomous (context injection + idle continuation).

import { Plugin } from "@opencode/plugin";
import { existsSync } from "node:fs";
import path from "node:path";
import { Supervisor } from "./supervisor.js";

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" };

const HELP = [
  "/mission start <what to do>   Plan the objective, then run it autonomously with parallel workers",
  "/mission start <dir>          Start a pre-authored mission in an existing directory",
  "/mission status        Show state, checks and next task",
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
  return v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || existsSync(path.resolve(v));
}

export default Plugin.define({
  id: "mission",
  async setup(ctx) {
    const supervisor = new Supervisor(ctx, {
      model: ctx.options?.model,
      fallbackModel: ctx.options?.fallbackModel,
      notifyUrl: ctx.options?.notifyUrl,
      plannerModel: ctx.options?.plannerModel,
      maxWorkers: ctx.options?.maxWorkers,
      missionsRoot: ctx.options?.missionsRoot,
      enableWorkers: ctx.options?.enableWorkers,
      enableChaining: ctx.options?.enableChaining,
      rescueIntervalMs: ctx.options?.rescueIntervalMs,
      generate: async ({ prompt, model }) => {
        const out = await ctx.experimental.generate.text({ prompt, model });
        return typeof out === "string" ? out : (out?.text ?? out?.data?.text ?? "");
      },
    });
    await supervisor.init();
    supervisor.startEventRecovery();
    supervisor.startRescueTimer();
    const registrations = [];

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
                const explicitPath = looksLikePath(arg);
                if (explicitPath) {
                  reply = await supervisor.start(sessionID, path.resolve(expandHome(arg)));
                } else if (arg) {
                  reply = await supervisor.planAndStart(sessionID, arg);
                } else {
                  reply = `Missing objective.\n${HELP}`;
                }
                break;
              }
              case "resume": {
                const root = arg || supervisor.rootFor(sessionID) || ctx.location.directory;
                reply = await supervisor.resume(sessionID, root);
                break;
              }
              case "status": {
                const root = supervisor.rootFor(sessionID);
                reply = root ? await supervisor.statusText(root) : "No mission is active in this session.";
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
            if (sub !== "start" && sub !== "resume") {
              await ctx.session.synthetic({ sessionID, text: `[mission] ${reply}` }).catch(() => {});
            }
          },
        });
      }),
    );

    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.namespace({
          name: "mission",
          description: "Mission workspace tools: write files, run the real checks, declare a verdict.",
        });
        editor.add({
          name: "status",
          description: "Show the active mission's state: objective progress, checks, tasks, budget and next task.",
          input: obj({}),
          options: { namespace: "mission", codemode: false },
          execute: async (_input, toolCtx) => ({ content: supervisor.toolStatus(toolCtx.sessionID) }),
        });
        editor.add({
          name: "write",
          description: "Atomically create or overwrite a file INSIDE the mission workspace. Paths outside the workspace are refused.",
          input: obj({ path: str, content: str }, ["path", "content"]),
          options: { namespace: "mission", codemode: false },
          execute: async (input, toolCtx) => ({ content: await supervisor.toolWrite(toolCtx.sessionID, input) }),
        });
        editor.add({
          name: "check",
          description: "Run every criterion command with a timeout and return pass/fail with evidence paths. Call this after each change.",
          input: obj({}),
          options: { namespace: "mission", codemode: false },
          execute: async (_input, toolCtx) => ({ content: await supervisor.toolCheck(toolCtx.sessionID) }),
        });
        editor.add({
          name: "verdict",
          description:
            'Declare mission_verdict(status="met"|"blocked", summary, what_would_unblock?). The harness always re-runs the checks; a red check beats a "met" verdict.',
          input: obj(
            { status: str, summary: str, what_would_unblock: str },
            ["status", "summary"],
          ),
          options: { namespace: "mission", codemode: false },
          execute: async (input, toolCtx) => ({ content: await supervisor.toolVerdict(toolCtx.sessionID, input) }),
        });
        editor.add({
          name: "heartbeat",
          description: "Renew the lease of your assigned task while you work, so it is not reclaimed as silent.",
          input: obj({ id: { type: "integer" } }),
          options: { namespace: "mission", codemode: false },
          execute: async (input, toolCtx) => ({ content: await supervisor.toolHeartbeat(toolCtx.sessionID, input) }),
        });
        editor.add({
          name: "log",
          description: "Append a short note to the mission journal so the next context window knows what you tried.",
          input: obj({ text: str }, ["text"]),
          options: { namespace: "mission", codemode: false },
          execute: async (input, toolCtx) => ({ content: await supervisor.toolLog(toolCtx.sessionID, input) }),
        });
        editor.add({
          name: "task_done",
          description:
            "Worker tool: report that your assigned task is finished. The lead still verifies the task's check before marking it complete.",
          input: obj(
            {
              id: { type: "integer" },
              status: { type: "string", enum: ["done", "failed"] },
              summary: str,
              evidence: { type: "array", items: str },
            },
            ["summary"],
          ),
          options: { namespace: "mission", codemode: false },
          execute: async (input, toolCtx) => ({ content: await supervisor.toolTaskDone(toolCtx.sessionID, input) }),
        });
      }),
    );

    registrations.push(
      await ctx.session.hook("context", (event) => {
        supervisor.inject(event);
      }),
    );

    registrations.push(
      await ctx.session.hook("experimental.idle", (event) => {
        return supervisor.handleIdle(event.sessionID);
      }),
    );

    return async () => {
      supervisor.dispose();
      for (const registration of registrations.reverse()) {
        await registration.dispose().catch(() => {});
      }
    };
  },
});
