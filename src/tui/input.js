// Parsing for the `/mission-start <objective>` slash command.
// Pure and testable: no OpenTUI, no Solid, no client.

const START_TOKENS = /^\/(?:mission-start|missionstart|mission-new)\b\s*/i;
const SERVER_FORM = /^mission\s+start\b\s*/i;

/**
 * Extracts the objective from the raw input OpenCode hands to `run(input)`.
 *
 * With `slash.arguments: true` OpenCode passes the raw prompt line, which may
 * or may not still contain the command token. Both spellings are accepted so
 * the slash form and the server form behave identically:
 *
 *   parseStartInput("build a CLI")                  -> "build a CLI"
 *   parseStartInput("/mission-start build a CLI")   -> "build a CLI"
 *   parseStartInput("mission start build a CLI")    -> "build a CLI"
 *   parseStartInput("   ")                          -> ""
 */
export function parseStartInput(input) {
  let text = typeof input === "string" ? input : "";
  text = text.trim();
  if (!text) return "";
  text = text.replace(START_TOKENS, "").trim();
  text = text.replace(SERVER_FORM, "").trim();
  return text;
}
