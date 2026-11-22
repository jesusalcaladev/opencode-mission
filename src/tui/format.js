// Pure formatting helpers for the Mission Control TUI. No OpenTUI imports.

const BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

const FRACTIONS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/**
 * Sub-cell progress geometry, shared by every bar renderer.
 *
 * Rounding to whole cells makes a wide bar jump in visible steps. Resolving the
 * remainder into eighths of a block keeps it smooth without changing the
 * terminal width, and the single source of truth keeps `bar()` and the React
 * component in agreement.
 */
export function barParts(value, width = 16) {
  const size = Math.max(1, Math.min(80, Math.floor(Number(width) || 16)));
  const n = pct(value);
  const exact = (n / 100) * size;
  let filled = Math.floor(exact);
  const eighths = Math.round((exact - filled) * 8);
  let partial = "";
  if (eighths >= 8) {
    filled += 1;
  } else if (eighths > 0) {
    partial = FRACTIONS[eighths - 1];
  }
  filled = Math.min(size, filled);
  return {
    filled,
    partial,
    empty: Math.max(0, size - filled - (partial ? 1 : 0)),
    pct: n,
    width: size,
  };
}

export function bar(value, width = 12, filled = "█", empty = "░") {
  const parts = barParts(value, width);
  return filled.repeat(parts.filled) + parts.partial + empty.repeat(parts.empty);
}

export function sparkline(values, width = 16) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => (typeof v === "number" ? v : Number(v?.green ?? v?.pct ?? 0)))
    .filter((n) => Number.isFinite(n))
    .slice(-Math.max(2, width));
  if (nums.length === 0) return "·".repeat(Math.max(1, width));
  const max = Math.max(...nums, 1);
  const min = Math.min(...nums, 0);
  const span = Math.max(1, max - min);
  const points = nums.map(
    (n) => BLOCKS[Math.max(0, Math.min(8, Math.round(((n - min) / span) * 8)))]
  );
  if (points.length >= width) return points.slice(-width).join("");
  return "·".repeat(width - points.length) + points.join("");
}

export function duration(ms) {
  const n = Math.max(0, Math.floor(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  const sec = Math.floor(n / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = String(sec % 60).padStart(2, "0");
  if (min < 60) return `${String(min).padStart(2, "0")}:${remSec}`;
  const hours = Math.floor(min / 60);
  const remMin = String(min % 60).padStart(2, "0");
  if (hours < 24) return `${String(hours).padStart(2, "0")}:${remMin}:${remSec}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${String(hours % 24).padStart(2, "0")}:${remMin}`;
}

export function truncate(text, length) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const n = Math.max(1, Math.floor(length));
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

export function shortPath(value, home) {
  const p = String(value ?? "");
  if (home && p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  return p;
}

export function shortID(value, size = 8) {
  const s = String(value ?? "");
  return s.length <= size ? s : `${s.slice(0, Math.max(1, size - 1))}…`;
}

export function statusGlyph(status) {
  switch (String(status ?? "")) {
    case "running":
      return "◉";
    case "paused":
      return "◐";
    case "complete":
      return "●";
    case "blocked":
      return "✕";
    case "aborted":
      return "○";
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "failed":
      return "✕";
    case "pending":
      return "○";
    default:
      return "◇";
  }
}

export function checkGlyph(ok) {
  return ok ? "✓" : "✕";
}

export function money(value) {
  const n = Number(value);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
}

export function count(value) {
  return Number.isFinite(Number(value)) ? String(Math.trunc(Number(value))) : "0";
}

export function palette(theme) {
  return {
    base: theme?.text?.base,
    muted: theme?.text?.muted,
    faint: theme?.text?.faint ?? theme?.text?.muted,
    accent: theme?.hue?.accent?.[500],
    interactive: theme?.hue?.interactive?.[500],
    success: theme?.text?.feedback?.success?.base,
    warning: theme?.text?.feedback?.warning?.base,
    error: theme?.text?.feedback?.error?.base,
    info: theme?.text?.feedback?.info?.base,
    border: theme?.border?.base,
    surface: theme?.background?.raised?.base,
    surfaceHigh: theme?.background?.raised?.high,
  };
}

export function statusColor(glyphs, status) {
  switch (String(status ?? "")) {
    case "running":
    case "in_progress":
    case "complete":
    case "completed":
      return glyphs.success;
    case "paused":
    case "warning":
      return glyphs.warning;
    case "blocked":
    case "aborted":
    case "failed":
      return glyphs.error;
    default:
      return glyphs.muted;
  }
}

export function budgetColor(glyphs, used, cap) {
  const c = Number(cap) || 0;
  const u = Number(used) || 0;
  if (c > 0 && u >= c) return glyphs.error;
  if (c > 0 && u >= c * 0.8) return glyphs.warning;
  return glyphs.success;
}
