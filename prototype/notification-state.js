import { constants } from "node:fs";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { configuredStatePath } from "./agent-state.js";
import { validSubscription } from "./push-provider.js";

export const NOTIFICATION_SCHEMA = "fm-quarterdeck-notifications.v1";
export const notificationPaths = (env) => {
  const root = path.dirname(configuredStatePath(env));
  return { state: path.join(root, "quarterdeck-notifications.json"), marker: path.join(root, "quarterdeck-notifications.owner"), keys: path.join(root, "quarterdeck-push-keys.json") };
};
export const digest = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const deviceId = (value) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export async function privateJson(file, maxBytes = 8 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > maxBytes || stat.uid !== process.getuid()) throw new Error("Private file requires repair");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error("Private file changed during read");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}
const emptyState = (binding) => ({ schema: NOTIFICATION_SCHEMA, binding, subscriptions: {}, seen: {}, events: {}, outbox: {} });
function validate(state, binding) {
  if (state?.schema !== NOTIFICATION_SCHEMA || state.binding !== binding ||
      Object.keys(state).sort().join(",") !== "binding,events,outbox,schema,seen,subscriptions") throw new Error("Notification owner mismatch");
  for (const key of ["subscriptions", "seen", "events", "outbox"]) if (!state[key] || typeof state[key] !== "object" || Array.isArray(state[key])) throw new Error("Notification ledger requires repair");
  if (Object.keys(state.subscriptions).length > 8 || Object.keys(state.seen).length > 10000 || Object.keys(state.events).length > 10000 || Object.keys(state.outbox).length > 80000) throw new Error("Notification capacity reached");
  for (const [id, sub] of Object.entries(state.subscriptions)) if (!deviceId(id) || typeof sub.enabled !== "boolean" || typeof sub.baseline !== "boolean" || !(sub.enabled ? validSubscription(sub.subscription) : sub.subscription === null || validSubscription(sub.subscription))) throw new Error("Invalid saved subscription");
  for (const [id, entry] of Object.entries(state.seen)) if (!hash(id) || typeof entry.key !== "string" || !["baseline", "suppressed", "event"].includes(entry.disposition) || !Number.isSafeInteger(entry.detectedAt)) throw new Error("Invalid notification identity");
  for (const [id, event] of Object.entries(state.events)) if (!deviceId(id) || !hash(event.identity) || !state.seen[event.identity] || !Number.isSafeInteger(event.detectedAt) || event.expiresAt !== event.detectedAt + 900000 || event.payload?.event !== id || event.payload?.title !== "Quarterdeck" || event.payload?.body !== "A new Captain’s Call needs your attention" || event.payload?.destination !== "/#overview" || Object.keys(event.payload).sort().join(",") !== "body,destination,event,title") throw new Error("Invalid saved event");
  for (const [id, item] of Object.entries(state.outbox)) if (id !== `${item.event}:${item.device}` || !state.events[item.event] || !state.subscriptions[item.device] || !["queued", "sending", "retry", "accepted", "cancelled", "expired", "failed"].includes(item.state) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || item.attempts > 5 || !Number.isSafeInteger(item.nextAt)) throw new Error("Invalid notification outbox");
  return state;
}
export function createNotificationOwner(paths, binding) {
  let serial = Promise.resolve();
  async function read() {
    let marker;
    try { marker = await privateJson(paths.marker, 256); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await privateJson(paths.state); } catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
      throw new Error("Notification owner marker missing");
    }
    if (marker.binding !== binding) throw new Error("Notification installation changed");
    // An established owner never treats a missing/corrupt ledger as an empty baseline.
    return validate(await privateJson(paths.state), binding);
  }
  async function atomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
      const directory = await open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const update = (change, initialize = false) => {
    const work = serial.then(async () => {
      await mkdir(path.dirname(paths.state), { recursive: true, mode: 0o700 });
      const lock = await open(`${paths.state}.lock`, "wx", 0o600);
      try {
        let state = await read();
        if (!state) {
          if (!initialize) throw new Error("Notification owner not initialized");
          state = emptyState(binding);
          // Marker first: interrupted initialization requires explicit repair, never spam.
          await atomic(paths.marker, { binding });
        }
        const previous = JSON.stringify(state);
        const result = await change(state);
        validate(state, binding);
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error("Notification capacity reached");
        if (json !== previous || initialize) await atomic(paths.state, state);
        return result;
      } finally { await lock.close(); await unlink(`${paths.state}.lock`); }
    });
    serial = work.catch(() => {});
    return work;
  };
  return { read, update };
}
