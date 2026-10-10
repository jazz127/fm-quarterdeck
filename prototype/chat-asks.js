import { classifyAnsweredCalls } from "./answered-calls.js";
import { inboxReceipts } from "./inbox.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { contentRevision, publicText, shortHash } from "./bearings.js";
import { enumeratedLetterOptions, publishOptions, replyDescription } from "./enumerated-options.js";
import { claudeTurns, findClaudePrimary } from "./claude-transcript.js";
import { createHistoryReader } from "./history-reader.js";
import { UNVERIFIED_INPUT } from "./authorship.js";

// Chat asks (BEARINGS.md "Chat asks"). Firstmate's captain-facing asks carry marker lines
// (ACTION NEEDED / APPROVAL NEEDED / DECISION NEEDED). This module turns every such line in
// the primary Firstmate transcript into a Captain's Call card by a fixed parse: no model,
// no Firstmate cooperation beyond the marker convention, and no write outside
// Quarterdeck's own state file. The transcript is read incrementally behind a byte cursor.
export const CHAT_ASKS_SCHEMA = "fm-quarterdeck-chat-asks.v1";
const KINDS = { ACTION: "action", APPROVAL: "approval", DECISION: "decision" };
const MAX_ASK_CHARS = 4000;
const MAX_REPLIES = 6;
const MAX_OPEN = 100;
const MAX_TOMBSTONES = 5000;
const MATCHING_VERSION = 4;

export function taskMarkers(text) {
  return [...new Set([...String(text).matchAll(/\[task:([A-Za-z0-9][A-Za-z0-9._-]{0,159})\]/g)].map(match => match[1]))];
}
const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------------------
// Pure extraction

// A marker is recognised only at the start of a line, after optional blockquote, list
// bullet, heading and emphasis markup, so prose that merely mentions a marker (inside
// backticks or mid-sentence) never becomes a card. Markers are upper case by convention.
const LEAD = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])\s+)?(?:#{1,6}\s+)?(?:\p{Extended_Pictographic}️?\s*)?(?:[*_]{1,3}\s*)?/u;
const MARKER = /^(ACTION|APPROVAL|DECISION) NEEDED(?![A-Za-z0-9_])/;
const AFTER_MARKER = /^\s*[*_]{0,3}\s*(?:[:—–]|-(?!-))?\s*[*_]{0,3}\s*/;
const FENCE = /^\s*(?:```|~~~)/;
const LANE_LINE = /^\s*\[(?:fm-lane|end)\s[^\]]*\]\s*$/;

function markerLine(line) {
  const lead = LEAD.exec(line)[0];
  const match = MARKER.exec(line.slice(lead.length));
  if (!match) return null;
  const rest = line.slice(lead.length + match[0].length);
  return { kind: KINDS[match[1]], marker: `${match[1]} NEEDED`, rest: rest.replace(AFTER_MARKER, "").trim() };
}

// Quoted alternatives after the word "reply": Reply **"yes"**, reply `ship` or `hold`,
// shortest reply: "go". Unquoted replies are ambiguous and are never guessed.
const REPLY = /\breply(?:\s+(?:with|exactly))?\s*:?\s*/gi;
const QUOTED = /^[*_]{0,3}\s*(?:"([^"\n]{1,200})"|“([^”\n]{1,200})”|`([^`\n]{1,200})`|'([^'\n]{1,200})'|‘([^’\n]{1,200})’)\s*[*_]{0,3}/;
const SEPARATOR = /^\s*(?:,|\/|\||\bor\b)\s*/i;
export function extractReplies(text) {
  const replies = [];
  for (const match of String(text).matchAll(REPLY)) {
    let rest = text.slice(match.index + match[0].length);
    for (;;) {
      const quoted = QUOTED.exec(rest);
      if (!quoted) break;
      const reply = quoted.slice(1).find(value => value !== undefined).trim();
      if (reply && !replies.includes(reply) && replies.length < MAX_REPLIES) replies.push(reply);
      rest = rest.slice(quoted[0].length);
      const separator = SEPARATOR.exec(rest);
      if (!separator) break;
      rest = rest.slice(separator[0].length);
    }
  }
  // Explicit option labels at the start of an ask/list line also supply replies:
  // - "stay here": continue; or "plan A" keeps the current setup.
  for (const line of String(text).split(/\r?\n/)) {
    const quoted = QUOTED.exec(line.slice(LEAD.exec(line)[0].length));
    if (!quoted) continue;
    const reply = quoted.slice(1).find(value => value !== undefined).trim();
    if (reply && !replies.includes(reply) && replies.length < MAX_REPLIES) replies.push(reply);
  }
  return replies;
}

const readable = (text) => text.replace(/\*\*|__/g, "").replace(/[ \t]+/g, " ").trim();

// Each marker line opens an ask; following non-blank lines continue it (a DECISION NEEDED
// line often introduces a list). A blank line, another marker, a code fence or a lane
// marker ends it. Code fences are skipped entirely: examples are not asks.
export function extractAsks(text) {
  const asks = [];
  let fence = false, current = null;
  const close = () => {
    if (!current) return;
    const raw = current.body.filter(Boolean).join("\n");
    const clipped = raw.length > MAX_ASK_CHARS ? `${raw.slice(0, MAX_ASK_CHARS - 1)}…` : raw;
    asks.push({ kind: current.kind, marker: current.marker, line: current.line, taskMarkers: taskMarkers(current.line), text: readable(clipped), replies: extractReplies(raw) });
    current = null;
  };
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) { close(); fence = !fence; continue; }
    if (fence) continue;
    const marker = markerLine(line);
    if (marker) { close(); current = { ...marker, line: line.trim(), body: [marker.rest] }; continue; }
    if (!current) continue;
    if (LANE_LINE.test(line)) { close(); continue; }
    if (!line.trim()) { if (current.body.some(Boolean)) close(); continue; }
    current.body.push(line.trim());
  }
  close();
  return asks;
}

