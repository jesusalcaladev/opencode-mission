// Deterministic fake OpenCode context and fixture preparation for evals.
// No network, no paid models, no writes outside a temp directory.

import { access, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureMission,
  loadState,
  missionDir,
  saveState,
  writeTextAtomic,
} from "../src/mission.js";

export const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function fakeCtx(base, testCase) {
  const store = new Map();
  const prompts = [];
  const created = [];
  const switched = [];
  let index = 0;
  let wrote = false;
  const policy = testCase.policy ?? {};
  const root = path.join(base, "mission");
  const writeFiles = async () => {
    if (wrote || !policy.write) return;
    wrote = true;
    for (const [file, content] of Object.entries(policy.write)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), String(content), "utf8");
    }
  };
  return {
    prompts,
    created,
    switched,
    storage: {
      get: async (key) => store.get(key),
      set: async (key, value) => store.set(key, value),
    },
    session: {
      create: async () => {
        const id = `session-${index++}`;
        created.push(id);
        return { id };
      },
      prompt: async ({ text }) => {
        prompts.push(String(text));
        if (/\[MISSION (?:SUPERVISOR|WORKER|COORDINATOR)/.test(String(text))) await writeFiles();
      },
      context: async () => [
        { info: { role: "assistant", cost: 0.01, tokens: { input: 10, output: 5 } } },
      ],
      get: async ({ sessionID }) => ({
        id: sessionID,
        outcome: "complete",
        time: { idle: 10, busy: 0 },
      }),
      wait: async () => {},
      synthetic: async () => {},
      switchModel: async ({ model }) => switched.push(model),
    },
    model: {
      default: async () => null,
      list: async () => [
        { providerID: "eval", id: "free-1", cost: [{ output: 0 }] },
        { providerID: "eval", id: "free-2", cost: [{ output: 0 }] },
      ],
    },
    event: { subscribe: async function* () {} },
    location: { directory: root },
  };
}

export async function prepareMission(base, testCase) {
  const root = path.join(base, "mission");
  if (testCase.fixture) {
    await cp(path.resolve(rootDir, testCase.fixture), root, { recursive: true });
  } else {
    await ensureMission(root, { objective: testCase.objective ?? testCase.id });
    await writeTextAtomic(
      path.join(missionDir(root), "criteria.json"),
      JSON.stringify({ version: 1, checks: testCase.criteria ?? [] })
    );
    await writeTextAtomic(
      path.join(missionDir(root), "tasks.json"),
      JSON.stringify({ version: 1, tasks: testCase.tasks ?? [] })
    );
    await writeTextAtomic(
      path.join(missionDir(root), "mission.md"),
      `---\n---\n${testCase.objective ?? testCase.id}\n`
    );
  }
  const state = await loadState(root);
  Object.assign(state, testCase.settings ?? {});
  state.last_prompt_at = Date.now() - 600_000;
  await saveState(root, state);
  return root;
}
