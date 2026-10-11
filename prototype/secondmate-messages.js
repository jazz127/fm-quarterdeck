import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHistoryReader } from "./history-reader.js";

// Match the producer's explicit suffix, allowing punctuation in summary/scope.
const local = /^- ([A-Za-z0-9._-]+) - (.+) \(home:\s*([^;)]*);\s*scope:\s*(.*);\s*projects:\s*([^;)]*);\s*added\s+(\d{4}-\d{2}-\d{2})\)\s*$/;
const remote = /^- ([A-Za-z0-9._-]+) - (.+) \(host:\s*([^;)]*);\s*root:\s*([^;)]*);\s*home:\s*([^;)]*);\s*scope:\s*(.*);\s*projects:\s*([^;)]*);\s*added\s+(\d{4}-\d{2}-\d{2})\)\s*$/;

export function registeredSecondmates(text) {
  const entries = new Map(), counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^- ([A-Za-z0-9._-]+)(?:\s|$)/)?.[1];
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
    const match = line.match(local) || line.match(remote);
    if (!match || id.length > 100) continue;
    const isRemote = match.length === 9;
    const home = match[isRemote ? 5 : 3].trim();
    const scope = match[isRemote ? 6 : 4].trim();
    if (!path.isAbsolute(home) || !scope || (isRemote && (!match[3].trim() || !path.isAbsolute(match[4].trim())))) continue;
    entries.set(id, { id, projects: match[isRemote ? 7 : 5].split(",").map(value => value.trim()).filter(Boolean) });
  }
  return [...entries.values()].filter(({ id }) => counts.get(id) === 1);
}

// Only the selected parent's registered status files are sources. Route metadata
// never authorizes reading another home, and message wording never grants origin.
export async function readSecondmateMessages(home, publicMessage, { reader = createHistoryReader(), windowBytes = null } = {}) {
  const root = await realpath(home), messages = [], sources = [], warnings = [];
  async function regular(source) {
    const file = path.join(root, source);
    return (await lstat(file)).isFile() && await realpath(path.dirname(file)) === path.dirname(file);
  }
  let registry;
  try {
    if (!await regular("data/secondmates.md")) throw Object.assign(new Error(), { code: "EINVAL" });
    registry = await reader.text(path.join(root, "data/secondmates.md"));
  } catch (error) {
    if (!["ENOENT", "EACCES", "EPERM", "EINVAL"].includes(error.code)) throw error;
    return { messages, sources, warnings: error.code === "ENOENT" ? [] : ["Second-mate registry unavailable or unsafe; origin is not assigned."] };
  }
  const mates = registeredSecondmates(registry);
  const candidateCount = registry.split(/\r?\n/).filter(line => line.startsWith("- ")).length;
  if (mates.length !== candidateCount) warnings.push("Malformed or duplicate second-mate registrations were excluded; origin is not assigned to those sources.");
  for (const mate of mates) {
    const source = `state/${mate.id}.status`;
    const inventory = { id: mate.id, source, loaded: false, messageCount: 0, skippedRecords: 0, omittedBytes: 0 };
    sources.push(inventory);
    let window;
    try {
      if (!await regular(source)) throw Object.assign(new Error(), { code: "EINVAL" });
      window = await reader.recent(path.join(root, source), windowBytes ?? undefined);
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM", "EINVAL"].includes(error.code)) throw error;
      warnings.push(`${mate.id}: delivered message source missing, unreadable or unsafe.`);
      continue;
    }
    if (!window) { warnings.push(`${mate.id}: message source not loaded within this request's read budget.`); continue; }
    inventory.loaded = true;
    inventory.omittedBytes = window.omittedBytes;
    if (window.omittedBytes) warnings.push(`${mate.id}: only newest whole delivered records loaded; older history is not shown.`);
    for await (const { line, offset } of window.lines) {
      if (!line.trim()) continue;
      // Inspect the event prefix only; dates mentioned in the body are not clocks.
      const prefix = line.match(/^([a-z-]+)((?:\s+\[[^\]\r\n]+\])*)\s*:/i);
      const clocks = prefix ? [...prefix[2].matchAll(/\[at=(\d+)\]/g)] : [];
      const timestamp = new Date(clocks.length === 1 ? Number(clocks[0][1]) * 1000 : NaN);
      if (!Number.isFinite(timestamp.valueOf())) { inventory.skippedRecords += 1; continue; }
      reader.takeMessage();
      messages.push({ ...publicMessage({ author: mate.id, role: "supervision", kind: "supervision", source,
        timestamp, sourceSequence: offset, text: line.trim(), state: prefix[1].toLowerCase() }),
        secondmateId: mate.id, secondmateProjects: mate.projects, recordId: `${source}@${offset}` });
      inventory.messageCount += 1;
    }
    if (inventory.skippedRecords) warnings.push(`${mate.id}: ${inventory.skippedRecords} malformed or undated delivered records omitted; no event time was invented.`);
  }
  return { messages, sources, warnings };
}