// Case-folded words with punctuation/whitespace as separators.
export const normalizeReply = (text) => String(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const HOLD_QUOTE = /"([^"\n]{1,200})"|“([^”\n]{1,200})”|`([^`\n]{1,200})`|'([^'\n]{1,200})'|‘([^’\n]{1,200})’/g;
function matchesHold(ask, card) {
  if (!card.task) return false;
  if (ask.taskMarkers?.includes(card.task) || mentionsTask(ask.text, card.task)) return true;
  if (card.type !== "decision") return false;
  const replies = new Set(ask.replies.map(normalizeReply).filter(Boolean));
  return [card.summary, card.title, card.reason, card.backlogTitle, card.backlogReason].some(text => typeof text === "string" &&
    (replies.has(normalizeReply(text)) || [...text.matchAll(HOLD_QUOTE)].some(match => replies.has(normalizeReply(match.slice(1).find(value => value !== undefined))))));
}
// In-source byte order proves "later" even without clocks; known reversed clocks fail.
// Across sources only a strictly newer clock proves order. Equal timestamps alone do not.
function isLater(later, earlier) {
  if (later.at && earlier.at && later.at < earlier.at) return false;
  if (later.source === earlier.source) return later.offset > earlier.offset ||
    (later.offset === earlier.offset && later.recordId === earlier.recordId && later.part > earlier.part);
  return Boolean(later.at && earlier.at && later.at > earlier.at);
}
function repeatsAsk(later, earlier) {
  if (later.marker !== earlier.marker) return false;
  const replies = new Set(later.replies.map(normalizeReply).filter(Boolean));
  return earlier.replies.some(reply => replies.has(normalizeReply(reply))) ||
    normalizeReply(later.text) === normalizeReply(earlier.text);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A task id counts as mentioned only as a whole token; a sentence-ending period is not part of it.
export function mentionsTask(text, task) {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(task)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`).test(text);
}

// ---------------------------------------------------------------------------------------
// Transcript records → turns. Only the model's own text is an ask. A transcript role=user
// entry is unverified input (authorship.js), never the captain's reply, so it cannot
// resolve an ask. Harness traffic, machine envelopes, tools and thinking are ignored.
const MACHINE_TEXT = /^\W*(?:FIRSTMATE_OP:|FIRSTMATE SUPERVISION WAKE:|MAIN DIALOG MIRROR\b|<task-notification>)|^\s*<skill\b[^>]*>[\s\S]*<\/skill>\s*$/;
const textParts = (content) => typeof content === "string" ? [content] : Array.isArray(content)
  ? content.map((part) => part?.type === "text" && typeof part.text === "string" ? part.text : null) : [];
export function recordTurns(record, origin, toolNames = new Map()) {
  const turns = [];
  const push = (role, content) => textParts(content).forEach((text, part) => {
    if (typeof text === "string" && text.trim() && !(role === UNVERIFIED_INPUT.role && MACHINE_TEXT.test(text))) turns.push({ role, text, part });
  });
  if (origin === "claude") {
    for (const turn of claudeTurns(record, toolNames)) {
      if (turn.role === "assistant" && !turn.recordKind) push("firstmate", turn.content);
      else if (turn.role === "user") push(UNVERIFIED_INPUT.role, turn.content);
    }
  } else if (record?.type === "message" && ["user", "assistant"].includes(record.message?.role)) {
    push(record.message.role === "user" ? UNVERIFIED_INPUT.role : "firstmate", record.message.content);
  }
  return turns;
}

// ---------------------------------------------------------------------------------------
// Primary transcript discovery: the Claude Code primary for this home (same rule as Fleet
// Chats), the in-home `state/.main-session` pointer, and the main Pi session named by
// `state/.branch-mirror-cursor` when it lives in the home-encoded Pi directory with a
// session header for this exact home. Branch sessions and other homes are never read.
async function regularFile(file) {
  try {
    const info = await lstat(file);
    return info.isFile() && await realpath(file) === file;
  } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
}
export async function discoverPrimarySources(home, { claudeConfigDir = null, reader = createHistoryReader() } = {}) {
  const root = await realpath(home);
  const warnings = [];
  const sources = [];
  const claude = await findClaudePrimary(root, claudeConfigDir, reader, warnings);
  if (claude) sources.push({ file: claude.file, source: `claude-main-session/${path.basename(claude.file)}`, origin: "claude", inferred: claude.inferred });
  const pointer = async (name) => {
    try { return (await reader.text(path.join(root, "state", name))).trim(); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const mainPointer = await pointer(".main-session");
  if (mainPointer) {
    const file = path.resolve(root, mainPointer);
    let resolved = null;
    try { resolved = await realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (resolved?.startsWith(`${root}${path.sep}`) && resolved.endsWith(".jsonl") && (await stat(resolved)).isFile()) {
      sources.push({ file: resolved, source: path.relative(root, resolved).split(path.sep).join("/"), origin: "pi" });
    } else warnings.push("state/.main-session does not name a transcript inside FM_HOME.");
  }
  const cursor = await pointer(".branch-mirror-cursor");
  if (cursor) {
    let target = null;
    try { target = JSON.parse(cursor).file; } catch { warnings.push("state/.branch-mirror-cursor is malformed."); }
    const encodedHome = `--${root.replace(/^\/+/, "").replaceAll("/", "-")}--`;
    if (typeof target === "string" && path.isAbsolute(target) && !target.startsWith(`${root}${path.sep}`) && target.endsWith(".jsonl") &&
        path.basename(path.dirname(target)) === encodedHome && await regularFile(target)) {
      let header = null;
      try { header = JSON.parse(await reader.firstLine(target)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (header?.type === "session" && header.cwd === root) sources.push({ file: target, source: `main-pi-session/${path.basename(target)}`, origin: "pi" });
      else warnings.push("The main Pi session has no matching home session header; not read.");
    }
  }
  const seen = new Set();
  return { sources: sources.filter(({ file }) => !seen.has(file) && seen.add(file)), warnings };
}

// ---------------------------------------------------------------------------------------
// State: one JSON document beside Quarterdeck's presentation state, outside FM_HOME.
//   cursors{source → {ino, offset, skip}}  where the next read starts
//   asks{key → ask}                         open and recently resolved asks
//   tombstones{key → resolvedAt}            resolved keys, so a re-read never revives them
export const chatAsksPath = (agentStatePath) => `${agentStatePath}.chat-asks.json`;
export const emptyChatState = () => ({ schema: CHAT_ASKS_SCHEMA, matchingVersion: MATCHING_VERSION, cursors: {}, asks: {}, tombstones: {} });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function validState(state) {
  return isObject(state) && state.schema === CHAT_ASKS_SCHEMA && isObject(state.cursors) && isObject(state.asks) && isObject(state.tombstones) ? state : null;
}
function createStateFile(file) {
  async function read() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 8 * MiB) throw new Error("Invalid chat-ask state file");
      return validState(JSON.parse(await readFile(file, "utf8"))) || (() => { throw new Error("Invalid chat-ask state schema"); })();
    } catch (error) { if (error.code === "ENOENT") return emptyChatState(); throw error; }
  }
  // Same discipline as agent-state.js: exclusive lock file, temp file, fsync, rename. A busy
  // lock is never stolen; the caller keeps its cursor and retries on the next scan.
  async function update(change) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 50 && !lock; attempt++) {
      try { lock = await open(`${file}.lock`, "wx", 0o600); }
      catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (!lock) throw new Error("Chat-ask state busy");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const state = await read();
      const result = await change(state);
      if (result?.write !== false) {
        const handle = await open(temp, "wx", 0o600);
        try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); } finally { await handle.close(); }
        await rename(temp, file);
      }
      return { state, result };
    } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(`${file}.lock`).catch(() => {}); }
  }
  return { read, update };
}
export function memoryStateFile(initial = emptyChatState()) {
  let state = structuredClone(initial);
  return {
    read: async () => structuredClone(state),
    update: async (change) => { const draft = structuredClone(state); const result = await change(draft); state = draft; return { state: structuredClone(draft), result }; },
  };
}

// ---------------------------------------------------------------------------------------
// Incremental reader: whole lines from the cursor, at most maxBytes per source per scan.
// A line longer than maxLineBytes is skipped to its newline (cursor.skip), never parsed.
async function readNewLines(file, cursor, { maxBytes, maxLineBytes, backfillBytes, onLine }) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    let { offset, skip } = cursor;
    let backfillOmittedBytes = 0;
    if (cursor.ino !== info.ino || info.size < offset) {
      // New or rewritten source: start from its newest backfillBytes of whole records.
      offset = Math.max(0, info.size - backfillBytes);
      skip = offset > 0;
      backfillOmittedBytes = offset;
    }
    const end = Math.min(info.size, offset + maxBytes);
    let position = offset, carry = Buffer.alloc(0), carryStart = offset;
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(MiB, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      let data = chunk.subarray(0, bytesRead), base = position;
      position += bytesRead;
      let start = 0;
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10, start)) {
        if (skip) { skip = false; start = newline + 1; carry = Buffer.alloc(0); carryStart = base + start; offset = carryStart; continue; }
        const line = carry.length ? Buffer.concat([carry, data.subarray(start, newline)]) : data.subarray(start, newline);
        if (line.length <= maxLineBytes) await onLine(line, carry.length ? carryStart : base + start);
        carry = Buffer.alloc(0);
        start = newline + 1;
        carryStart = base + start;
        offset = carryStart;
      }
      if (!skip && start < data.length) {
        carry = carry.length ? Buffer.concat([carry, data.subarray(start)]) : Buffer.from(data.subarray(start));
        if (carry.length > maxLineBytes) { skip = true; carry = Buffer.alloc(0); }
      }
      if (skip) offset = position;
    }
    return { cursor: { ino: info.ino, offset, skip: Boolean(skip) }, behind: info.size > end, backfillOmittedBytes };
  } finally { await handle.close(); }
}

// ---------------------------------------------------------------------------------------
// The scanner owns the chat-ask state. scan() is cheap when nothing grew (stat only).
export function createChatAskScanner({ home, claudeConfigDir = null, statePath = null, store = statePath ? createStateFile(statePath) : memoryStateFile(),
  now = Date.now, discover = discoverPrimarySources, discoverEveryMs = 30000, backfillBytes = 4 * MiB, backfillMaxAgeMs = 24 * 3600 * 1000,
  maxScanBytes = 4 * MiB, maxLineBytes = 2 * MiB } = {}) {
  let state = null;
  let view = { state: home ? "loading" : "unavailable", error: home ? null : "FM_HOME is not configured", checkedAt: null, sources: [], warnings: [] };
  let sources = null, discoveredAt = -Infinity, scanning = null;
  const sourceStatus = new Map();

  const openAsks = () => Object.values(state?.asks || {}).filter((ask) => ask.status === "open");
  function resolveAsk(target, ask, by, extra = {}) {
    if (!ask || ask.status !== "open") return false;
    Object.assign(ask, { status: "resolved", resolvedBy: by, resolvedAt: new Date(now()).toISOString(), ...extra });
    target.tombstones[ask.key] = ask.resolvedAt;
    return true;
  }
  function prune(target) {
    const resolved = Object.values(target.asks).filter((ask) => ask.status !== "open").sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt)));
    for (const ask of resolved.slice(50)) delete target.asks[ask.key];
    const tombs = Object.entries(target.tombstones).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    for (const [key] of tombs.slice(MAX_TOMBSTONES)) delete target.tombstones[key];
  }

  // Apply one parsed record. Repeated marker+reply supersedes an older ask. Unverified
  // session input never resolves an ask. All matching stays within the record byte cap.
  function applyRecord(target, record, { source, origin, offset, backfill }, toolNames) {
    const at = (() => { const value = new Date(record.timestamp ?? record.message?.timestamp); return Number.isNaN(value.valueOf()) ? null : value.toISOString(); })();
    const recordId = (origin === "claude" ? record.uuid : record.id) || `${source}@${offset}`;
    let changed = false;
    for (const turn of recordTurns(record, origin, toolNames)) {
      if (turn.role === "firstmate") {
        for (const found of extractAsks(turn.text)) {
          const key = `chat:${shortHash([recordId, turn.part, found.line])}`;
          if (target.tombstones[key] || (target.asks[key] && target.asks[key].status !== "open")) continue;
          const existing = target.asks[key];
          const ask = existing || { key, kind: found.kind, marker: found.marker, text: found.text, taskMarkers: found.taskMarkers, replies: found.replies, source, offset, part: turn.part, recordId, at, status: "open", linkedTasks: [] };
          // Replay refreshes extraction on existing open cards, not just their cursors.
          if (existing && (JSON.stringify(existing.replies) !== JSON.stringify(found.replies) || JSON.stringify(existing.taskMarkers) !== JSON.stringify(found.taskMarkers))) {
            existing.taskMarkers = found.taskMarkers;
            existing.replies = found.replies;
            changed = true;
          }
          // A backfill of a long-lived transcript must not resurface asks from days ago.
          if (!existing && backfill && at && now() - Date.parse(at) > backfillMaxAgeMs) {
            target.tombstones[key] = new Date(now()).toISOString();
            changed = true;
            continue;
          }
          for (const older of Object.values(target.asks)) {
            if (older.status === "open" && isLater(ask, older) && repeatsAsk(ask, older)) changed = resolveAsk(target, older, "superseded", { supersededBy: key }) || changed;
          }
          if (!existing) { target.asks[key] = ask; changed = true; }
        }
      }
    }
    return changed;
  }

  async function sourcesNow() {
    if (sources && now() - discoveredAt < discoverEveryMs) return sources;
    const found = await discover(home, { claudeConfigDir });
    sources = found.sources;
    discoveredAt = now();
    view = { ...view, warnings: found.warnings };
    return sources;
  }

  async function scanOnce() {
    if (!home) return false;
    try {
      const active = await sourcesNow();
      state ||= await store.read();
      // One bounded replay repairs already-open cards when matching rules change. Keep
      // asks and tombstones: accepted answers/dismissals must never be revived.
      if (state.matchingVersion !== MATCHING_VERSION) {
        ({ state } = await store.update(target => {
          target.cursors = {};
          target.matchingVersion = MATCHING_VERSION;
          return { write: true };
        }));
      }
      // Cheap path: nothing grew since the cursor and the state file is ours.
      const grown = [];
      for (const entry of active) {
        let info = null;
        try { info = await stat(entry.file); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const cursor = state.cursors[entry.source];
        if (info && (!cursor || cursor.ino !== info.ino || cursor.offset !== info.size)) grown.push(entry);
        else if (info) sourceStatus.set(entry.source, { source: entry.source, behind: false, backfillOmittedBytes: sourceStatus.get(entry.source)?.backfillOmittedBytes ?? 0 });
      }
      let changed = false;
      if (grown.length) {
        const { state: next, result } = await store.update(async (target) => {
          let asksChanged = false, cursorMoved = false;
          for (const entry of grown) {
            const prior = target.cursors[entry.source] || { ino: null, offset: 0, skip: false };
            const backfill = prior.ino === null;
            const toolNames = new Map();
            const outcome = await readNewLines(entry.file, prior, { maxBytes: maxScanBytes, maxLineBytes, backfillBytes, onLine: async (line, offset) => {
              // Only Firstmate's own marker lines matter; session input never resolves an
              // ask. The whole-record cap bounds parsing. Adapters still exclude tool
              // output, hooks and machine traffic.
              if (!line.includes("NEEDED")) return;
              let record;
              try { record = JSON.parse(line.toString("utf8")); } catch { return; }
              if (applyRecord(target, record, { source: entry.source, origin: entry.origin, offset, backfill }, toolNames)) asksChanged = true;
            } });
            const before = target.cursors[entry.source];
            if (!before || before.ino !== outcome.cursor.ino || before.offset !== outcome.cursor.offset || before.skip !== outcome.cursor.skip) cursorMoved = true;
            target.cursors[entry.source] = outcome.cursor;
            sourceStatus.set(entry.source, { source: entry.source, behind: outcome.behind, backfillOmittedBytes: outcome.backfillOmittedBytes || sourceStatus.get(entry.source)?.backfillOmittedBytes || 0 });
          }
          // Cursors for sources no longer discovered are kept briefly so a rotation back resumes.
          const names = Object.keys(target.cursors);
          for (const name of names.slice(0, Math.max(0, names.length - 20))) if (!active.some((entry) => entry.source === name)) delete target.cursors[name];
          prune(target);
          return { dirty: asksChanged, write: asksChanged || cursorMoved };
        });
        state = next;
        changed = result.dirty;
      }
      const behind = [...sourceStatus.values()].some((entry) => entry.behind);
      view = { ...view, state: "ready", error: null, checkedAt: new Date(now()).toISOString(), behind,
        sources: active.map((entry) => sourceStatus.get(entry.source) || { source: entry.source, behind: false, backfillOmittedBytes: 0 }) };
      return changed;
    } catch (error) {
      view = { ...view, state: state ? "stale" : "unavailable", error: `Chat asks unavailable: ${error.code || error.message}`, checkedAt: new Date(now()).toISOString() };
      return false;
    }
  }

  async function mutate(change) {
    const { state: next, result } = await store.update(async (target) => change(target));
    state = next;
    return result;
  }

  return {
    // Coalesces concurrent callers; resolves true when open asks changed.
    scan: () => (scanning ||= scanOnce().finally(() => { scanning = null; })),
    view: () => ({ ...view, resolved: Object.values(state?.asks || {}).filter(ask => ask.status === "resolved" && ask.resolutionSource)
      .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt))).slice(0, 50)
      .map(ask => ({ key: ask.key, status: "answered", resolvedAt: ask.resolvedAt, tasks: ask.resolvedTasks, source: ask.resolutionSource, resolutions: ask.holdResolutions || [] })) }),
    asks: () => openAsks(),
    // Link by task id or a filed decision's quoted reply. String task ids remain supported
    // for callers with no card text. Ledger evidence also covers holds omitted by bearings.
    async applySnapshot(cards, fresh, holds = [], omitted = []) {
      if (!state) return false;
      const evidence = fresh ? holds : [];
      cards = cards.map(card => typeof card === "string" ? { task: card } : card);
      cards = [...cards, ...evidence];
      const tasks = cards.filter(card => !card.closed).map(card => card.task).filter(Boolean);
      const closed = new Map(evidence.filter(row => row.closed).map(row => [row.task, row]));
      const closure = ask => {
        const rows = ask.linkedTasks.map(task => closed.get(task));
        if (rows.length && rows.every(Boolean)) return { resolvedTasks: ask.linkedTasks, resolutionSource: "data/backlog.md", holdResolutions: rows.map(row => ({ task: row.task, resolution: row.resolution })) };
        // Missing calls can be bucketed/aged/bounded rather than answered.
        if (fresh && !omitted.length && ask.linkedTasks.length && !ask.linkedTasks.some(task => tasks.includes(task))) return { resolvedTasks: ask.linkedTasks, resolutionSource: "bearings snapshot" };
        return null;
      };
      const work = openAsks().some((ask) => cards.some(card => !ask.linkedTasks.includes(card.task) && matchesHold(ask, card)))
        || openAsks().some(ask => closure(ask));
      if (!work) return false;
      return (await mutate((target) => {
        let dirty = false;
        for (const ask of Object.values(target.asks)) {
          if (ask.status !== "open") continue;
          for (const card of cards) if (!ask.linkedTasks.includes(card.task) && matchesHold(ask, card)) { ask.linkedTasks.push(card.task); dirty = true; }
          const resolved = closure(ask);
          if (resolved) dirty = resolveAsk(target, ask, "answered", resolved) || dirty;
        }
        return { dirty, write: dirty };
      })).dirty;
    },
    async resolve(key, by, extra = {}) {
      return (await mutate((target) => {
        const dirty = resolveAsk(target, target.asks[key], by, extra);
        return { dirty, write: dirty };
      })).dirty;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Cards. A chat card answers through the same keyed relay as a snapshot card: question
// chat.<id>, the quoted replies as options, and freeform text.
export const chatQuestion = (key) => `chat.${key.slice("chat:".length)}`;
const describedHint = (text, reply) => publicText(replyDescription(text, reply), 240);
export function chatCard(ask) {
  let options = ask.replies.map((reply, index) => ({ value: `reply-${index + 1}`, label: publicText(reply, 200), hint: describedHint(ask.text, reply) || "Firstmate's suggested reply" })).filter((option) => option.label);
  if (!options.length && (ask.kind === "decision" || ask.kind === "approval")) {
    const fromText = publishOptions(enumeratedLetterOptions(ask.text), publicText);
    if (fromText.length) {
      options = fromText;
    } else {
      options = [
        { value: "yes", label: "Yes", hint: "Approve or confirm" },
        { value: "no", label: "No", hint: "Reject or discard" }
      ];
    }
  }
  const card = { key: ask.key, type: "chat", kind: ask.kind, marker: ask.marker, summary: publicText(ask.text, Infinity) || `${ask.marker} (no text)`, replies: options.map((option) => option.label),
    source: ask.source.split("/")[0], transcript: { offset: ask.offset, part: ask.part }, clock: { label: "Asked", at: ask.at },
    answer: { question: chatQuestion(ask.key), options, recommend: null, close: null, freeform: true } };
  return { ...card, rev: shortHash(card) };
}
const linkedEntry = (ask) => {
  const replies = ask.replies.map((reply) => publicText(reply, 200)).filter(Boolean);
  const replyHints = {};
  for (const reply of replies) {
    const hint = describedHint(ask.text, reply);
    if (hint) replyHints[reply] = hint;
  }
  return { key: ask.key, kind: ask.kind, summary: publicText(ask.text, Infinity) || ask.marker, replies, ...(Object.keys(replyHints).length ? { replyHints } : {}), clock: { label: "Asked", at: ask.at } };
};
// A filed decision with no structured choices offers lettered lines from a linked decision ask.
function withLinkedChoices(card, entries) {
  const chatAsks = entries.map(linkedEntry);
  const next = { ...card, chatAsks };
  const existing = Array.isArray(next.answer?.options) ? next.answer.options : [];
  if (next.type !== "decision" || existing.length || !next.answer) return next;
  let best = [];
  for (const ask of entries) {
    if (ask.kind !== "decision") continue;
    const options = publishOptions(enumeratedLetterOptions(ask.text), publicText);
    if (options.length > best.length) best = options;
  }
  if (!best.length) return next;
  return { ...next, answer: { ...next.answer, options: best } };
}

// Compose the served model: snapshot cards first (each carrying the chat asks linked to it),
// then unlinked open chat asks, newest first, at most MAX_OPEN.
export function composeCallModel(base, asks, chatView) {
  const tasks = new Set(base.cards.map((card) => card.task).filter(Boolean));
  const linked = new Map();
  const unlinked = [];
  for (const ask of asks) {
    // The snapshot can finish between a scan and a cache read (including cold GETs
    // without a stream subscription). Dedup at composition too, before any publication.
    const task = ask.linkedTasks.find((name) => tasks.has(name)) || base.cards.find(card => matchesHold(ask, card))?.task;
    if (task) linked.set(task, [...(linked.get(task) || []), ask]);
    else unlinked.push(ask);
  }
  unlinked.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const cards = base.cards.map((card) => {
    const entries = linked.get(card.task);
    let rest = card;
    let modified = false;
    if (entries) {
      const { rev, ...withoutRev } = card;
      rest = withLinkedChoices(withoutRev, entries);
      modified = true;
    }
    
    // Fallback: derive Yes/No options if the card is a decision and still has no structured options
    if (rest.type === "decision" && rest.answer && (!rest.answer.options || !rest.answer.options.length)) {
      if (!modified) {
        const { rev, ...withoutRev } = rest;
        rest = withoutRev;
      }
      rest = {
        ...rest,
        answer: {
          ...rest.answer,
          options: [
            { value: "yes", label: "Yes", hint: "Approve or confirm" },
            { value: "no", label: "No", hint: "Reject or discard" }
          ]
        }
      };
      modified = true;
    }
    
    if (modified) {
      return { ...rest, rev: shortHash(rest) };
    }
    return card;
  });
  const chatCards = unlinked.slice(0, MAX_OPEN).map(chatCard);
  const chat = { state: chatView.state, error: chatView.error, open: unlinked.length, linked: asks.length - unlinked.length, omitted: Math.max(0, unlinked.length - MAX_OPEN), behind: Boolean(chatView.behind),
    sources: chatView.sources.map(({ source, backfillOmittedBytes }) => ({ source: source.split("/")[0], backfillOmittedBytes })), resolved: chatView.resolved || [] };
  const content = { cards: [...cards, ...chatCards], coverage: base.coverage, omitted: base.omitted, chat };
  return { ...base, cards: content.cards, chat, chatCheckedAt: chatView.checkedAt, rev: shortHash([contentRevision(content), chat]) };
}

// Wrap the snapshot hub so every consumer (GET, ?since, the stream, answers) sees one
// composed model. Chat scanning runs on each read and every scanEveryMs while streamed.
export function createCallSource({ hub, chat, home = null, receipts = inboxReceipts, timers = globalThis, scanEveryMs = 3000 } = {}) {
  let answerReceipts = null, receiptsSignature = "", receiptsCheckedAt = 0;
  let composed = null, composedFrom = null;
  const listeners = new Set();
  let timer = null;
  const freshness = () => { const model = current(); return { rev: model.rev, state: model.state, observedAt: model.observedAt, checkedAt: model.checkedAt, stale: model.stale, error: model.error }; };
  // Recompose only when the hub published a new model object or the chat asks changed.
  let composedBase = null;
  function current() {
    const base = hub.current();
    const asks = chat.asks();
    const view = chat.view();
    const signature = JSON.stringify([asks.map((ask) => [ask.key, ask.linkedTasks]), view.state, view.error, view.behind, view.sources, view.checkedAt, receiptsSignature]);
    if (base !== composedBase || signature !== composedFrom) { composed = composeCallModel(base, asks, view); composed.cards = classifyAnsweredCalls(composed.cards, answerReceipts); composed.rev = shortHash([contentRevision(composed), composed.chat]); composedBase = base; composedFrom = signature; }
    return composed;
  }
  const applyHolds = () => { const base = hub.current(); return chat.applySnapshot(base.cards, fresh(), base.holds || [], base.omitted || []); };
  const fresh = () => hub.current().state === "ready";
  let lastRev = null;
  function emit() {
    const model = current();
    const changed = model.rev !== lastRev;
    lastRev = model.rev;
    const event = changed ? { type: "model", model } : { type: "observed", ...freshness() };
    for (const listener of [...listeners]) { try { listener(event); } catch {} }
  }
  let refreshing = null;
  const refresh = () => (refreshing ||= (async () => {
    if (home && Date.now() - receiptsCheckedAt >= 15000) {
      receiptsCheckedAt = Date.now();
      try { answerReceipts = await receipts(home); receiptsSignature = JSON.stringify(answerReceipts); } catch { /* Keep the last durable evidence on a failed read. */ }
    }
    await chat.scan();
    await applyHolds().catch(() => false);
  })().finally(() => { refreshing = null; }));
  // A scan publishes only new content. Unchanged scans stay silent: every observed event
  // costs each stream a revision check and an activity read, and the stream's own
  // heartbeat already carries freshness.
  async function tick() {
    await refresh();
    if (current().rev !== lastRev) emit();
  }
  let unsubscribeHub = null;
  return {
    current,
    freshness,
    refresh,
    chat,
    subscribe(listener) {
      listeners.add(listener);
      lastRev ??= current().rev;
      unsubscribeHub ||= hub.subscribe(async (event) => {
        if (event.type === "model") await applyHolds().catch(() => false);
        emit();
      });
      timer ||= timers.setInterval(() => { void tick(); }, scanEveryMs);
      void tick();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { timers.clearInterval(timer); timer = null; unsubscribeHub?.(); unsubscribeHub = null; }
      };
    },
    // Quarterdeck's own resolutions (answered, dismissed) are pushed at once.
    async resolveChat(key, by, extra) {
      const before = current().rev;
      const done = await chat.resolve(key, by, extra);
      if (current().rev !== before) emit();
      return done;
    },
    touch() { hub.touch(); void tick(); },
    request: (...args) => hub.request?.(...args),
    stats: () => ({ ...hub.stats?.(), chat: chat.view().state }),
    close() { listeners.clear(); timers.clearInterval(timer); timer = null; unsubscribeHub?.(); unsubscribeHub = null; hub.close?.(); },
  };
}

export const chatAskKey = (value) => typeof value === "string" && /^chat:[0-9a-f]{16}$/.test(value);
