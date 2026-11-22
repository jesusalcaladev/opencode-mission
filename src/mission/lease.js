/* eslint-disable no-unused-vars -- shared preamble / compatibility signature */
// Task leases: the cure for "a worker dies and nobody picks up its task".
// A task is claimed with a deadline, released on a structured report, and
// reclaimed automatically when the lease expires. Attempts are bounded.
// Pure functions only: no clock reads beyond the `now` argument, no IO.

import { TASK_STATUS } from "./state.js";

export const LEASE_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;

export function fromTasks(tasks, now = Date.now()) {
  return tasks.map((t, i) => ({
    id: Number(t.id) || i + 1,
    subject: t.subject ?? `Task ${i + 1}`,
    status: t.status ?? TASK_STATUS.PENDING,
    owner: null,
    attempts: 0,
    lease_until: 0,
    last_error: "",
    verify: t.verify ?? "",
  }));
}

export function toTasks(progress, tasks) {
  return tasks.map((t, i) => {
    const p = progress.find((x) => x.id === t.id);
    return { ...t, status: p?.status ?? t.status ?? (i === 0 ? TASK_STATUS.PENDING : t.status) };
  });
}

export function migrateV1(tasks, state = {}) {
  const progress = fromTasks(tasks);
  for (const p of progress) {
    p.owner = typeof state.session_id === "string" ? state.session_id : null;
    if (p.status === TASK_STATUS.IN_PROGRESS) {
      p.lease_until = 0; // a v1 task was never leased: make it reclaimable now
    }
  }
  return progress;
}

export function isLeased(progress, id, now = Date.now()) {
  const p = progress.find((x) => x.id === id);
  return Boolean(p && p.status === TASK_STATUS.IN_PROGRESS && p.lease_until > now);
}

export function claim(progress, id, owner, now = Date.now(), ttl = LEASE_MS) {
  const p = progress.find((x) => x.id === id);
  if (!p || p.status === TASK_STATUS.COMPLETED) return false;
  if (p.attempts >= MAX_ATTEMPTS) return false;
  if (isLeased(progress, id, now)) return false;
  p.status = TASK_STATUS.IN_PROGRESS;
  p.owner = owner;
  p.lease_until = now + ttl;
  p.last_error = "";
  return true;
}

export function renew(progress, id, now = Date.now(), ttl = LEASE_MS) {
  const p = progress.find((x) => x.id === id);
  if (!p || p.status !== TASK_STATUS.IN_PROGRESS) return false;
  p.lease_until = Math.max(p.lease_until, now) + ttl;
  return true;
}

export function release(progress, id, status = TASK_STATUS.COMPLETED) {
  const p = progress.find((x) => x.id === id);
  if (!p) return false;
  p.status = status;
  p.owner = null;
  p.lease_until = 0;
  p.last_error = "";
  return true;
}

export function fail(progress, id, error, now = Date.now()) {
  const p = progress.find((x) => x.id === id);
  if (!p) return false;
  p.attempts += 1;
  p.last_error = String(error ?? "worker failed").slice(0, 300);
  p.status = p.attempts >= MAX_ATTEMPTS ? TASK_STATUS.FAILED : TASK_STATUS.PENDING;
  p.owner = null;
  p.lease_until = 0;
  return true;
}

export function expired(progress, now = Date.now()) {
  return progress
    .filter(
      (p) => p.status === TASK_STATUS.IN_PROGRESS && p.lease_until > 0 && p.lease_until <= now
    )
    .map((p) => p.id);
}

export function retryable(progress, id) {
  const p = progress.find((x) => x.id === id);
  return Boolean(p && p.status !== TASK_STATUS.COMPLETED && p.attempts < MAX_ATTEMPTS);
}
