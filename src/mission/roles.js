// Role pipeline — pure rules for specialized agents sharing one workspace.
// No worktrees: the harness controls WHO may write and WHEN completion is legal.
// Pure: no IO, no model, no OpenCode.

export const ROLE = Object.freeze({
  INVESTIGATOR: "investigator",
  IMPLEMENTER: "implementer",
  TESTER: "tester",
  REVIEWER: "reviewer",
});

export const STAGE = Object.freeze({
  INVESTIGATE: "investigate",
  IMPLEMENT: "implement",
  VERIFY: "verify",
  REVIEW: "review",
  DONE: "done",
});

export const CAN_WRITE = Object.freeze({
  [ROLE.INVESTIGATOR]: false,
  [ROLE.IMPLEMENTER]: true,
  [ROLE.TESTER]: false,
  [ROLE.REVIEWER]: false,
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

export function stageFor({ stage, tasksDone, review, reviewAttempts = 0 }) {
  if (stage === STAGE.DONE) return { stage: STAGE.DONE, decision: "complete" };
  if (!tasksDone) return { stage: STAGE.IMPLEMENT, decision: "continue" };
  if (stage !== STAGE.REVIEW) return { stage: STAGE.REVIEW, decision: "continue" };
  if (review?.ok) return { stage: STAGE.DONE, decision: "complete" };
  if (reviewAttempts < MAX_REVIEW_ATTEMPTS) return { stage: STAGE.IMPLEMENT, decision: "retry" };
  return { stage: STAGE.REVIEW, decision: "blocked", reason: "review: unresolved high severity" };
}

export function roleForStage(stage) {
  switch (stage) {
    case STAGE.INVESTIGATE: return ROLE.INVESTIGATOR;
    case STAGE.REVIEW: return ROLE.REVIEWER;
    case STAGE.VERIFY: return ROLE.TESTER;
    default: return ROLE.IMPLEMENTER;
  }
}
