// The supervisor is a thin coordinator. Behavior lives in cohesive mixins
// under src/supervisor/: state, recovery, lifecycle, intelligence, workers, tools.
// The main loop stays here because it is the one place that owns the turn flow.

import * as d from "./supervisor/deps.js";
import { decisions } from "./supervisor/decisions.js";
import { state } from "./supervisor/state.js";
import { recovery } from "./supervisor/recovery.js";
import { models } from "./supervisor/models.js";
import { lifecycle } from "./supervisor/lifecycle.js";
import { planning } from "./supervisor/planning.js";
import { workspaces } from "./supervisor/workspaces.js";
import { intelligence } from "./supervisor/intelligence.js";
import { rolesPipeline } from "./supervisor/roles-pipeline.js";
import { goalAudit } from "./supervisor/goal-audit.js";
import { improvements } from "./supervisor/improvements.js";
import { workers } from "./supervisor/workers.js";
import { scheduler } from "./supervisor/scheduler.js";
import { tools } from "./supervisor/tools.js";
import { researchTools } from "./supervisor/research-tools.js";
import { cost } from "./supervisor/cost.js";
import { quality } from "./supervisor/quality.js";
import { spawnTools } from "./supervisor/spawn-tools.js";
import { wake } from "./supervisor/wake.js";
import { failures } from "./supervisor/failures.js";
import { verification } from "./supervisor/verification.js";
import { reviews } from "./supervisor/reviews.js";
import { parallel } from "./supervisor/parallel.js";
import { queueManager } from "./supervisor/queue-manager.js";
import { supervisorContext } from "./supervisor/context.js";
import { discovery } from "./supervisor/discovery.js";
import { missionReport } from "./supervisor/report.js";
import { planFiles } from "./supervisor/plan-files.js";

export class Supervisor {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.d = d;
    this.options = options;
    this.bySession = new Map();
    this.byRoot = new Map();
    this.boundDirectory = new Map();
    this.registry = [];
    this.busy = new Set();
    this.workers = new Map();
    this.roles = new Map();
    this.knownWorkers = new Set();
    this.briefs = new Map();
    this.stateQueue = new Map();
    this.timers = new Set();
    this.pendingTicks = new Set();
    this.rescueTimer = null;
    this.generationCosts = new Map();
    this.fileLocks = new Map();
    this.controller = new AbortController();
    this.maxWorkers = Math.max(1, Number(options.maxWorkers) || 3);
    this.missionsRoot = options.missionsRoot ? this.d.path.resolve(options.missionsRoot) : null;
    this.workspaceMode = options.workspaceMode === "sandbox" ? "sandbox" : "project";
    this.currentDirectory = this.d.path.resolve(ctx.location?.directory ?? process.cwd());
    this.enableWorkers = options.enableWorkers !== false;
    this.enableChaining = options.enableChaining !== false;
    this.enableRoles = options.enableRoles !== false;
    // Opt-in: make every mission unattended by default instead of requiring
    // `/mission start --long`. The per-command flag still wins.
    this.defaultAutonomy = ["relentless", "campaign"].includes(options.defaultAutonomy)
      ? options.defaultAutonomy
      : null;
  }
}

import { turn } from "./supervisor/turn.js";
import { telemetry } from "./supervisor/telemetry.js";
import { taskSplitting } from "./supervisor/task-splitting.js";

Object.assign(
  Supervisor.prototype,
  decisions,
  state,
  recovery,
  models,
  lifecycle,
  planning,
  workspaces,
  intelligence,
  rolesPipeline,
  goalAudit,
  improvements,
  workers,
  scheduler,
  tools,
  researchTools,
  cost,
  quality,
  spawnTools,
  wake,
  failures,
  verification,
  reviews,
  parallel,
  queueManager,
  supervisorContext,
  discovery,
  missionReport,
  planFiles,
  turn,
  telemetry,
  taskSplitting
);
