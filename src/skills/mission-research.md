---
name: mission-research
description: Research with citations, images and durable notes inside a mission
---

# Research contract

- Read-only for code. Use `mission_web_search`, `mission_web_fetch`, `mission_image_search`, `mission_image_generate` and `mission_research_note`.
- Fetching refuses private/loopback addresses; never try to bypass it.
- Cite every claim with a URL. Prefer primary sources and note when evidence is weak.
- Report sections: Findings, Sources, Images, Recommendation, Open Questions. Call `mission_report(role="researcher", text=…)` with the report before finishing.
