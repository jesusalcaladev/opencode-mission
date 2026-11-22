/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// researchTools mixin — extracted from tools.js.
// All dependencies are reached through this.d (set by the Supervisor).

export const researchTools = {
  researchAllowed(root) {
    // Research is opt-in: enabled by the plan, by a researcher role, or by options.
    return true;
  },

  researchWorkspace(sessionID) {
    const root = this.rootFor(sessionID);
    if (!root) return null;
    return this.effectiveRoot(root, { worktree_root: "" });
  },

  async toolWebSearch(sessionID, input) {
    const query = String(input?.query ?? "").trim();
    if (!query) return "query is required.";
    try {
      const results = await this.d.webSearch(
        this.ctx,
        query,
        Math.min(20, Math.max(1, Number(input?.limit) || 8))
      );
      const text = results
        .map((r, i) => `${i + 1}. ${r.title || r.url}\n   ${r.url}\n   ${r.content}`.trim())
        .join("\n");
      await this.journal(
        this.rootFor(sessionID) ?? "",
        `web search: ${query.slice(0, 120)} (${results.length} results)`
      ).catch(() => {});
      return `${results.length} results for "${query}"\n${text || "(no results)"}`;
    } catch (err) {
      return `Web search failed: ${this.d.shortError(err)}`;
    }
  },

  async toolWebFetch(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const url = String(input?.url ?? "").trim();
    if (!url) return "url is required.";
    try {
      const page = await this.d.fetchPage(url, {
        maxChars: Math.min(60000, Math.max(1000, Number(input?.max_chars) || 12000)),
      });
      if (input?.save) {
        const work = this.researchWorkspace(sessionID);
        const dir = this.d.path.join(work, "research", "pages");
        await this.d.mkdir(dir, { recursive: true });
        const hash = this.d.createHash("sha256").update(page.url).digest("hex").slice(0, 12);
        const file = this.d.path.join(dir, `${hash}.md`);
        await this.d.writeFile(
          file,
          `# ${page.title}\n\nSource: ${page.url}\n\n${page.text}\n`,
          "utf8"
        );
        return `Saved ${this.d.path.relative(work, file)}\n${page.text.slice(0, 12000)}`;
      }
      return `${page.title || page.url}\n${page.description}\n\n${page.text}`;
    } catch (err) {
      return `Fetch refused/failed: ${this.d.shortError(err)}`;
    }
  },

  async toolImageSearch(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const query = String(input?.query ?? "").trim();
    if (!query) return "query is required.";
    const limit = Math.min(12, Math.max(1, Number(input?.limit) || 6));
    try {
      const images = await this.d.imageSearch(query, { limit });
      const work = this.researchWorkspace(sessionID);
      const lines = [];
      for (const image of images) {
        let local = "";
        if (input?.download && image.url) {
          try {
            const saved = await this.d.downloadImage(image.url, work, { name: image.title });
            local = saved.path;
            image.localPath = saved.path;
          } catch (err) {
            local = `download failed: ${this.d.shortError(err)}`;
          }
        }
        lines.push(
          `- ${image.title} · ${image.license || "license unknown"} · ${image.creator || "author unknown"}\n  ${local || image.url}`
        );
      }
      await this.d.saveResearch(work, {
        report: await this.d
          .readFile(this.d.path.join(work, "research", "report.md"), "utf8")
          .catch(() => "# Research\n"),
        images,
      });
      return `${images.length} image(s) for "${query}"\n${lines.join("\n") || "(none)"}`;
    } catch (err) {
      return `Image search failed: ${this.d.shortError(err)}`;
    }
  },

  async toolImageGenerate(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const prompt = String(input?.prompt ?? "").trim();
    if (!prompt) return "prompt is required.";
    try {
      const work = this.researchWorkspace(sessionID);
      const images = await this.d.generateImage(this.ctx, prompt, {
        name: input?.name,
        aspect: typeof input?.aspect === "string" ? input.aspect : "1:1",
        n: Math.min(4, Math.max(1, Number(input?.n) || 1)),
      });
      const dir = this.d.path.join(work, "research", "images");
      await this.d.mkdir(dir, { recursive: true });
      const saved = [];
      for (const image of images) {
        const file = this.d.path.join(dir, image.name);
        await this.d.writeFile(file, Buffer.from(image.data, "base64"));
        saved.push(this.d.path.relative(work, file));
      }
      await this.journal(root, `generated ${saved.length} image(s)`);
      return `Generated: ${saved.join(", ") || "none"}`;
    } catch (err) {
      return `Image generation failed: ${this.d.shortError(err)}`;
    }
  },

  async toolResearch(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const question = String(input?.question ?? "").trim();
    if (!question) return "question is required.";
    const work = this.researchWorkspace(sessionID);
    await this.serialize(root, async () => {
      const s = await this.d.loadState(root);
      s.metrics = this.d.recordMetric(s.metrics, "researchCalls", 1);
      await this.saveStateSafe(root, s);
    });
    try {
      const results = await this.d.webSearch(this.ctx, question, 8);
      const pages = [];
      const depth = String(input?.depth ?? "deep").toLowerCase() === "quick" ? 1 : 3;
      for (const result of results.slice(0, depth)) {
        try {
          pages.push(await this.d.fetchPage(result.url, { maxChars: 10_000 }));
        } catch {
          // Keep the search snippet when a page cannot be fetched.
        }
      }
      const images = [];
      if (input?.images !== false) {
        try {
          const found = await this.d.imageSearch(question, { limit: 4 });
          for (const image of found.slice(0, 2)) {
            try {
              const saved = await this.d.downloadImage(image.url, work, { name: image.title });
              images.push({ ...image, localPath: saved.path });
            } catch {
              images.push(image);
            }
          }
        } catch {
          // Image search is best-effort.
        }
      }
      const report = this.d.buildReport(question, { results, pages, images });
      const saved = await this.d.saveResearch(work, {
        report,
        sources: results.map((r) => ({ url: r.url, title: r.title, content: r.content })),
        images,
      });
      await this.journal(
        root,
        `research saved: ${this.d.path.basename(saved.report)} (${results.length} sources, ${images.length} images)`
      );
      return `Research saved to ${this.d.path.relative(work, saved.report)}\n${results.length} sources · ${pages.length} pages fetched · ${images.length} images`;
    } catch (err) {
      return `Research failed: ${this.d.shortError(err)}`;
    }
  },

  async toolResearchNote(sessionID, input) {
    const root = this.rootFor(sessionID);
    if (!root) return "No active mission.";
    const content = String(input?.content ?? "").trim();
    if (!content) return "content is required.";
    const title = String(input?.title ?? "Research note")
      .trim()
      .slice(0, 120);
    const work = this.researchWorkspace(sessionID);
    const dir = this.d.path.join(work, "research");
    await this.d.mkdir(dir, { recursive: true });
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "note";
    const file = this.d.path.join(dir, `${slug}.md`);
    await this.d.writeFile(file, `# ${title}\n\n${content}\n`, "utf8");
    return `Saved ${this.d.path.relative(work, file)}`;
  },
};
