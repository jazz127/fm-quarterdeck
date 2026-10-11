import { open } from "node:fs/promises";

export class HistoryLimitError extends Error {
  constructor() { super("History exceeds safe read limits; source files are unchanged."); }
}

// One reader per request, shared by transcript, status and legacy note loaders.
// Bounds apply to actual bytes (including a file growing after stat), not pages
// rendered in the browser. Fail the request explicitly rather than omit records;
// only `recent` windows a source (by bytes and records), and it reports what it left unread.
export function createHistoryReader({ maxFileBytes = 8 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024,
  maxLineBytes = 1024 * 1024, maxFiles = 2048, maxRecords = 20000, maxMessages = 20000,
  windowReserveBytes = 8 * 1024 * 1024, windowReserveRecords = Math.floor(maxRecords / 4) } = {}) {
  let bytes = 0, files = 0, records = 0, messages = 0;
  const takeMessage = () => { if (++messages > maxMessages) throw new HistoryLimitError(); };
  // Bytes a window may still take while leaving the reserve for whole-file
  // reads (backlog, metadata, notes) sharing this request.
  const windowBudget = () => Math.max(0, Math.min(maxFileBytes, maxTotalBytes - windowReserveBytes - bytes));
  // Records a window may still take, with a reserve for the same whole-file reads.
  const windowRecords = () => Math.max(0, maxRecords - windowReserveRecords - records);
  // Offset after the oldest records that do not fit `allowed`; a final record
  // without a newline is the newest and counts as one.
  function newestRecordsStart(buffer, allowed) {
    let total = 0, lineBytes = 0;
    for (const byte of buffer) {
      if (byte === 10) {
        total += 1;
        lineBytes = 0;
      } else if (++lineBytes > maxLineBytes) throw new HistoryLimitError();
    }
    if (buffer.length && buffer[buffer.length - 1] !== 10) total += 1;
    let drop = total - allowed, offset = 0;
    while (drop-- > 0) {
      const newline = buffer.indexOf(10, offset);
      if (newline < 0) return buffer.length;
      offset = newline + 1;
    }
    return offset;
  }
  function countRecords(buffer) {
    let lineBytes = 0;
    for (const byte of buffer) {
      if (byte === 10) {
        if (++records > maxRecords) throw new HistoryLimitError();
        lineBytes = 0;
      } else if (++lineBytes > maxLineBytes) throw new HistoryLimitError();
    }
    if (lineBytes && ++records > maxRecords) throw new HistoryLimitError();
  }
  async function read(filename, { firstOnly = false, window = false, maxBytes = maxFileBytes } = {}) {
    // No record budget left for a window: leave the source unread.
    if (window && !windowRecords()) return null;
    if (++files > maxFiles) throw new HistoryLimitError();
    const file = await open(filename, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new HistoryLimitError();
      let position = 0, limit = maxFileBytes;
      if (window) {
        limit = Math.min(windowBudget(), maxBytes);
        if (info.size > limit) {
          // Too little budget left for even one whole record: leave the source unread.
          if (limit < Math.min(maxLineBytes, maxFileBytes)) return null;
          position = info.size - limit;
        }
      } else if (!firstOnly && (info.size > maxFileBytes || bytes + info.size > maxTotalBytes)) throw new HistoryLimitError();
      const start = position;
      const chunks = [];
      let size = 0;
      while (!window || size < limit) {
        const chunk = Buffer.alloc(window ? Math.min(64 * 1024, limit - size) : 64 * 1024);
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        bytes += bytesRead;
        const end = firstOnly ? chunk.subarray(0, bytesRead).indexOf(10) : -1;
        const kept = end < 0 ? bytesRead : end;
        size += kept;
        if (size > maxFileBytes || bytes > maxTotalBytes) throw new HistoryLimitError();
        chunks.push(chunk.subarray(0, kept));
        if (end >= 0) break;
      }
      let buffer = Buffer.concat(chunks, size);
      // A window that starts mid-file drops the partial leading record so only
      // whole records are parsed; nothing is reconstructed from a fragment.
      let omittedBytes = start;
      if (start > 0) {
        const newline = buffer.indexOf(10);
        omittedBytes += newline < 0 ? buffer.length : newline + 1;
        buffer = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
      }
      if (window) {
        const allowed = windowRecords();
        // Keep the newest whole records the request's record budget can still hold.
        const kept = newestRecordsStart(buffer, allowed);
        if (!allowed) return null;
        omittedBytes += kept;
        buffer = buffer.subarray(kept);
      }
      countRecords(buffer);
      const text = buffer.toString("utf8");
      return window ? { text, omittedBytes, totalBytes: start + size } : text;
    } finally { await file.close(); }
  }
  async function* split(text) {
    for (const line of text.split(/\r?\n/)) {
      if (Buffer.byteLength(line) > maxLineBytes) throw new HistoryLimitError();
      yield line;
    }
  }
  // Lines with the file byte offset where each starts: an append-only source
  // keeps the same offsets as its window moves forward.
  async function* splitWithOffsets(text, offset) {
    for (const raw of text.split("\n")) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const size = Buffer.byteLength(raw);
      if (size > maxLineBytes + 1) throw new HistoryLimitError();
      yield { line, offset };
      offset += size + 1;
    }
  }
  return {
    text: (filename) => read(filename),
    firstLine: (filename) => read(filename, { firstOnly: true }),
    lines: async function* (filename) { yield* split(await read(filename)); },
    // Newest whole records of a source within the remaining byte and record budgets.
    // Null when this request's remaining budget cannot hold a useful window.
    recent: async (filename, maxBytes = maxFileBytes) => {
      const window = await read(filename, { window: true, maxBytes });
      return window && { lines: splitWithOffsets(window.text, window.omittedBytes), omittedBytes: window.omittedBytes, totalBytes: window.totalBytes };
    },
    windowBudget,
    takeMessage,
  };
}
