import test from "node:test";
import assert from "node:assert/strict";
import {
  duckDuckGoProvider,
  braveProvider,
  serperProvider,
  tavilyProvider,
  parseOpenverse,
  parseWikimedia,
  extractPage,
  buildReport,
  saveResearch,
} from "../src/research.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

async function withFetch(fn, body, ok = true) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    text: async () => body,
    json: async () => JSON.parse(body),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    headers: { get: () => "text/html" },
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("research providers: DuckDuckGo parses HTML results", async () => {
  const html =
    '<a class="result__a" href="https://x.dev/a">A</a><a class="result__snippet">snippet</a>';
  const results = await withFetch(() => duckDuckGoProvider.execute({ query: "x" }, {}), html);
  assert.equal(results[0].url, "https://x.dev/a");
  assert.equal(results[0].content, "snippet");
});

test("research providers: Brave, Serper and Tavily normalize results", async () => {
  const brave = await withFetch(
    () => braveProvider("key").execute({ query: "x" }, {}),
    JSON.stringify({ web: { results: [{ url: "u1", title: "t1", description: "d1" }] } })
  );
  assert.equal(brave[0].url, "u1");
  const serper = await withFetch(
    () => serperProvider("key").execute({ query: "x" }, {}),
    JSON.stringify({ organic: [{ link: "u2", title: "t2", snippet: "d2" }] })
  );
  assert.equal(serper[0].url, "u2");
  const tavily = await withFetch(
    () => tavilyProvider("key").execute({ query: "x" }, {}),
    JSON.stringify({ results: [{ url: "u3", title: "t3", content: "d3" }] })
  );
  assert.equal(tavily[0].url, "u3");
});

test("research images: Openverse and Wikimedia parsers", () => {
  const openverse = parseOpenverse(
    { results: [{ url: "https://i.dev/a.png", title: "A", license: "CC0" }] },
    5
  );
  assert.equal(openverse[0].license, "CC0");
  const wiki = parseWikimedia(
    {
      query: {
        pages: {
          p1: {
            title: "File:A.png",
            imageinfo: [
              { url: "https://w.dev/a.png", extmetadata: { LicenseShortName: { value: "CC BY" } } },
            ],
          },
        },
      },
    },
    5
  );
  assert.equal(wiki[0].source, "wikimedia");
});

test("research report: extractPage handles missing metadata and saveResearch writes files", async () => {
  const page = extractPage("<html><body><p>plain text</p></body></html>", "https://x.dev");
  assert.equal(page.title, "");
  assert.match(page.text, /plain text/);
  const root = await mkdtemp(path.join(os.tmpdir(), "research-extra-"));
  try {
    const saved = await saveResearch(root, {
      report: buildReport("q", { results: [] }),
      sources: [],
      images: [],
    });
    assert.match(await readFile(saved.report, "utf8"), /## Findings/);
    assert.match(await readFile(saved.sources, "utf8"), /sources/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
