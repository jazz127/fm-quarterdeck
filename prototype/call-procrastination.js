import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { configuredStatePath } from "./agent-state.js";

// Quarterdeck-only viewing status for Captain's Call cards. This file lives beside
// FM_QUARTERDECK_STATE_PATH and is never a Firstmate record or an answer.
export const PROCRASTINATION_SCHEMA = "fm-quarterdeck-call-procrastination.v1";
export const PROCRASTINATE_MS = Object.freeze({
  "3h": 3 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
});
const KEY = /^(?:decision:[A-Za-z0-9][A-Za-z0-9._-]{0,159}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,159})?|merge:[A-Za-z0-9][A-Za-z0-9._-]{0,159}|chat:[0-9a-f]{16})$/;
export const procrastinationKey = (value) => typeof value === "string" && KEY.test(value);
export const procrastinationPath = (env = {}) => path.join(path.dirname(configuredStatePath(env)), "quarterdeck-call-procrastination.json");
export const emptyProcrastination = () => ({ schema: PROCRASTINATION_SCHEMA, until: {} });

export function validProcrastination(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PROCRASTINATION_SCHEMA) return false;
  if (!value.until || typeof value.until !== "object" || Array.isArray(value.until)) return false;
  const entries = Object.entries(value.until);
  return entries.length <= 200 && entries.every(([key, iso]) => procrastinationKey(key) && typeof iso === "string" && Number.isFinite(Date.parse(iso)));
}

// Future times only. openKeys, when provided, drops calls Firstmate has already resolved.
export function activeUntil(state, now, openKeys = null) {
  const until = {};
  for (const [key, iso] of Object.entries(state?.until || {})) {
    const stamp = Date.parse(iso);
    if (!procrastinationKey(key) || !Number.isFinite(stamp) || stamp <= now) continue;
    if (openKeys && !openKeys.has(key)) continue;
    until[key] = new Date(stamp).toISOString();
  }
  return until;
}

// Extend a live procrastination from its current return time. Otherwise start from now.
export function nextUntil(state, key, duration, now) {
  const ms = PROCRASTINATE_MS[duration];
  if (!procrastinationKey(key) || !ms) return null;
  const current = Date.parse(state?.until?.[key] || "");
  const start = Number.isFinite(current) && current > now ? current : now;
  return new Date(start + ms).toISOString();
}

export function createProcrastinationStore(env = {}, now = () => Date.now()) {
  const file = procrastinationPath(env);
  async function read() {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) return emptyProcrastination();
      const value = JSON.parse(await handle.readFile("utf8"));
      return validProcrastination(value) ? value : emptyProcrastination();
    } catch { return emptyProcrastination(); }
    finally { await handle?.close(); }
  }
  async function update(change) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { lock = await open(`${file}.lock`, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    if (!lock) throw new Error("Quarterdeck procrastination state busy");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const state = await read();
      const next = change(state);
      if (next === state) return state;
      if (!validProcrastination(next)) throw new Error("Invalid procrastination state");
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(next)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, file);
      return next;
    } finally {
      await unlink(temp).catch(() => {});
      await lock.close();
      await unlink(`${file}.lock`).catch(() => {});
    }
  }
  return {
    file,
    read,
    async view(openKeys = null) {
      let result = emptyProcrastination();
      await update((state) => {
        result = { schema: PROCRASTINATION_SCHEMA, until: activeUntil(state, now(), openKeys) };
        return JSON.stringify(state.until) === JSON.stringify(result.until) ? state : result;
      });
      return result;
    },
    async set(key, duration) {
      if (!nextUntil(emptyProcrastination(), key, duration, now())) throw new Error("Invalid procrastination");
      return update((state) => ({ schema: PROCRASTINATION_SCHEMA, until: { ...activeUntil(state, now()), [key]: nextUntil(state, key, duration, now()) } }));
    },
    async clear(key) {
      if (!procrastinationKey(key)) throw new Error("Invalid procrastination");
      return update((state) => {
        if (!state.until[key]) return state;
        const until = { ...state.until };
        delete until[key];
        return { schema: PROCRASTINATION_SCHEMA, until };
      });
    },
  };
}
