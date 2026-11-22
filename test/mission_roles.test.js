import test from "node:test";
import assert from "node:assert/strict";
import { ROLE, STAGE, canWrite, parseReview, stageFor, roleForStage, MAX_REVIEW_ATTEMPTS } from "../src/mission/roles.js";

test("roles: only implementers may write", () => {
  assert.equal(canWrite(ROLE.IMPLEMENTER), true);
  assert.equal(canWrite(ROLE.INVESTIGATOR), false);
  assert.equal(canWrite(ROLE.REVIEWER), false);
  assert.equal(canWrite(ROLE.TESTER), false);
});

test("review: a high severity finding blocks completion", () => {
  const text = "checked cli.js\nSEVERITY: high — secrets are logged\nSEVERITY: low — naming could be better";
  const review = parseReview(text);
  assert.equal(review.ok, false);
  assert.equal(review.high.length, 1);
  const clean = parseReview("looks good\nSEVERITY: low — minor style");
  assert.equal(clean.ok, true);
});

test("pipeline: review is required before complete, and can retry", () => {
  assert.deepEqual(stageFor({ stage: STAGE.IMPLEMENT, tasksDone: false }), { stage: STAGE.IMPLEMENT, decision: "continue" });
  assert.deepEqual(stageFor({ stage: STAGE.IMPLEMENT, tasksDone: true }), { stage: STAGE.REVIEW, decision: "continue" });
  const bad = parseReview("SEVERITY: high — broken");
  assert.equal(stageFor({ stage: STAGE.REVIEW, tasksDone: true, review: bad, reviewAttempts: 0 }).decision, "retry");
  assert.equal(stageFor({ stage: STAGE.REVIEW, tasksDone: true, review: bad, reviewAttempts: MAX_REVIEW_ATTEMPTS }).decision, "blocked");
  assert.equal(stageFor({ stage: STAGE.REVIEW, tasksDone: true, review: parseReview("SEVERITY: low — ok") }).decision, "complete");
});

test("pipeline: stage to role mapping", () => {
  assert.equal(roleForStage(STAGE.INVESTIGATE), ROLE.INVESTIGATOR);
  assert.equal(roleForStage(STAGE.REVIEW), ROLE.REVIEWER);
  assert.equal(roleForStage(STAGE.IMPLEMENT), ROLE.IMPLEMENTER);
});
