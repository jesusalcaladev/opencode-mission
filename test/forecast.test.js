import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { forecastBudget } from "../src/mission/forecast.js";
import { loadMission } from "../src/tui/model.js";
import { loadTuiModel } from "../src/tui/model.js";

test("forecastBudget derives rates from durable telemetry", () => {
  const now = 1_000_000;
  const forecast = forecastBudget(
    {
      turn: 10,
      cost_usd: 2,
      tokens: 5000,
      max_turns: 20,
      hard_budget_usd: 3,
      max_tokens: 20000,
      started_at: new Date(now - 600_000).toISOString(),
      history: Array.from({ length: 7 }, () => ({ turn: 1 })),
    },
    now
  );
  assert.equal(forecast.per_turn_cost_usd, 0.2);
  assert.equal(forecast.per_turn_tokens, 500);
  assert.equal(forecast.forecast_cost_usd, 4);
  assert.equal(forecast.forecast_tokens, 10000);
  assert.equal(forecast.confidence, "medium");
  assert.equal(forecast.over_hard_budget, true);
  assert.equal(forecast.over_token_budget, false);
  const empty = forecastBudget({ turn: 0, max_turns: 0 }, now);
  assert.equal(empty.confidence, "none");
  assert.equal(empty.forecast_cost_usd, 0);
  assert.equal(empty.remaining_turns, null);
});

async function fixture(base) {
  const root = path.join(base, "mission-forecast");
  const dir = path.join(root, ".mission");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({
      status: "running",
      turn: 4,
      cost_usd: 1,
      tokens: 2000,
      max_tokens: 10000,
      max_turns: 8,
      hard_budget_usd: 5,
      started_at: new Date(Date.now() - 120_000).toISOString(),
      history: [{}, {}, {}],
    }),
    "utf8"
  );
  await writeFile(path.join(dir, "criteria.json"), '{"checks":[]}', "utf8");
  await writeFile(path.join(dir, "tasks.json"), '{"tasks":[]}', "utf8");
  await writeFile(path.join(dir, "mission.md"), "---\n---\nForecast test", "utf8");
  return root;
}

test("TUI read model exposes tokens, forecast and the mission queue", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "mission-forecast-tui-"));
  try {
    const root = await fixture(base);
    await writeFile(
      path.join(base, "mission-queue.json"),
      JSON.stringify([{ id: "q1", objective: "Write docs", priority: 5, status: "pending" }]),
      "utf8"
    );
    const snapshot = await loadMission(root);
    assert.equal(snapshot.tokens, 2000);
    assert.equal(snapshot.max_tokens, 10000);
    assert.equal(snapshot.token_pct, 20);
    assert.equal(snapshot.forecast_cost_usd, 2);
    assert.equal(snapshot.forecast_confidence, "low");
    const model = await loadTuiModel({ missionsRoot: base, maxMissions: 30 });
    assert.equal(model.queue.length, 1);
    assert.equal(model.queue[0].objective, "Write docs");
    assert.ok(
      model.missions.some((m) => m.root === root),
      JSON.stringify(model.missions)
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
