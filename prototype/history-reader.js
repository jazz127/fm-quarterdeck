import { open } from "node:fs/promises";

export class HistoryLimitError extends Error {
  constructor() { super("History exceeds safe read limits; source files are unchanged."); }
}

// One reader per request, shared by transcript, status and legacy note loaders.
// Bounds apply to actual bytes (including a file growing after stat), not pages
// rendered in the browser. Fail the request explicitly rather than omit records.
export function createHistoryReader({ maxFileBytes = 8 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024,
  maxLineBytes = 1024 * 1024, maxFiles = 2048, maxRecords = 20000, maxMessages = 20000 } = {}) {
  let bytes = 0, files = 0, records = 0, messages = 0;
  const takeMessage = () => { if (++messages > maxMessages) throw new HistoryLimitError(); };
  async function text(filename, firstOnly = false) {
    if (++files > maxFiles) throw new HistoryLimitError();
    const file = await open(filename, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || (!firstOnly && (info.size > maxFileBytes || bytes + info.size > maxTotalBytes))) throw new HistoryLimitError();
      const chunks = [];
      let size = 0, lineBytes = 0;
      while (true) {
        const chunk = Buffer.alloc(64 * 1024);
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        bytes += bytesRead;
        const end = firstOnly ? chunk.subarray(0, bytesRead).indexOf(10) : -1;
        const kept = end < 0 ? bytesRead : end;
        size += kept;
        if (size > maxFileBytes || bytes > maxTotalBytes) throw new HistoryLimitError();
        for (let i = 0; i < kept; i++) {
          if (chunk[i] === 10) {
            if (++records > maxRecords) throw new HistoryLimitError();
            lineBytes = 0;
          } else if (++lineBytes > maxLineBytes) throw new HistoryLimitError();
        }
        chunks.push(chunk.subarray(0, kept));
        if (end >= 0) break;
      }
      if (lineBytes && ++records > maxRecords) throw new HistoryLimitError();
      return Buffer.concat(chunks, size).toString("utf8");
    } finally { await file.close(); }
  }
  async function* lines(filename) {
    for (const line of (await text(filename)).split(/\r?\n/)) {
      if (Buffer.byteLength(line) > maxLineBytes) throw new HistoryLimitError();
      yield line;
    }
  }
  return { text: (filename) => text(filename), firstLine: (filename) => text(filename, true), lines, takeMessage };
}
