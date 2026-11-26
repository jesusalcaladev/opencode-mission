// Research mode: web search, safe page fetch, image search/download/generation.
// No third-party dependencies; all network access goes through fetch with hard
// timeouts and an SSRF guard. Deterministic parsers are unit-testable.

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertSafeUrl, safeFetch } from "./text.js";

// Local cache with the same semantics as search.js. Kept local so Bun's plugin
// loader does not need a cross-module named import for this helper.
const IMAGE_CACHE = new Map();
async function cached(key, ttl, fn) {
  const hit = IMAGE_CACHE.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  IMAGE_CACHE.set(key, { at: Date.now(), value });
  if (IMAGE_CACHE.size > 200) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
  return value;
}

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CACHE_TTL = 24 * 60 * 60 * 1000;

export function parseOpenverse(data, limit) {
  return (data?.results ?? []).slice(0, limit).map((r) => ({
    url: String(r.url ?? ""),
    thumbnail: String(r.thumbnail ?? ""),
    title: String(r.title ?? r.name ?? "image"),
    creator: String(r.creator ?? ""),
    license: String(r.license ?? ""),
    source: "openverse",
    foreign_landing_url: String(r.foreign_landing_url ?? ""),
  }));
}

export function parseWikimedia(data, limit) {
  const pages = Object.values(data?.query?.pages ?? {});
  const out = [];
  for (const page of pages) {
    const info = page?.imageinfo?.[0];
    if (!info?.url) continue;
    const meta = info.extmetadata ?? {};
    out.push({
      url: String(info.url),
      thumbnail: String(info.thumburl ?? info.url),
      title: String(page.title ?? "image"),
      creator: String(meta.Artist?.value ?? "").replace(/<[^>]+>/g, ""),
      license: String(meta.LicenseShortName?.value ?? ""),
      source: "wikimedia",
      foreign_landing_url: String(info.descriptionurl ?? ""),
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function imageSearch(query, { limit = 6, fetchImpl = fetch } = {}) {
  return cached(`images:${query}:${limit}`, CACHE_TTL, () =>
    imageSearchUncached(query, { limit, fetchImpl })
  );
}

export async function imageSearchUncached(query, { limit = 6, fetchImpl = fetch } = {}) {
  const q = encodeURIComponent(String(query ?? ""));
  const openverse = `https://api.openverse.org/v1/images/?q=${q}&page_size=${Math.min(20, limit)}`;
  try {
    const res = await safeFetch(openverse, { fetchImpl });
    if (res.ok) {
      const parsed = parseOpenverse(await res.json(), limit);
      if (parsed.length) return parsed;
    }
  } catch {
    // Fall back to Wikimedia.
  }
  const wiki = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrnamespace=6&gsrlimit=${Math.min(20, limit)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=400&format=json`;
  const res = await safeFetch(wiki, { fetchImpl });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
  return parseWikimedia(await res.json(), limit);
}

export async function downloadImage(rawUrl, workspace, { name, fetchImpl = fetch } = {}) {
  const url = await assertSafeUrl(rawUrl);
  const response = await safeFetch(url.toString(), { fetchImpl, timeout: 30_000 });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error("image is too large");
  const mime = String(response.headers.get?.("content-type") ?? "");
  if (!mime.startsWith("image/")) throw new Error("URL did not return an image");
  const ext =
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[
      mime.split(";")[0]
    ] ?? "img";
  const base = String(
    name ?? createHash("sha256").update(url.toString()).digest("hex").slice(0, 12)
  )
    .replace(/[^a-z0-9_-]+/gi, "-")
    .slice(0, 80);
  const dir = path.join(workspace, "research", "images");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${base}.${ext}`);
  await writeFile(file, buffer);
  return {
    path: path.relative(workspace, file),
    bytes: buffer.byteLength,
    mime,
    url: url.toString(),
  };
}

export async function generateImage(ctx, prompt, { name, aspect = "1:1", n = 1, imageModel } = {}) {
  const model = imageModel ?? (await pickImageModel(ctx));
  if (!model)
    throw new Error(
      "no image model configured; set options.imageModel or enable an image provider"
    );
  const result = await ctx.experimental.generate.image({
    model,
    prompt: String(prompt),
    aspect,
    n,
  });
  const images = Array.isArray(result?.images) ? result.images : [];
  const out = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const data = String(img?.data ?? "");
    const mime = String(img?.mime ?? "image/png");
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    const base = String(name ?? createHash("sha256").update(data).digest("hex").slice(0, 12))
      .replace(/[^a-z0-9_-]+/gi, "-")
      .slice(0, 80);
    out.push({ name: `${base}-${i + 1}.${ext}`, mime, data });
  }
  return out;
}

export async function pickImageModel(ctx) {
  const configured = ctx?.options?.imageModel;
  if (configured?.providerID && configured?.id) return configured;
  try {
    const listed = await ctx.model.list();
    const models = Array.isArray(listed) ? listed : (listed?.data ?? []);
    const image = models.find(
      (m) => m?.enabled !== false && (m?.type === "image" || m?.capabilities?.image === true)
    );
    return image ? { providerID: image.providerID, id: image.id } : null;
  } catch {
    return null;
  }
}
