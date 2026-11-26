import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { runChecks } from "../src/checks.js";
import { normalizePlan } from "../src/planner.js";
import { Supervisor } from "../src/supervisor.js";

const catalog = [
  { providerID: "p", id: "m1", cost: [{ output: 0 }] },
  { providerID: "p", id: "m2", cost: [{ output: 0 }] },
  { providerID: "p", id: "paid", cost: [{ output: 5 }] },
  { providerID: "p", id: "m3", cost: [{ output: 0 }] },
];

test("strict_checks refuses vacuous and dangerous commands before execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-strict-"));
  try {
    await mkdir(path.join(root, ".mission"), { recursive: true });
    const criteria = {
      checks: [
        { id: "vac", cmd: "true", expect: "exit0", timeout_ms: 5000 },
        { id: "danger", cmd: "sudo rm -rf /", expect: "exit0", timeout_ms: 5000 },
        { id: "real", cmd: "node --version", expect: "exit0", timeout_ms: 5000 },
      ],
    };
    const strict = await runChecks(root, criteria, { strict: true, cache: null });
    assert.equal(strict[0].refused, true);
    assert.equal(strict[0].ok, false);
    assert.equal(strict[1].refused, true);
    assert.equal(strict[1].ok, false);
    assert.equal(strict[2].ok, true);
    const loose = await runChecks(root, criteria, { strict: false, cache: null });
    assert.equal(loose[0].ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relentless enables strict_checks by default", () => {
  const result = normalizePlan(
    {
      objective: "o",
      checks: [{ id: "a", cmd: "node --version", expect: "exit0", kind: "e2e" }],
      tasks: [{ id: 1, subject: "Do it", files: ["a.js"], verify: "a", blocked_by: [] }],
      settings: { autonomy: "relentless" },
    },
    "o",
    "/tmp/ws"
  );
  assert.equal(result.ok, true);
  assert.equal(result.plan.settings.strict_checks, true);
});

test("model rotation walks distinct free models and wraps around", () => {
  const sup = new Supervisor({});
  const current = { providerID: "p", id: "m1" };
  assert.deepEqual(
    sup.modelRotationCandidates(catalog, current, []).map((m) => m.id),
    ["m2", "m3"]
  );
  assert.deepEqual(
    sup.modelRotationCandidates(catalog, current, ["p/m2"]).map((m) => m.id),
    ["m3"]
  );
  assert.deepEqual(
    sup.modelRotationCandidates(catalog, current, ["p/m2", "p/m3"]).map((m) => m.id),
    []
  );
  assert.equal(sup.pickFreeModel(catalog, null, ["p/m2"]).id, "m1");
  assert.equal(sup.pickFreeModel(catalog, null, ["p/m1", "p/m2"]).id, "m3");
});
