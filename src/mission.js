// Durable mission facade. Pure decisions live in src/mission/*; this module is
// a barrel so callers keep one stable import surface. The architecture checker
// guarantees the re-exported modules never leak test globals or IO decisions.

export * from "./mission/state.js";
export * from "./mission/decide.js";
export * from "./mission/autonomy.js";
export * from "./mission/recovery.js";
export * from "./mission/metrics.js";
export * from "./mission/memory.js";
export * from "./mission/watchdog.js";
export * from "./mission/roles.js";
export * from "./mission/improve.js";
export * from "./mission/instructions.js";
export * from "./mission/facts.js";
export * from "./mission/chain.js";
export * from "./mission/lease.js";
export * from "./mission/cost.js";
export * from "./mission/quality.js";
export * from "./mission/locks.js";
export * from "./mission/wake.js";
export * from "./mission/global-memory.js";
export * from "./mission/tokens.js";
export * from "./mission/forecast.js";
export * from "./mission/eval.js";
export * from "./mission/queue.js";
export * from "./mission/persistence.js";
export * from "./mission/bootstrap.js";
export * from "./mission/journal.js";
export * from "./mission/sandbox.js";
export * from "./mission/host-restart.js";
