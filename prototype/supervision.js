import { lstat } from "node:fs/promises";
import path from "node:path";
import { createHistoryReader } from "./history-reader.js";

const OUTCOME_SOURCES = ["state/branch-outcomes.jsonl", "state/terminal-outcomes.jsonl"];

function parseOutcome(line) {
  const record = JSON.parse(line);
  if (record.silent === true || typeof record.summary !== "string" || !record.summary.trim()) return null;
  const epoch = record.epoch ?? record.created_epoch;
  const timestamp = new Date(typeof epoch === "number" ? epoch * 1000 : NaN);
  if (Number.isNaN(timestamp.valueOf())) throw new Error("Invalid outcome timestamp");
  const taskId = typeof (record.task ?? record.task_id) === "string" ? record.task ?? record.task_id : null;
  return { record, timestamp, taskId };
}

export async function readSupervisionActivity(home, reader) {
  const activity = new Map();
  for (const source of OUTCOME_SOURCES) {
    const file = path.join(home, source);
    try { if (!(await lstat(file)).isFile()) continue; }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await reader.scanRecent(file, line => {
      if (!line.trim()) return;
      let outcome;
      try { outcome = parseOutcome(line); } catch { return; }
      if (!outcome?.taskId) return;
      const { taskId, timestamp } = outcome;
      if (!activity.has(taskId) || timestamp > activity.get(taskId)) activity.set(taskId, timestamp);
    });
  }
  return activity;
}

// Outcome ledgers only grow, so each is read as a window of its newest whole
// records; omitted older outcomes are reported. Other reader limits still fail.
export async function readSupervisionOutcomes(home, publicMessage, reader = createHistoryReader()) {
  const messages = [];
  const sources = [];
  const warnings = [];
  for (const source of OUTCOME_SOURCES) {
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
      let outcome;
      try { outcome = parseOutcome(line); } catch { inventory.skippedRecords += 1; continue; }
      if (!outcome) continue;
      const { record, timestamp, taskId } = outcome;
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
