// OpenTUI's published JSX types omit the color props that the runtime accepts.
// These augmentations keep the TUI type-checkable without weakening the host API.
declare module "@opentui/solid" {
  interface SpanProps {
    fg?: unknown;
    bg?: unknown;
  }
}
