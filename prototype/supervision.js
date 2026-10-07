import { lstat } from "node:fs/promises";
import path from "node:path";
import { createHistoryReader } from "./history-reader.js";

export async function readSupervisionOutcomes(home, publicMessage, reader = createHistoryReader()) {
  const messages = [];
  const sources = [];
  for (const source of ["state/branch-outcomes.jsonl", "state/terminal-outcomes.jsonl"]) {
    const file = path.join(home, source);
    try { if (!(await lstat(file)).isFile()) continue; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const inventory = { source, messageCount: 0, skippedRecords: 0 };
    const lines = reader.lines(file);
    let index = 0;
    for await (const line of lines) {
      index += 1;
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
        source, taskId, timestamp, sourceSequence: index,
        text: `${taskId ? `${taskId}: ` : ""}${record.summary.trim()}`,
      }), recordId: `${source}:${index}`, transcriptOrigin: "fleet note" });
      inventory.messageCount += 1;
    }
    sources.push(inventory);
  }
  return { messages, sources };
}
