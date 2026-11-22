import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { Supervisor } from "../src/supervisor.js";
import { ensureMission } from "../src/mission.js";

function ctx(searchResults = []) {
  return {
    storage: { get: async () => [], set: async () => {} },
    session: {
      prompt: async () => {},
      context: async () => [],
      synthetic: async () => {},
      create: async () => ({ id: "w" }),
      get: async ({ sessionID }) => ({ id: sessionID, time: {} }),
      wait: async () => {},
      switchModel: async () => {},
    },
    model: { list: async () => [], default: async () => null },
    event: { subscribe: async function* () {} },
    location: { directory: "/tmp" },
    websearch: { query: async () => ({ data: { results: searchResults } }) },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mission-research-tools-"));
  await ensureMission(root, { id: "rt" });
  return root;
}

test("research tools: image search without download", async () => {
  const root = await fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [{ url: "https://i.dev/a.png", title: "A", license: "CC0" }] }),
  });
  try {
    const sup = new Supervisor(ctx());
    await sup.start("lead", root);
    const text = await sup.toolImageSearch("lead", { query: "engine", limit: 2 });
    assert.match(text, /1 image/);
    assert.match(await readFile(path.join(root, "research", "sources.json"), "utf8"), /CC0/);
    sup.dispose();
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("research tools: orchestrated research writes a report", async () => {
  const root = await fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [] }),
  });
  try {
    const sup = new Supervisor(ctx([]));
    await sup.start("lead", root);
    const text = await sup.toolResearch("lead", { question: "ecs engines", images: true });
    assert.match(text, /Research saved/);
    assert.match(
      await readFile(path.join(root, "research", "report.md"), "utf8"),
      /## Recommendation/
    );
    sup.dispose();
  } finally {
    globalThis.fetch = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("research tools: image generation without a model fails cleanly", async () => {
  const root = await fixture();
  try {
    const sup = new Supervisor(ctx());
    await sup.start("lead", root);
    const text = await sup.toolImageGenerate("lead", { prompt: "a sprite" });
    assert.match(text, /no image model configured/);
    sup.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
