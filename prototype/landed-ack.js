import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { configuredStatePath } from "./agent-state.js";

// Quarterdeck-only viewing state for Just landed cards. This file lives beside
// FM_QUARTERDECK_STATE_PATH and is never a Firstmate record or an answer.
export const LANDED_ACK_SCHEMA = "fm-quarterdeck-landed-ack.v1";
const KEY = /^landed:[A-Za-z0-9][A-Za-z0-9._-]{0,159}(?::[0-9a-f]{16})?$/;
const REV = /^[0-9a-f]{16}$/;
const CAP = 200;

export const landedAckKey = (value) => typeof value === "string" && KEY.test(value);
export const landedAckPath = (env = {}) => path.join(path.dirname(configuredStatePath(env)), "quarterdeck-landed-acknowledgements.json");
export const emptyLandedAcks = () => ({ schema: LANDED_ACK_SCHEMA, acks: {} });

export function validLandedAcks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== LANDED_ACK_SCHEMA) return false;
  if (!value.acks || typeof value.acks !== "object" || Array.isArray(value.acks)) return false;
  const entries = Object.entries(value.acks);
  return entries.length <= CAP && entries.every(([key, rev]) => landedAckKey(key) && typeof rev === "string" && REV.test(rev));
}

// Keep the key just recorded, then keys still open. Drop stale keys only at the cap.
export function cappedAcks(acks, preferred, openKeys = null) {
  const entries = Object.entries(acks);
  if (entries.length <= CAP) return acks;
  const rank = ([key]) => key === preferred ? 0 : openKeys?.has(key) ? 1 : 2;
  entries.sort((left, right) => rank(left) - rank(right) || left[0].localeCompare(right[0]));
  return Object.fromEntries(entries.slice(0, CAP));
}

export function createLandedAckStore(env = {}) {
  const file = landedAckPath(env);
  async function read() {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) return emptyLandedAcks();
      const value = JSON.parse(await handle.readFile("utf8"));
      return validLandedAcks(value) ? value : emptyLandedAcks();
    } catch { return emptyLandedAcks(); }
    finally { await handle?.close(); }
  }
  async function update(change) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { lock = await open(`${file}.lock`, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    if (!lock) throw new Error("Quarterdeck landed acknowledgement state busy");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const state = await read();
      const next = change(state);
      if (next === state) return state;
      if (!validLandedAcks(next)) throw new Error("Invalid landed acknowledgement state");
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
    async acknowledge(key, rev, openKeys = null) {
      if (!landedAckKey(key) || typeof rev !== "string" || !REV.test(rev)) throw new Error("Invalid acknowledgement");
      return update((state) => ({ schema: LANDED_ACK_SCHEMA, acks: cappedAcks({ ...state.acks, [key]: rev }, key, openKeys) }));
    },
  };
}
