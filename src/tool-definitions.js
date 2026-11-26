// Mission tool registration, kept out of the plugin entrypoint.

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" };

export function toolDefinitions(ctx, supervisor) {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "mission",
      description: "Mission workspace tools: write files, run the real checks, declare a verdict.",
    });
    editor.add({
      name: "status",
      description:
        "Show the active mission's state: objective progress, checks, tasks, budget and next task.",
      input: obj({}),
      options: { namespace: "mission", codemode: false },
      execute: async (_input, toolCtx) => ({ content: supervisor.toolStatus(toolCtx.sessionID) }),
    });
    editor.add({
      name: "write",
      description:
        "Atomically create or overwrite a file INSIDE the mission workspace. Paths outside the workspace are refused.",
      input: obj({ path: str, content: str }, ["path", "content"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolWrite(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "check",
      description:
        "Run every criterion command with a timeout and return pass/fail with evidence paths. Call this after each change.",
      input: obj({}),
      options: { namespace: "mission", codemode: false },
      execute: async (_input, toolCtx) => ({
        content: await supervisor.toolCheck(toolCtx.sessionID),
      }),
    });
    editor.add({
      name: "verdict",
      description:
        'Declare mission_verdict(status="met"|"blocked", summary, what_would_unblock?). The harness always re-runs the checks; a red check beats a "met" verdict.',
      input: obj({ status: str, summary: str, what_would_unblock: str }, ["status", "summary"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolVerdict(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "report",
      description:
        "Store a stage report (investigator findings or reviewer SEVERITY findings). Read-only roles cannot write files but can report.",
      input: obj({ role: str, text: str }, ["text"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolReport(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "heartbeat",
      description:
        "Renew the lease of your assigned task while you work, so it is not reclaimed as silent.",
      input: obj({ id: { type: "integer" } }),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolHeartbeat(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "fact",
      description:
        "Store a durable fact (kind, subject, text) that survives context compaction and appears in every brief.",
      input: obj({ kind: str, subject: str, text: str }, ["subject", "text"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolFact(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "log",
      description:
        "Append a short note to the mission journal so the next context window knows what you tried.",
      input: obj({ text: str }, ["text"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolLog(toolCtx.sessionID, input),
      }),
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
        ["summary"]
      ),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolTaskDone(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "spawn",
      description:
        "Lead tool: create an independently verifiable task and dispatch a subagent for it. Files must be disjoint from active tasks; completion is always checked by the harness.",
      input: obj(
        {
          subject: str,
          files: { type: "array", items: str },
          verify: str,
          prompt: str,
        },
        ["subject"]
      ),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolSpawn(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "web_search",
      description:
        "Search the web. Returns titled results with URLs and snippets. Use citation URLs in reports.",
      input: obj({ query: str, limit: { type: "integer" } }, ["query"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolWebSearch(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "web_fetch",
      description:
        "Fetch a public http/https page and return clean text. Private/localhost addresses are refused.",
      input: obj({ url: str, max_chars: { type: "integer" }, save: { type: "boolean" } }, ["url"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolWebFetch(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "image_search",
      description:
        "Search for images (Openverse/Wikimedia) with license and attribution. Optionally download them into research/images/.",
      input: obj({ query: str, limit: { type: "integer" }, download: { type: "boolean" } }, [
        "query",
      ]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolImageSearch(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "image_generate",
      description:
        "Generate an image with OpenCode's image model, if one is configured. Saved into research/images/.",
      input: obj({ prompt: str, name: str, aspect: str, n: { type: "integer" } }, ["prompt"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolImageGenerate(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "research",
      description:
        "Deep research: search, fetch top sources, search images, then write research/report.md with citations.",
      input: obj({ question: str, depth: str, images: { type: "boolean" } }, ["question"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolResearch(toolCtx.sessionID, input),
      }),
    });
    editor.add({
      name: "research_note",
      description:
        "Save a research artifact under research/ without touching code files. Read-only roles may use this.",
      input: obj({ title: str, content: str }, ["content"]),
      options: { namespace: "mission", codemode: false },
      execute: async (input, toolCtx) => ({
        content: await supervisor.toolResearchNote(toolCtx.sessionID, input),
      }),
    });
  });
}
