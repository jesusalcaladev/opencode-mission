// state mixin — extracted from supervisor.js; behavior unchanged.
import { AsyncLocalStorage } from "node:async_hooks";

const writeScope = new AsyncLocalStorage();

export const state = {
  rootFor(sessionID) {
    return this.bySession.get(sessionID) ?? null;
  },

  effectiveRoot(root, state) {
    return state.worktree_root ? this.d.path.resolve(state.worktree_root) : root;
  },

  async serialize(root, fn) {
    // Reentrancy must be scoped to the async call chain, not to the root.
    // A global "owner" flag also matches concurrent callers, which then skip
    // the queue and race each other on state.json.
    if (writeScope.getStore() === root) return fn();
    const previous = this.stateQueue.get(root) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    // Swallow upstream failures so one rejected write cannot poison the queue.
    const tail = previous.catch(() => {}).then(() => current);
    this.stateQueue.set(root, tail);
    await previous.catch(() => {});
    try {
      return await writeScope.run(root, fn);
    } finally {
      release();
      if (this.stateQueue.get(root) === tail) this.stateQueue.delete(root);
    }
  },

  journal(root, line) {
    return this.serialize(root, () => this.d.appendJournal(root, line));
  },

  saveStateSafe(root, state) {
    return this.serialize(root, () => this.d.saveState(root, state));
  },

  saveProgressSafe(root, progress) {
    return this.serialize(root, () => this.d.saveProgress(root, progress));
  },

  saveTasksSafe(root, tasks) {
    return this.serialize(root, () => this.d.saveTasks(root, tasks));
  },

  dispose() {
    if (this.rescueTimer) clearInterval(this.rescueTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pendingTicks?.clear();
    this.controller.abort();
  },
};
