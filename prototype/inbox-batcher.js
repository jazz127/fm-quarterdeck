import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inboxReceipts, noteWithRequestId } from "./inbox.js";

// Quarterdeck owns this outbox beside its presentation state, never inside FM_HOME.
// Persist membership before invoking note: even a lost receipt retries the same batch.
export function createInboxBatcher({ home, statePath, delayMs = 3000, deliver = noteWithRequestId, readReceipts = inboxReceipts } = {}) {
  const scope = createHash("sha256").update(home || "unconfigured").digest("hex").slice(0, 16);
  const file = `${statePath}.inbox-${scope}.json`;
  let state = { schema: "fm-quarterdeck-outbox.v1", batches: [] }, serial = Promise.resolve(), timer, closed = false;
  const waiters = new Map();
  const readState = async (strict = false) => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("Invalid Quarterdeck outbox file");
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (saved.schema !== state.schema || !Array.isArray(saved.batches) || saved.batches.some((batch) =>
        typeof batch.id !== "string" || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > 30 ||
        batch.items.some((item) => typeof item.id !== "string" || typeof item.text !== "string"))) throw new Error("Invalid Quarterdeck outbox");
      return saved;
    } catch (error) { if (strict || error.code !== "ENOENT") throw error; return { schema: "fm-quarterdeck-outbox.v1", batches: [] }; }
  };
  const load = async () => { state = await readState(); };
  // Serialize across gateway processes as well as HTTP requests. Never steal an
  // uncertain writer's lock; retained pending items remain retryable after repair.
  const locked = (fn) => {
    const work = serial.then(async () => {
      await ready;
      if (!home) return fn();
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      let lock;
      for (let attempt = 0; attempt < 750; attempt++) {
        try { lock = await open(`${file}.lock`, "wx", 0o600); break; }
        catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
      if (!lock) throw new Error("Quarterdeck outbox busy; pending items retained; retry after writer/lock repair");
      try { await load(); return await fn(); }
      finally { await lock.close(); await unlink(`${file}.lock`); }
    });
    serial = work.catch(() => {});
    return work;
  };
  const ready = home ? load() : Promise.resolve();
  const save = async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) { await handle.close(); await unlink(temporary); throw new Error("Quarterdeck outbox full; delivery refused, retain client draft"); }
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  };
  const find = (id) => state.batches.find((batch) => batch.items.some((item) => item.id === id));
  const body = (batch) => batch.items.length === 1 ? batch.items[0].text : [
    `Quarterdeck captain submissions · ${batch.items.length} items`,
    "Handle every numbered item separately. Each keeps its original request id and card/task context. Reply to this inbox note naming each item or task; acknowledgement applies to the combined submission.",
    ...batch.items.map((item, i) => `\n--- Item ${i + 1} · request ${item.id} ---\n${item.text}\n--- End item ${i + 1} ---`),
    "\n```json fm-quarterdeck-batch",
    JSON.stringify({ schema: "fm-quarterdeck-inbox-batch.v1", requestId: batch.id, items: batch.items.map(({ id, text }) => ({ requestId: id, text })) }).replaceAll("`", "\\u0060"),
    "```",
  ].join("\n");
  const settle = (batch, error) => {
    for (const item of batch.items) {
      for (const waiter of waiters.get(item.id) || []) error ? waiter.reject(error) : waiter.resolve({ ...batch.receipt, request_id: item.id });
      waiters.delete(item.id);
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    if (closed || !state.batches.some((batch) => !batch.receipt)) return;
    timer = setTimeout(() => { void flush().catch(() => {}); }, Math.min(delayMs, Math.max(0, Math.min(...state.batches.filter((batch) => !batch.receipt).map((batch) => (batch.at || Date.now()) + delayMs + 2000 - Date.now())))));
    timer.unref?.();
  };
  async function flush() {
    return locked(async () => {
      await ready;
      clearTimeout(timer);
      for (const batch of state.batches.filter((entry) => entry.receipt)) settle(batch);
      for (const batch of state.batches.filter((entry) => !entry.receipt)) {
        // Seal before delivery. New arrivals cannot join an uncertain submitted batch.
        batch.sealed = true;
        await save();
        try {
          batch.receipt = await deliver(home, batch.id, body(batch));
          await save();
          settle(batch);
        } catch (error) {
          // Keep the sealed identity on disk; an explicit retry or restart repairs it.
          batch.receipt = null;
          settle(batch, error);
          throw error;
        }
      }
    }).catch((error) => {
      // A failed earlier batch or disk/lock operation must also release later HTTP
      // callers. Their payloads stay saved; each client can retry visibly.
      for (const batch of state.batches.filter((entry) => !entry.receipt)) settle(batch, error);
      throw error;
    });
  }
  async function note(_home, id, text, { record, display, immediate = false } = {}) {
    const result = await locked(async () => {
      await ready;
      let batch = find(id);
      if (batch) {
        if (batch.items.find((item) => item.id === id).text !== text) throw new Error("Outbox request id reused");
        if (batch.receipt) return { receipt: { ...batch.receipt, request_id: id, outcome: "replay" } };
      } else {
        batch = state.batches.findLast((entry) => !entry.sealed && !entry.receipt && entry.items.length < 30 && Buffer.byteLength(body(entry)) + Buffer.byteLength(text) < 100000);
        if (!batch) { batch = { id, items: [], sealed: false, at: Date.now() }; state.batches.push(batch); }
        if (batch.items.length === 1) batch.id = `quarterdeck-batch:${randomUUID()}`;
        batch.items.push({ id, text, record, display });
      }
      await save();
      const pending = new Promise((resolve, reject) => { waiters.set(id, [...(waiters.get(id) || []), { resolve, reject }]); });
      schedule();
      return { pending };
    });
    if (immediate && result.pending) void flush().catch(() => {});
    return result.receipt || result.pending;
  }
  note.lookup = async (id) => locked(async () => { await ready; return find(id)?.items.find((item) => item.id === id)?.record; });
  async function receipts() {
    const batches = await locked(async () => structuredClone(state.batches));
    const data = await readReceipts(home);
    const expand = (notes) => notes.flatMap((entry) => {
      const batch = batches.find((candidate) => candidate.id === entry.request_id);
      return batch ? batch.items.map((item) => ({ ...entry, request_id: item.id, body: item.text })) : [entry];
    });
    return { ...data, pending: expand(data.pending), handled: expand(data.handled) };
  }
  // Recovery is independent of the submitting page's lifetime. A restart resumes saved work.
  if (home) void ready.then(schedule).catch(() => {});
  async function pending({ strict = false } = {}) {
    await ready;
    // Atomic snapshots are readable even when a writer holds an abandoned lock.
    const snapshot = await readState(strict);
    return snapshot.batches.filter((batch) => !batch.receipt).flatMap((batch) => batch.items.map((item) => ({
      requestId: item.id, text: item.display || item.record?.display || item.text, key: item.record?.key || null,
    })));
  }
  return { note, receipts, flush, pending, initializeEvidence: () => locked(save), close() { closed = true; clearTimeout(timer); } };
}
