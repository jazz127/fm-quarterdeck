import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

// Claude Code stores a project's sessions under <config>/projects/<cwd with
// every non-alphanumeric character replaced by "-">/<session-id>.jsonl.
export function claudeProjectDirectory(configDir, home) {
  return path.join(configDir, "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
// Firstmate-driven Claude sessions (secondary wakes, mirrors) start with a
// queued machine envelope; the captain's primary conversation never does.
const MACHINE_START = /^\W*(FIRSTMATE_OP:|FIRSTMATE SUPERVISION WAKE:|MAIN DIALOG MIRROR\b|<task-notification>)/;

// Locate the primary Claude Code transcript for exactly this home. The session
// id Firstmate records beside its lock (state/.lock-session) wins; without it,
// the newest session that does not open with a machine envelope is used and
// labeled as inferred. Only the home-encoded directory is ever listed.
export async function findClaudePrimary(root, configDir, reader, warnings) {
  if (!configDir) return null;
  const directory = claudeProjectDirectory(path.resolve(configDir), root);
  try {
    if (await realpath(directory) !== directory) {
      warnings.push("The Claude Code project directory for this home is a symlink; not loaded.");
      return null;
    }
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const candidate = async (name) => {
    const file = path.join(directory, name);
    try {
      const info = await stat(file);
      return info.isFile() && await realpath(file) === file ? file : null;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  let recorded = "";
  try { recorded = (await reader.firstLine(path.join(root, "state/.lock-session"))).trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (recorded) {
    const file = SESSION_ID.test(recorded) ? await candidate(`${recorded}.jsonl`) : null;
    if (file) return { file, inferred: false };
    warnings.push("state/.lock-session names no Claude Code transcript for this home; the newest primary-looking session is used.");
  }
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  const dated = await Promise.all(entries.map(async (entry) => ({ name: entry.name, changed: (await stat(path.join(directory, entry.name))).mtimeMs })));
  dated.sort((a, b) => b.changed - a.changed || a.name.localeCompare(b.name));
  for (const { name } of dated.slice(0, 20)) {
    const file = await candidate(name);
    if (!file) continue;
    let first;
    try { first = JSON.parse(await reader.firstLine(file)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
    if (first?.type === "queue-operation" && MACHINE_START.test(String(first.content || ""))) continue;
    return { file, inferred: true };
  }
  return null;
}

const stripReminders = (text) => text.replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, "").trim();

function userString(record, text) {
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1].trim();
    return { role: "user", content: [command[1].trim(), args].filter(Boolean).join(" ") };
  }
  const stdout = text.match(/^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/);
  if (stdout) return { role: "assistant", recordKind: "harness", author: "Claude Code", content: stdout[2] };
  const kept = stripReminders(text);
  if (!kept) return null;
  // Hook and background-task notifications are harness traffic, not captain chat.
  if (record.origin && record.origin.kind !== "human") {
    if (/^<task-notification>\s*<summary>Stop hook feedback<\/summary>\s*<\/task-notification>$/.test(kept)) return null;
    return { role: "assistant", recordKind: "harness", author: "Claude Code", content: kept };
  }
  return { role: "user", content: kept };
}

const resultText = (content) => typeof content === "string" ? content : Array.isArray(content)
  ? content.map((part) => part?.type === "text" ? part.text : part?.type === "image" ? "[Image attachment stored in transcript; image rendering is not supported here.]" : "").filter(Boolean).join("\n")
  : "";

// Map one Claude Code JSONL record to zero or more turns in the shared
// transcript shape ({role, content, recordKind?, author?}). Only persisted
// dialogue is kept: hook attachments, system/meta records, compaction
// summaries and sidechains are skipped. Tool names are learned from tool_use
// blocks so later tool_result turns carry them.
export function claudeTurns(record, toolNames) {
  if (record.isSidechain || record.isMeta || record.isCompactSummary) return [];
  if (record.type === "attachment") {
    const attachment = record.attachment;
    // A prompt typed while a turn was running is persisted only as this attachment.
    if (attachment?.type === "queued_command" && attachment.origin?.kind === "human" && typeof attachment.prompt === "string") {
      const kept = stripReminders(attachment.prompt);
      return kept ? [{ role: "user", content: kept }] : [];
    }
    return [];
  }
  const content = record.message?.content;
  if (record.type === "assistant") {
    if (!Array.isArray(content)) return typeof content === "string" ? [{ role: "assistant", content }] : [];
    const parts = content.map((part) => {
      if (part?.type !== "tool_use") return part;
      if (typeof part.id === "string") toolNames.set(part.id, part.name);
      return { type: "toolCall", name: part.name, arguments: part.input };
    });
    return [{ role: "assistant", content: parts, recordKind: record.message.model === "<synthetic>" ? "harness" : null }];
  }
  if (record.type !== "user") return [];
  if (typeof content === "string") {
    const turn = userString(record, content);
    return turn ? [turn] : [];
  }
  if (!Array.isArray(content)) return [];
  const turns = [];
  const ordinary = [];
  for (const part of content) {
    if (part?.type === "tool_result") {
      turns.push({ role: "toolResult", recordKind: "tools", author: toolNames.get(part.tool_use_id) || "Tool", content: resultText(part.content) });
    } else if (part?.type === "text" && /^\[Request interrupted by user[^\]]*\]$/.test(part.text.trim())) {
      turns.push({ role: "assistant", recordKind: "harness", author: "Claude Code", content: part.text });
    } else if (part?.type === "text") {
      const text = stripReminders(part.text);
      if (text) ordinary.push({ type: "text", text });
    } else if (part?.type === "image") ordinary.push(part);
  }
  if (ordinary.length) turns.unshift({ role: "user", content: ordinary });
  return turns;
}
