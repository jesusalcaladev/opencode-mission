// Research mode: web search, safe page fetch, image search/download/generation.
// No third-party dependencies; all network access goes through fetch with hard
// timeouts and an SSRF guard. Deterministic parsers are unit-testable.

import { lookup } from "node:dns/promises";

const UA = "opencode-mission/0.3 (+research)";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;
export const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "’",
};

export function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|rsquo);/g, (m) => ENTITIES[m] ?? m);
}

export function isPrivateIP(ip) {
  const value = ip.toLowerCase();
  if (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80")
  )
    return true;
  const v4 = value.replace(/^::ffff:/, "");
  if (!v4.includes(".")) return false;
  const parts = v4.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export async function assertSafeUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("only http/https URLs are allowed");
  if (url.username || url.password) throw new Error("credentials in URL are not allowed");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    throw new Error("private host is not allowed");
  let addresses = [];
  try {
    const result = await lookup(host, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    throw new Error("host could not be resolved");
  }
  if (addresses.length === 0 || addresses.some((ip) => isPrivateIP(ip)))
    throw new Error("private or reserved address is not allowed");
  return url;
}

export async function safeFetch(
  url,
  { timeout = DEFAULT_TIMEOUT, headers = {}, fetchImpl = fetch } = {}
) {
  const signal = AbortSignal.timeout(timeout);
  const response = await fetchImpl(url, {
    signal,
    redirect: "follow",
    headers: { "user-agent": UA, "accept-language": "en,es;q=0.8", ...headers },
  });
  return response;
}

export function stripTags(html) {
  let text = String(html ?? "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n\n${"#".repeat(Number(n) || 1)} `);
  text = text.replace(/<\/(h[1-6]|p|div|li|tr|section|article)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "\n- ");
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi, (_m, href) => ` [${href}] `);
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function metaContent(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
      "i"
    );
    const m = re.exec(html);
    if (m?.[1]) return decodeEntities(m[1]);
  }
  return "";
}

export function extractPage(html, url, maxChars = 12_000) {
  const source = String(html ?? "");
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] ?? "").trim();
  const description = metaContent(source, ["description", "og:description"]);
  const image = metaContent(source, ["og:image", "twitter:image"]);
  return {
    url,
    title: decodeEntities(title),
    description,
    image,
    text: stripTags(source).slice(0, maxChars),
  };
}

export async function fetchPage(rawUrl, options = {}) {
  const url = await assertSafeUrl(rawUrl, options);
  const response = await safeFetch(url.toString(), options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PAGE_BYTES) throw new Error("page is too large");
  const html = new TextDecoder().decode(buffer.slice(0, MAX_PAGE_BYTES));
  return extractPage(html, url.toString(), options.maxChars);
}
