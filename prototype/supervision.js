import { lstat } from "node:fs/promises";
import path from "node:path";
import { createHistoryReader } from "./history-reader.js";

// Outcome ledgers only grow, so each is read as a window of its newest whole
// records; omitted older outcomes are reported, never a failed request.
export async function readSupervisionOutcomes(home, publicMessage, reader = createHistoryReader()) {
  const messages = [];
  const sources = [];
  const warnings = [];
  for (const source of ["state/branch-outcomes.jsonl", "state/terminal-outcomes.jsonl"]) {
    const file = path.join(home, source);
    try { if (!(await lstat(file)).isFile()) continue; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const inventory = { source, loaded: false, messageCount: 0, skippedRecords: 0, omittedBytes: 0 };
    sources.push(inventory);
    const window = await reader.recent(file);
    if (!window) {
      warnings.push(`${source} was not loaded: this request's read budget went to other sources.`);
      continue;
    }
    inventory.loaded = true;
    inventory.omittedBytes = window.omittedBytes;
    if (window.omittedBytes) warnings.push(`${source}: only its newest whole records loaded within this request's read budget; older outcomes are not shown.`);
    for await (const { line, offset } of window.lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { inventory.skippedRecords += 1; continue; }
      if (record.silent === true) continue;
      if (typeof record.summary !== "string" || !record.summary.trim()) continue;
      const epoch = record.epoch ?? record.created_epoch;
      const timestamp = new Date(typeof epoch === "number" ? epoch * 1000 : NaN);
      if (Number.isNaN(timestamp.valueOf())) { inventory.skippedRecords += 1; continue; }
      const taskId = typeof (record.task ?? record.task_id) === "string" ? record.task ?? record.task_id : null;
      reader.takeMessage();
      messages.push({ ...publicMessage({
        author: "Fleet", role: "supervision", kind: "supervision", state: record.verdict || "update",
        source, taskId, timestamp, sourceSequence: offset,
        text: `${taskId ? `${taskId}: ` : ""}${record.summary.trim()}`,
      }), recordId: `${source}@${offset}`, transcriptOrigin: "fleet note" });
      inventory.messageCount += 1;
    }
  }
  return { messages, sources, warnings };
}
