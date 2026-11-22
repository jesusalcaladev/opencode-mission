import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeUrl,
  buildReport,
  decodeEntities,
  extractPage,
  parseDuckDuckGo,
  researchPlan,
} from "../src/research.js";

test("research: decodeEntities handles numeric and named entities", () => {
  assert.equal(decodeEntities("a &amp; b &#x2014; c &lt;d&gt;"), "a & b — c <d>");
});

test("research: extractPage strips scripts and keeps headings", () => {
  const html = `<html><head><title>Hello</title><meta name="description" content="Desc"></head>
    <body><script>bad()</script><h1>Title</h1><p>A <a href="https://x.dev">link</a>.</p></body></html>`;
  const page = extractPage(html, "https://x.dev");
  assert.equal(page.title, "Hello");
  assert.equal(page.description, "Desc");
  assert.match(page.text, /# Title/);
  assert.doesNotMatch(page.text, /bad\(\)/);
});

test("research: parseDuckDuckGo decodes redirect URLs", () => {
  const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">One</a>
    <a class="result__snippet">Snippet one</a>
    <a class="result__a" href="https://two.dev">Two</a>`;
  const results = parseDuckDuckGo(html, 5);
  assert.equal(results[0].url, "https://example.com/a");
  assert.equal(results[0].title, "One");
  assert.equal(results[1].url, "https://two.dev");
});

test("research: assertSafeUrl blocks private and non-http targets", async () => {
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1:8080"), /private or reserved/);
  await assert.rejects(() => assertSafeUrl("http://localhost"), /private host/);
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"), /only http\/https/);
  await assert.rejects(() => assertSafeUrl("not a url"), /invalid URL/);
});

test("research: buildReport includes all sections", () => {
  const report = buildReport("Best ECS?", {
    results: [{ url: "https://a.dev", title: "A", content: "A says" }],
    pages: [{ url: "https://a.dev", title: "A", text: "body", description: "desc" }],
    images: [{ title: "img", url: "https://a.dev/i.png" }],
  });
  for (const section of [
    "## Findings",
    "## Sources",
    "## Images",
    "## Recommendation",
    "## Open Questions",
  ]) {
    assert.match(report, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("research: researchPlan has executable checks and requirements", () => {
  const plan = researchPlan("compare ECS libraries", "/tmp/x");
  assert.ok(plan.checks.length >= 4);
  assert.equal(plan.requirements.length, 3);
  assert.equal(plan.needs_research, true);
  assert.ok(plan.checks.some((c) => c.id === "images"));
});
