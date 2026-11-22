// Shared Mission Control types and store hook.
import { usePlugin } from "@opencode/plugin/tui";
import { palette } from "./format.js";

export const MODEL_KEY = "mission.tui.v1";

export type MissionSnapshot = {
  root: string;
  id: string;
  objective: string;
  status: string;
  phase: string;
  stage: string;
  sessionID: string;
  turn: number;
  max_turns: number;
  cost_usd: number;
  budget_usd: number;
  hard_budget_usd: number;
  writes: number;
  max_writes: number;
  extensions: number;
  max_extensions: number;
  chain_index: number;
  chain_total: number;
  improve_cycles: number;
  max_improve_cycles: number;
  started_at: number;
  elapsed_ms: number;
  finish_reason: string;
  last_checks_at: number;
  worktree_branch: string;
  auto_extend: boolean;
  paused: boolean;
  strategy_tier: number;
  checks: Array<{ id: string; ok: boolean; summary: string; ms: number }>;
  tasks: Array<{ id: number; subject: string; status: string; verify: string }>;
  requirements: Array<{ id: string; text: string; checks: string[]; covered: boolean }>;
  agents: Array<{
    sessionID: string;
    role: string;
    taskId: number;
    status: string;
    started_at: number;
    last_heartbeat: number;
  }>;
  history: Array<{ turn?: number; green?: number; pct?: number }>;
  metrics: Record<string, number>;
  metrics_lines: string[];
  prompt_backlog: Array<{ key: string; kind: string; sessionID: string; at: number }>;
  handoffs: Array<{ from: string; to: string; turn: number; at: number }>;
  journal: string;
  nextTask: { id: number; subject: string } | null;
  pct: number;
  checksGreen: number;
  checksTotal: number;
  tasksDone: number;
  tasksTotal: number;
  reqCovered: number;
  reqTotal: number;
  budget_pct: number;
  turn_pct: number;
  active: boolean;
  updatedAt: number;
};

export type MissionModel = {
  snapshot: MissionSnapshot | null;
  missions: Array<{ root: string; id: string; objective: string; status: string; pct: number }>;
  updatedAt: number;
};

export function initialModel(): MissionModel {
  return { snapshot: null, missions: [], updatedAt: 0 };
}

export function useMissionModel() {
  const ctx = usePlugin();
  return ctx.storage.memory<MissionModel>(MODEL_KEY, { initial: initialModel() });
}

export function useColors() {
  const ctx = usePlugin();
  return palette(ctx.theme);
}
