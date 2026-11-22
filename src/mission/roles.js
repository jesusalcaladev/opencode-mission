// Role pipeline — pure rules for specialized agents sharing one workspace.
// No worktrees: the harness controls WHO may write and WHEN completion is legal.
// Pure: no IO, no model, no OpenCode.

export const ROLE = Object.freeze({
  INVESTIGATOR: "investigator",
  RESEARCHER: "researcher",
  IMPLEMENTER: "implementer",
  TESTER: "tester",
  INTEGRATOR: "integrator",
  REVIEWER: "reviewer",
  GOAL_AUDITOR: "goal-auditor",
});

export const STAGE = Object.freeze({
  INVESTIGATE: "investigate",
  IMPLEMENT: "implement",
  INTEGRATE: "integrate",
  VERIFY: "verify",
  REVIEW: "review",
  GOAL_AUDIT: "goal-audit",
  DONE: "done",
});

export const CAN_WRITE = Object.freeze({
  [ROLE.INVESTIGATOR]: false,
  [ROLE.RESEARCHER]: false,
  [ROLE.IMPLEMENTER]: true,
  [ROLE.TESTER]: false,
  [ROLE.INTEGRATOR]: true,
  [ROLE.REVIEWER]: false,
  [ROLE.GOAL_AUDITOR]: false,
});

export const MAX_REVIEW_ATTEMPTS = 2;

export function canWrite(role) {
  return CAN_WRITE[role] === true;
}

export function parseReview(text) {
  const findings = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const match = /\bSEVERITY\s*:\s*(high|medium|low)\b/i.exec(raw);
    if (!match) continue;
    findings.push({ severity: match[1].toLowerCase(), line: raw.trim() });
  }
  const high = findings.filter((f) => f.severity === "high");
  return {
    findings,
    high,
    ok: high.length === 0,
    summary: findings.map((f) => f.line).join("\n") || "No SEVERITY findings.",
  };
}

export function stageFor({
  stage,
  tasksDone,
  review,
  reviewAttempts = 0,
  goalAudit = false,
  goalAuditDone = false,
  extended = false,
}) {
  if (stage === STAGE.DONE) return { stage: STAGE.DONE, decision: "complete" };
  if (!tasksDone) return { stage: STAGE.IMPLEMENT, decision: "continue" };
  if (!extended) {
    if (stage !== STAGE.REVIEW) return { stage: STAGE.REVIEW, decision: "continue" };
    if (review?.ok) return { stage: STAGE.DONE, decision: "complete" };
    if (reviewAttempts < MAX_REVIEW_ATTEMPTS) return { stage: STAGE.IMPLEMENT, decision: "retry" };
    return { stage: STAGE.REVIEW, decision: "blocked", reason: "review: unresolved high severity" };
  }
  if (stage === STAGE.INVESTIGATE) return { stage: STAGE.IMPLEMENT, decision: "continue" };
  if (stage === STAGE.IMPLEMENT) return { stage: STAGE.INTEGRATE, decision: "continue" };
  if (stage === STAGE.INTEGRATE) return { stage: STAGE.VERIFY, decision: "continue" };
  if (stage === STAGE.VERIFY) return { stage: STAGE.REVIEW, decision: "continue" };
  if (stage !== STAGE.REVIEW && stage !== STAGE.GOAL_AUDIT)
    return { stage: STAGE.REVIEW, decision: "continue" };
  if (review && review.ok === false && reviewAttempts < MAX_REVIEW_ATTEMPTS) {
    return { stage: STAGE.IMPLEMENT, decision: "retry" };
  }
  if (review && review.ok === false) {
    return { stage: STAGE.REVIEW, decision: "blocked", reason: "review: unresolved high severity" };
  }
  if (goalAudit && !goalAuditDone) return { stage: STAGE.GOAL_AUDIT, decision: "continue" };
  return { stage: STAGE.DONE, decision: "complete" };
}

export function parseGaps(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const match = /\bGAP\s*:\s*(.+)$/i.exec(raw);
    if (!match) continue;
    const body = match[1].trim();
    const field = (name) => {
      const m = new RegExp(`\\b${name}\\s*=\\s*([^\\s,;]+)`, "i").exec(body);
      return m ? m[1] : "";
    };
    out.push({
      requirement: field("requirement"),
      check: field("check"),
      cmd: field("cmd"),
      files: field("files")
        .split(/[,|]/)
        .map((f) => f.trim())
        .filter(Boolean),
      text: body.replace(/\b(requirement|check|cmd|files)\s*=\s*[^\s,;]+\s*/gi, "").trim(),
    });
  }
  return out;
}

/// Two independent reviews: a high finding only stays high if both reviewers
/// agree. A lone high is downgraded to medium and recorded as a fact instead.
export function combineReviews(first = "", second = "") {
  const a = parseReview(first);
  const b = parseReview(second);
  const text = `${first}\n${second}`.trim();
  if (a.high.length > 0 === b.high.length > 0) return text;
  return text.replace(/SEVERITY:\s*high/gi, "SEVERITY: medium");
}

export function roleForStage(stage) {
  switch (stage) {
    case STAGE.INVESTIGATE:
      return ROLE.INVESTIGATOR;
    case STAGE.REVIEW:
      return ROLE.REVIEWER;
    case STAGE.GOAL_AUDIT:
      return ROLE.GOAL_AUDITOR;
    case STAGE.VERIFY:
      return ROLE.TESTER;
    case STAGE.INTEGRATE:
      return ROLE.INTEGRATOR;
    default:
      return ROLE.IMPLEMENTER;
  }
}
