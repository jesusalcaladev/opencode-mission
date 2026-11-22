/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// Research mode: web search, safe page fetch, image search/download/generation.
// No third-party dependencies; all network access goes through fetch with hard
// timeouts and an SSRF guard. Deterministic parsers are unit-testable.

import path from "node:path";
import { decodeEntities, stripTags } from "./text.js";

const UA = "opencode-mission/0.3 (+research)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;
const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 200;

async function cached(key, ttl, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  CACHE.set(key, { at: Date.now(), value });
  if (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value);
  return value;
}

export function parseDuckDuckGo(html, limit = 8) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let m;
  while ((m = snippetRe.exec(html)) && snippets.length < 40) snippets.push(stripTags(m[1]));
  let index = 0;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = decodeEntities(m[1]);
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push({ url, title: stripTags(m[2]), content: snippets[index] ?? "", time: {} });
    index += 1;
  }
  return out;
}

export const duckDuckGoProvider = {
  id: "mission-duckduckgo",
  name: "DuckDuckGo",
  async execute({ query }, { signal } = {}) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query ?? ""))}`;
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT),
      headers: { "user-agent": UA },
    });
    if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
    return parseDuckDuckGo(await response.text(), 8);
  },
};

export function braveProvider(apiKey) {
  return {
    id: "mission-brave",
    name: "Brave Search",
    async execute({ query }, { signal } = {}) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(query ?? ""))}&count=8`;
      const response = await fetch(url, {
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT),
        headers: { "user-agent": UA, "x-subscription-token": apiKey, accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Brave HTTP ${response.status}`);
      const data = await response.json();
      return (data?.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        content: r.description,
        time: {},
      }));
    },
  };
}

export function serperProvider(apiKey) {
  return {
    id: "mission-serper",
    name: "Serper",
    async execute({ query }, { signal } = {}) {
      const response = await fetch("https://google.serper.dev/search", {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT),
        headers: { "user-agent": UA, "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ q: String(query ?? ""), num: 8 }),
      });
      if (!response.ok) throw new Error(`Serper HTTP ${response.status}`);
      const data = await response.json();
      return (data?.organic ?? []).map((r) => ({
        url: r.link,
        title: r.title,
        content: r.snippet,
        time: {},
      }));
    },
  };
}

export function tavilyProvider(apiKey) {
  return {
    id: "mission-tavily",
    name: "Tavily",
    async execute({ query }, { signal } = {}) {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT),
        headers: { "user-agent": UA, "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, query: String(query ?? ""), max_results: 8 }),
      });
      if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
      const data = await response.json();
      return (data?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        content: r.content,
        time: {},
      }));
    },
  };
}

export async function webSearch(ctx, query, limit = 8) {
  const q = String(query ?? "");
  const key = `search:${q}:${limit}`;
  return cached(key, CACHE_TTL, async () => {
    if (ctx?.websearch?.query) {
      const res = await ctx.websearch.query({
        query: q,
        ...(ctx?.location ? { location: ctx.location } : {}),
      });
      return (res?.data?.results ?? []).slice(0, limit).map((r) => ({
        url: String(r.url ?? ""),
        title: String(r.title ?? ""),
        content: String(r.content ?? ""),
        time: r.time ?? {},
      }));
    }
    return duckDuckGoProvider.execute({ query: q }, {});
  });
}
