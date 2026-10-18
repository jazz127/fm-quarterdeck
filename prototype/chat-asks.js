import { extractAsks, extractAskSections, extractReplies, taskMarkers } from "./public/chat-ask-extraction.js";
export { extractAsks, extractReplies, taskMarkers } from "./public/chat-ask-extraction.js";
import { classifyAnsweredCalls } from "./answered-calls.js";
import { inboxReceipts } from "./inbox.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { contentRevision, publicText, shortHash } from "./bearings.js";
import { enumeratedLetterOptions, publishOptions, replyDescription } from "./enumerated-options.js";
import { claudeAwaySummary, claudeTurns, findClaudePrimary } from "./claude-transcript.js";
import { createHistoryReader } from "./history-reader.js";
import { UNVERIFIED_INPUT } from "./authorship.js";
import { parseBacklogTask, parseStatusLine } from "./firstmate-records.js";

// Chat asks (BEARINGS.md "Chat asks"). Firstmate's captain-facing asks carry marker lines
// (ACTION NEEDED / APPROVAL NEEDED / DECISION NEEDED). This module turns every such line in
// the primary Firstmate transcript into a Captain's Call card by a fixed parse: no model,
// no Firstmate cooperation beyond the marker convention, and no write outside
// Quarterdeck's own state file. The transcript is read incrementally behind a byte cursor.
export const CHAT_ASKS_SCHEMA = "fm-quarterdeck-chat-asks.v1";
const MAX_OPEN = 100;
const MAX_TOMBSTONES = 5000;
const MATCHING_VERSION = 5;

const MiB = 1024 * 1024;

// Case-folded words with punctuation/whitespace as separators.
export const normalizeReply = (text) => String(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const HOLD_QUOTE = /"([^"\n]{1,200})"|“([^”\n]{1,200})”|`([^`\n]{1,200})`|'([^'\n]{1,200})'|‘([^’\n]{1,200})’/g;
function matchesHold(ask, card) {
  if (card.readOnly || !card.task) return false;
  const localTask = card.localTask || card.task.split("/").at(-1);
  const owner = card.owner || "(main)";
  if (ask.taskLinks?.some(link => link.owner !== owner)
    || ask.linkedTasks?.some(task => task.includes("/") && !task.startsWith(`${owner}/`))) return false;
  const owned = ask.taskLinks?.some(link => link.owner === owner && link.localTask === localTask)
    || ask.linkedTasks?.includes(`${owner}/${localTask}`);
  if (owned) return true;
  if (!ask.linkedTasks?.includes(localTask) && (ask.taskMarkers?.includes(card.task) || mentionsTask(ask.text, card.task))) return true;
  if (card.type !== "decision") return false;
  // Shared reply text cannot establish an ambiguous legacy link's local ownership.
  if (owner === "(main)" && ask.linkedTasks?.some(task => !task.includes("/")
    && !ask.taskLinks?.some(link => link.task === task))) return false;
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
// Explicit [task:<id>] markers that differ name independent calls, so a shared generic
// reply such as Yes/No is not a repeat. Unmarked asks keep reply-based supersession.
const markedForDifferentTasks = (later, earlier) => Boolean(later.taskMarkers?.length && earlier.taskMarkers?.length) &&
  [...later.taskMarkers].sort().join("\n") !== [...earlier.taskMarkers].sort().join("\n");
function repeatsAsk(later, earlier) {
  if (later.marker !== earlier.marker) return false;
  const replies = new Set(later.replies.map(normalizeReply).filter(Boolean));
  return (!markedForDifferentTasks(later, earlier) && earlier.replies.some(reply => replies.has(normalizeReply(reply)))) ||
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
async function readNewLines(file, cursor, { maxBytes, maxLineBytes, backfillBytes, onLine, onSkip = () => {} }) {
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
        if (skip) { onSkip(); skip = false; start = newline + 1; carry = Buffer.alloc(0); carryStart = base + start; offset = carryStart; continue; }
        const line = carry.length ? Buffer.concat([carry, data.subarray(start, newline)]) : data.subarray(start, newline);
        if (line.length <= maxLineBytes) await onLine(line, carry.length ? carryStart : base + start);
        else onSkip();
        carry = Buffer.alloc(0);
        start = newline + 1;
        carryStart = base + start;
        offset = carryStart;
      }
      if (!skip && start < data.length) {
        carry = carry.length ? Buffer.concat([carry, data.subarray(start)]) : Buffer.from(data.subarray(start));
        if (carry.length > maxLineBytes) { onSkip(); skip = true; carry = Buffer.alloc(0); }
      }
      if (skip) offset = position;
    }
    return { cursor: { ino: info.ino, offset, skip: Boolean(skip) }, behind: info.size > end, backfillOmittedBytes, limited: skip || carry.length > 0 };
  } finally { await handle.close(); }
}

// Explicit MAIN-owned historical-answer selection, never transcript/receipt inference.
// The callback supplies exact file ranges; this boundary reads and validates the actual
// monitored Pi records and native owner ledger/archive/parent events. No callback means
// no reads, no added authority, and no change to ordinary user-record authorship.
const historicalRefused = (code) => { throw new Error(code); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const historicalTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : historicalRefused("clock");
const historicalId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
async function historicalRange(ref, expectedFile, { line = false, item = false, limit = 64 * 1024 } = {}) {
  if (!ref || ref.file !== expectedFile || !path.isAbsolute(expectedFile) || !Number.isSafeInteger(ref.offset) || ref.offset < 0 ||
      !Number.isSafeInteger(ref.length) || ref.length < 1 || ref.length > limit || !/^[a-f0-9]{64}$/.test(ref.sha256 || "") ||
      !Number.isSafeInteger(ref.identity?.dev) || !Number.isSafeInteger(ref.identity?.ino)) historicalRefused("file-reference");
  if (!await regularFile(expectedFile)) historicalRefused("file-identity");
  const handle = await open(expectedFile, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== ref.identity.dev || before.ino !== ref.identity.ino || ref.offset + ref.length > before.size || await realpath(expectedFile) !== expectedFile) historicalRefused("file-identity");
    if (ref.offset) {
      const previous = Buffer.alloc(1);
      if ((await handle.read(previous, 0, 1, ref.offset - 1)).bytesRead !== 1 || previous[0] !== 10) historicalRefused("record-boundary");
    }
    const bytes = Buffer.alloc(ref.length);
    let read = 0;
    while (read < bytes.length) {
      const next = await handle.read(bytes, read, bytes.length - read, ref.offset + read);
      if (!next.bytesRead) historicalRefused("record-boundary");
      read += next.bytesRead;
    }
    if (bytes.at(-1) !== 10 || (line && bytes.subarray(0, -1).includes(10))) historicalRefused("record-boundary");
    // A canonical item range must include its whole body, not a selectively projected
    // answer hiding a later hold/context. Inspect only the next item/heading delimiter.
    if (item && ref.offset + ref.length < before.size) {
      const next = Buffer.alloc(8);
      const tail = await handle.read(next, 0, next.length, ref.offset + ref.length);
      if (!/^(?:- \[[ xX]\] |## )/.test(next.subarray(0, tail.bytesRead).toString("utf8"))) historicalRefused("item-boundary");
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || sha256(bytes) !== ref.sha256) historicalRefused("record-digest");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}
function historicalItem(text, task) {
  // Native items end in one newline; one ahead of a backlog section or a later note-archive
  // block also carries one blank separator line. Neither is body content.
  const lines = text.replace(/\n\n?$/, "").split("\n");
  const match = /^- \[([ xX])\] (\S+) - (.+)$/.exec(lines[0]);
  if (!match || match[2] !== task || lines.slice(1).some(line => /^\s*- \[[ xX]\] \S+ - |^## /.test(line))) historicalRefused("owner-item");
  return { parsed: parseBacklogTask(match[3], match[1] !== " "), body: lines.slice(1).join("\n") };
}
function historicalTarget(ask, record, claim, source) {
  if (!ask || ask.status !== "open" || ask.linkedTasks.length || ask.source !== source.source || ask.recordId !== claim.request.eventId ||
      ask.offset !== claim.request.ref.offset || ask.part !== claim.request.part || chatCard(ask).rev !== claim.request.rev ||
      (ask.holdVersion ?? null) !== (claim.request.holdVersion ?? null)) historicalRefused("current-target");
  if (record.type !== "message" || record.id !== ask.recordId || record.message?.role !== "assistant") historicalRefused("request-event");
  const turn = recordTurns(record, "pi").find(turn => turn.part === ask.part && turn.role === "firstmate");
  const at = new Date(historicalTime(record.timestamp)).toISOString();
  const found = turn && extractAsks(turn.text).find(found => `chat:${shortHash([record.id, turn.part, found.line])}` === ask.key);
  if (!found || ask.key !== claim.request.key || ask.at !== at || ["kind", "marker", "text", "taskMarkers", "replies"].some(name => JSON.stringify(ask[name]) !== JSON.stringify(found[name]))) historicalRefused("request-identity");
}
async function validateHistoricalAnswer(claim, { home, sources, ask, now, maxLineBytes }) {
  if (!claim?.request || !claim?.answer || !claim?.owner || !historicalId(claim.request.eventId) || !historicalId(claim.answer.eventId)) historicalRefused("association");
  const source = sources.find(source => source.source === claim.request.source && source.file === claim.request.ref?.file && source.origin === "pi");
  if (!source || claim.answer.ref?.file !== source.file) historicalRefused("monitored-source");
  if (!Number.isSafeInteger(claim.request.part) || claim.request.part < 0 || !Number.isSafeInteger(claim.answer.part) || claim.answer.part < 0) historicalRefused("part");
  const request = JSON.parse(await historicalRange(claim.request.ref, source.file, { line: true, limit: maxLineBytes }));
  historicalTarget(ask, request, claim, source);
  const answer = JSON.parse(await historicalRange(claim.answer.ref, source.file, { line: true, limit: maxLineBytes }));
  const answerTurn = recordTurns(answer, "pi").find(turn => turn.part === claim.answer.part && turn.role === UNVERIFIED_INPUT.role);
  if (answer.type !== "message" || answer.id !== claim.answer.eventId || answer.message?.role !== "user" || !answerTurn || MACHINE_TEXT.test(answerTurn.text)) historicalRefused("answer-event");
  if (!/^[a-f0-9]{64}$/.test(claim.answer.digest || "") || sha256(answerTurn.text) !== claim.answer.digest) historicalRefused("answer-digest");
  const owner = claim.owner;
  if (!historicalId(owner.task) || !historicalId(owner.fleet) || !path.isAbsolute(owner.home || "") || await realpath(owner.home) !== owner.home ||
      !Number.isSafeInteger(owner.occurrence) || owner.occurrence < 1 || owner.parentKey !== `captain-hold-${owner.task}-${owner.occurrence}` ||
      ask.taskMarkers.length !== 1 || ask.taskMarkers[0] !== owner.task) historicalRefused("owner");
  const held = historicalItem(await historicalRange(owner.held, path.join(owner.home, "data", "note-archive.md"), { item: true }), owner.task);
  const resolution = historicalItem(await historicalRange(owner.resolution, path.join(owner.home, "data", "backlog.md"), { item: true }), owner.task);
  const prior = [...held.body.matchAll(/^  Resolution recorded by fm-captain-hold\.$/gm)].length;
  const stamp = /^  Captain hold set: (\S+)$/gm;
  const stamps = [...held.body.matchAll(stamp)].map(match => match[1]);
  if (held.parsed.holdKind !== "captain" || !held.parsed.holdActive || !held.parsed.holdReason?.trim() || stamps.length !== 1 || stamps[0] !== owner.heldAt || owner.occurrence !== prior + 1 ||
      resolution.parsed.holdActive || !["released", "answered"].includes(owner.mode)) historicalRefused("owner-occurrence");
  const prefix = `  Resolution recorded by fm-captain-hold.\n  Decision digest: ${claim.answer.digest}\n  Resolution mode: ${owner.mode}\n\n  Captain decision:\n`;
  const decision = answerTurn.text.split("\n").map(line => line ? `  ${line}` : "").join("\n");
  const previous = held.body.replace(/^  Captain hold set: \S+(?:\n\n|\n|$)/, "");
  // Native release prepends the new exact answer and preserves the prior body. This
  // checks the recorded occurrence, actual bytes and retained history, not task Done.
  if (resolution.body !== `${prefix}${decision}${previous && `\n\n${previous}`}`) historicalRefused("owner-resolution");
  const parentFile = path.join(home, "state", `${owner.fleet}.status`);
  const event = async ref => parseStatusLine((await historicalRange(ref, parentFile, { line: true, limit: 16 * 1024 })).replace(/\n$/, ""));
  const raised = await event(owner.raised), resolved = await event(owner.resolved);
  const epoch = event => {
    const values = event.fields.filter(field => field.name === "at");
    if (!event.transitionAllowed || event.key !== owner.parentKey || event.fields.filter(field => field.name === "key").length !== 1 || values.length !== 1 || !/^\d+$/.test(values[0].value)) historicalRefused("parent-event");
    return Number(values[0].value) * 1000;
  };
  const heldAt = historicalTime(owner.heldAt), askAt = historicalTime(request.timestamp), answerAt = historicalTime(answer.timestamp), resolvedAt = historicalTime(owner.resolvedAt);
  if (raised.state !== "needs-decision" || !raised.text.startsWith(`captain hold ${owner.task}: `) || resolved.state !== "resolved" || resolved.text !== `captain hold ${owner.task}: ${owner.mode}` ||
      epoch(raised) < heldAt || epoch(raised) > askAt || epoch(resolved) !== resolvedAt || heldAt > askAt || askAt > answerAt || answerAt > resolvedAt || resolvedAt > now ||
      claim.request.ref.offset + claim.request.ref.length > claim.answer.ref.offset || owner.raised.offset >= owner.resolved.offset) historicalRefused("occurrence-clock");
  return { request, source, task: owner.task, mode: owner.mode };
}

// ---------------------------------------------------------------------------------------
// The scanner owns the chat-ask state. scan() is cheap when nothing grew (stat only).
export function createChatAskScanner({ home, claudeConfigDir = null, historyLimits = {}, statePath = null, store = statePath ? createStateFile(statePath) : memoryStateFile(),
  now = Date.now, discover = discoverPrimarySources, discoverEveryMs = 30000, backfillBytes = 4 * MiB, backfillMaxAgeMs = 24 * 3600 * 1000,
  maxScanBytes = 4 * MiB, maxLineBytes = 2 * MiB, historicalAnswer = null } = {}) {
  if (historicalAnswer !== null && typeof historicalAnswer !== "function") throw new TypeError("Historical answer producer must be an explicitly configured function");
  let state = null;
  let view = { state: home ? "loading" : "unavailable", error: home ? null : "FM_HOME is not configured", checkedAt: null, sources: [], warnings: [] };
  let sources = null, discoveredAt = -Infinity, scanning = null;
  const sourceStatus = new Map();
  // Ephemeral and current-primary only. On restart, reuse the existing bounded
  // payload pass to backfill once rather than persist recap text or reread history.
  let recapFile = null, recapStamp = null;
  let primaryRecap = { text: null, state: "unavailable" };
  let recapCandidate = primaryRecap;

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
        let precedingEnd = 0;
        for (const { ask: found, start, end } of extractAskSections(turn.text)) {
          // Display-only evidence: never another text part or an earlier marker's ask.
          // Sanitize before clipping so a cut cannot expose a partial absolute path.
          const preceding = publicText(turn.text.slice(precedingEnd, start), Infinity);
          precedingEnd = end;
          const sourceContext = { text: preceding?.slice(-4000) || null, limited: Boolean(preceding && preceding.length > 4000) };
          const key = `chat:${shortHash([recordId, turn.part, found.line])}`;
          if (target.tombstones[key] || (target.asks[key] && target.asks[key].status !== "open")) continue;
          const existing = target.asks[key];
          const ask = existing || { key, kind: found.kind, marker: found.marker, text: found.text, taskMarkers: found.taskMarkers, replies: found.replies, source, offset, part: turn.part, recordId, at, status: "open", linkedTasks: [], sourceContext };
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
    const found = await discover(home, { claudeConfigDir, reader: createHistoryReader(historyLimits) });
    sources = found.sources;
    discoveredAt = now();
    view = { ...view, warnings: found.warnings };
    return sources;
  }

  async function admitHistorical(active) {
    if (!historicalAnswer) return false;
    let deadline;
    try {
      const validated = await Promise.race([
        (async () => {
          // Freeze selection before any await; re-check the actual target inside the
          // same existing state-file transaction before resolution. Never expose this
          // callback as an HTTP/environment/audit-file intake.
          const claim = structuredClone(await historicalAnswer());
          if (claim === null || state.tombstones[claim?.request?.key]) return null;
          const proof = await validateHistoricalAnswer(claim, { home, sources: active, ask: state.asks[claim?.request?.key], now: now(), maxLineBytes });
          return { claim, proof };
        })(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("producer-timeout")), 1500); }),
      ]);
      if (!validated) return false;
      const { claim, proof } = validated;
      const result = await mutate(target => {
        historicalTarget(target.asks[claim.request.key], proof.request, claim, proof.source);
        const dirty = resolveAsk(target, target.asks[claim.request.key], "answered", { resolutionSource: "verified historical answer", resolvedTasks: [proof.task], holdResolutions: [{ task: proof.task, resolution: proof.mode }] });
        prune(target);
        return { dirty, write: dirty };
      });
      return result.dirty;
    } catch (error) {
      const safeCodes = new Set(["association", "file-reference", "file-identity", "record-boundary", "item-boundary", "record-digest", "owner-item", "current-target", "request-event", "request-identity", "monitored-source", "part", "answer-event", "answer-digest", "owner", "owner-occurrence", "owner-resolution", "parent-event", "occurrence-clock", "clock", "producer-timeout"]);
      const code = safeCodes.has(error.message) ? error.message : "unavailable";
      view.warnings = [...view.warnings, `Historical answer not admitted: ${code}`].filter((value, index, values) => values.indexOf(value) === index);
      return false;
    } finally { clearTimeout(deadline); }
  }

  async function scanOnce() {
    if (!home) return false;
    try {
      const active = await sourcesNow();
      const primary = active.find(entry => entry.origin === "claude");
      if (recapFile !== (primary?.file || null)) {
        recapFile = primary?.file || null;
        recapStamp = null;
        recapCandidate = primaryRecap = { text: null, state: "unavailable" };
      }
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
        const recapReset = entry.file === recapFile && info && (!recapStamp || recapStamp.ino !== info.ino || info.size < recapStamp.size || (info.size === recapStamp.size && info.mtimeMs !== recapStamp.mtimeMs));
        if (entry.file === recapFile && !info) { recapStamp = null; recapCandidate = primaryRecap = { text: null, state: "unavailable" }; }
        if (info && (recapReset || !cursor || cursor.ino !== info.ino || cursor.offset !== info.size)) grown.push({ ...entry, recapReset, info });
        else if (info) sourceStatus.set(entry.source, { source: entry.source, behind: false, backfillOmittedBytes: sourceStatus.get(entry.source)?.backfillOmittedBytes ?? 0 });
      }
      let changed = false;
      if (grown.length) {
        const { state: next, result } = await store.update(async (target) => {
          let asksChanged = false, cursorMoved = false;
          for (const entry of grown) {
            const isPrimary = entry.file === recapFile;
            // Recap hydration rereads the bounded tail without rewinding ask
            // intake: records past a still-valid cursor stay incremental, and a
            // cursor before the tail window resumes in place.
            const saved = target.cursors[entry.source];
            const incremental = saved && saved.ino === entry.info.ino && saved.offset <= entry.info.size;
            const prior = (entry.recapReset && (!incremental || saved.offset > Math.max(0, entry.info.size - backfillBytes)) ? null : saved) || { ino: null, offset: 0, skip: false };
            if (isPrimary && entry.recapReset) recapCandidate = { text: null, state: prior.offset > 0 ? "limited" : "ready" };
            const backfill = prior.ino === null;
            const toolNames = new Map();
            const outcome = await readNewLines(entry.file, prior, { maxBytes: maxScanBytes, maxLineBytes, backfillBytes,
              onSkip: () => { if (isPrimary) recapCandidate = { text: null, state: "limited" }; },
              onLine: async (line, offset) => {
              // The same payload pass projects primary system recaps separately
              // from asks; neither system text nor session input resolves an ask.
              if (!isPrimary && !line.includes("NEEDED")) return;
              const textLine = line.toString("utf8");
              if (!textLine.trim()) return;
              let record;
              try { record = JSON.parse(textLine); } catch {
                if (isPrimary) recapCandidate = { text: null, state: "limited" };
                return;
              }
              if (isPrimary) {
                const text = claudeAwaySummary(record);
                if (text !== undefined) recapCandidate = { text: text || null, state: "ready" };
              }
              if (line.includes("NEEDED") && applyRecord(target, record, { source: entry.source, origin: entry.origin, offset, backfill: backfill && (!incremental || offset < saved.offset) }, toolNames)) asksChanged = true;
            } });
            if (isPrimary) {
              recapStamp = { ino: entry.info.ino, size: entry.info.size, mtimeMs: entry.info.mtimeMs };
              if (outcome.backfillOmittedBytes && recapCandidate.text === null) recapCandidate.state = "limited";
              primaryRecap = outcome.behind || outcome.limited ? { text: null, state: "limited" } : { ...recapCandidate };
            }
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
      return await admitHistorical(active) || changed;
    } catch (error) {
      recapStamp = null;
      recapCandidate = primaryRecap = { text: null, state: "unavailable" };
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
    view: () => ({ ...view, primaryRecap: { ...primaryRecap }, resolved: Object.values(state?.asks || {}).filter(ask => ask.status === "resolved" && ask.resolutionSource)
      .sort((a, b) => String(b.resolvedAt).localeCompare(String(a.resolvedAt))).slice(0, 50)
      .map(ask => ({ key: ask.key, status: "answered", resolvedAt: ask.resolvedAt, tasks: ask.resolvedTasks, source: ask.resolutionSource, resolutions: ask.holdResolutions || [] })) }),
    asks: () => openAsks(),
    // Link by task id or a filed decision's quoted reply. String task ids remain supported
    // for callers with no card text. Ledger evidence also covers holds omitted by bearings.
    async applySnapshot(cards, fresh, holds = []) {
      if (!state) return false;
      const evidence = fresh ? holds : [];
      cards = cards.map(card => typeof card === "string" ? { task: card } : card);
      const candidates = [...cards, ...evidence];
      const closed = new Map(evidence.filter(row => row.closed).map(row => [row.task, row]));
      return (await mutate((target) => {
        let dirty = false;
        for (const ask of Object.values(target.asks)) {
          if (ask.status !== "open") continue;
          const before = JSON.stringify([ask.linkedTasks, ask.taskLinks]);
          const links = new Map((ask.taskLinks || []).map(link => [link.task, link]));
          for (const card of candidates) {
            if (!card.task) continue;
            const localTask = card.localTask || card.task.split("/").at(-1);
            const owner = card.readOnly ? card.owner : "(main)";
            if (!owner || (card.readOnly && !(ask.linkedTasks.includes(localTask) && !links.has(localTask)) && !(card.task.includes("/") && ask.linkedTasks.includes(card.task)) && !links.has(`${owner}/${localTask}`))) continue;
            const task = card.readOnly ? `${owner}/${localTask}` : card.task;
            // A legacy bare string is not proof of local ownership. Re-establish
            // association from the ask and an owner-attributed card/ledger row.
            const matches = matchesHold({ ...ask, taskLinks: [...links.values()] }, { ...card, owner, readOnly: false });
            if (!matches || (!card.readOnly && card.closed && ask.linkedTasks.includes(card.task) && !links.has(card.task))) continue;
            links.set(task, { task, localTask, owner });
          }
          const remoteTasks = new Set(candidates.filter(card => card.readOnly).map(card => card.task));
          const localTasks = new Set(candidates.filter(card => !card.readOnly).map(card => card.task));
          ask.linkedTasks = ask.linkedTasks.filter(task => !(remoteTasks.has(task) && !localTasks.has(task))
            && ![...links.values()].some(link => link.owner !== "(main)" && (link.task === task || link.localTask === task) && !links.has(link.localTask)));
          for (const link of links.values()) if (link.owner === "(main)" && !ask.linkedTasks.includes(link.task)) ask.linkedTasks.push(link.task);
          if (links.size || ask.taskLinks) ask.taskLinks = [...links.values()];
          dirty ||= before !== JSON.stringify([ask.linkedTasks, ask.taskLinks]);
          const provenLocal = ask.linkedTasks.length && ask.linkedTasks.every(task => links.get(task)?.owner === "(main)");
          const rows = ask.linkedTasks.map(task => closed.get(task));
          if (provenLocal && rows.every(Boolean) && ![...links.values()].some(link => link.owner !== "(main)")) {
            dirty = resolveAsk(target, ask, "answered", { resolvedTasks: ask.linkedTasks, resolutionSource: "data/backlog.md",
              holdResolutions: rows.map(row => ({ task: row.task, resolution: row.resolution })) }) || dirty;
          }
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
    options = publishOptions(enumeratedLetterOptions(ask.text), publicText);
  }
  const card = { key: ask.key, type: "chat", kind: ask.kind, marker: ask.marker, summary: publicText(ask.text, Infinity) || `${ask.marker} (no text)`, replies: options.map((option) => option.label),
    source: ask.source.split("/")[0], transcript: { offset: ask.offset, part: ask.part }, clock: { label: "Asked", at: ask.at },
    answer: { question: chatQuestion(ask.key), options, recommend: null, close: null, freeform: true } };
  // Context is not answer/review identity. Existing summaries, options and revs stay exact.
  return { ...card, rev: shortHash(card), sourceContext: contextEvidence(ask) };
}
function contextEvidence(ask) {
  return { text: ask.sourceContext?.text || null, limited: Boolean(ask.sourceContext?.limited),
    captured: Boolean(ask.sourceContext), source: ask.source.split("/")[0], offset: ask.offset, part: ask.part };
}
const linkedEntry = (ask) => {
  const replies = ask.replies.map((reply) => publicText(reply, 200)).filter(Boolean);
  const replyHints = {};
  for (const reply of replies) {
    const hint = describedHint(ask.text, reply);
    if (hint) replyHints[reply] = hint;
  }
  return { key: ask.key, kind: ask.kind, summary: publicText(ask.text, Infinity) || ask.marker, replies, ...(Object.keys(replyHints).length ? { replyHints } : {}), clock: { label: "Asked", at: ask.at }, sourceContext: contextEvidence(ask) };
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
  const linkable = base.cards.filter(card => !card.readOnly);
  const linked = new Map();
  const unlinked = [];
  for (const ask of asks) {
    // The snapshot can finish between a scan and a cache read (including cold GETs
    // without a stream subscription). Dedup at composition too, before any publication.
    const task = linkable.find(card => matchesHold(ask, card))?.task;
    if (task) linked.set(task, [...(linked.get(task) || []), ask]);
    else unlinked.push(ask);
  }
  unlinked.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const cards = base.cards.map((card) => {
    const entries = linked.get(card.task);
    if (card.readOnly) return card;
    let rest = card;
    let modified = false;
    if (entries) {
      const { rev, ...withoutRev } = card;
      rest = withLinkedChoices(withoutRev, entries);
      modified = true;
    }
    // Missing choices stay text-only. The view already offers explicit linked replies;
    // a decision/approval marker alone cannot establish a boolean question.
    if (modified) {
      const identity = { ...rest, chatAsks: rest.chatAsks.map(({ sourceContext, ...entry }) => entry) };
      return { ...rest, rev: shortHash(identity) };
    }
    return card;
  });
  const chatCards = unlinked.slice(0, MAX_OPEN).map(chatCard);
  const chat = { state: chatView.state, error: chatView.error, open: unlinked.length, linked: asks.length - unlinked.length, omitted: Math.max(0, unlinked.length - MAX_OPEN), behind: Boolean(chatView.behind),
    sources: chatView.sources.map(({ source, backfillOmittedBytes }) => ({ source: source.split("/")[0], backfillOmittedBytes })), resolved: chatView.resolved || [] };
  const primaryRecap = chatView.primaryRecap || { text: null, state: "unavailable" };
  const content = { ...base, cards: [...cards, ...chatCards], chat };
  return { ...base, cards: content.cards, chat, primaryRecap, chatCheckedAt: chatView.checkedAt, rev: shortHash([contentRevision(content), chat, primaryRecap]) };
}

// Wrap the snapshot hub so every consumer (GET, ?since, the stream, answers) sees one
// composed model. Chat scanning runs on each read and every scanEveryMs while streamed.
export function createCallSource({ hub, chat, home = null, receipts = inboxReceipts, timers = globalThis, scanEveryMs = 3000 } = {}) {
  let answerReceipts = null, receiptsSignature = "", receiptsCheckedAt = 0;
  let receiptEvidence = { available: false, checkedAt: null };
  let composed = null, composedFrom = null;
  const listeners = new Set();
  let timer = null;
  // The hub adds its age fields; a minimal hub without freshness keeps the model fields.
  const freshness = () => { const model = current(); return { state: model.state, observedAt: model.observedAt, checkedAt: model.checkedAt, stale: model.stale, error: model.error, ...hub.freshness?.(), rev: model.rev, primaryRecap: model.primaryRecap }; };
  // Recompose only when the hub published a new model object or the chat asks changed.
  let composedBase = null;
  function current() {
    const base = hub.current();
    const asks = chat.asks();
    const view = chat.view();
    const signature = JSON.stringify([asks.map((ask) => [ask.key, ask.linkedTasks]), view.state, view.error, view.behind, view.sources, view.checkedAt, view.primaryRecap, receiptsSignature]);
    if (base !== composedBase || signature !== composedFrom) { composed = composeCallModel(base, asks, view); composed.cards = classifyAnsweredCalls(composed.cards, answerReceipts); composed.rev = shortHash([contentRevision(composed), composed.chat, composed.primaryRecap]); composedBase = base; composedFrom = signature; }
    return composed;
  }
  const applyHolds = () => { const base = hub.current(); return chat.applySnapshot(base.cards, fresh(), base.holds || []); };
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
      try {
        answerReceipts = await receipts(home); receiptsSignature = JSON.stringify(answerReceipts);
        receiptEvidence = { available: true, checkedAt: new Date().toISOString() };
      } catch { receiptEvidence = { available: false, checkedAt: new Date().toISOString() }; /* Preserve UI evidence, fail closed for notification eligibility. */ }
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
    expandLandings: () => hub.expandLandings?.(),
    freshness,
    refresh,
    // Independent of the UI's 15-second receipt cache. This uses the same expanded
    // per-item adapter and classifier, never a parser of combined batch prose.
    async notificationEvidence() {
      try {
        const data = await receipts(home);
        if (!Array.isArray(data?.pending) || !Array.isArray(data?.handled) || !Array.isArray(data?.replies) || data.omitted?.length) throw new Error("Incomplete receipts");
        answerReceipts = data; receiptsSignature = JSON.stringify(data);
        receiptEvidence = { available: true, checkedAt: new Date().toISOString() };
        return { ...receiptEvidence, model: current(), receipts: data };
      } catch {
        receiptEvidence = { available: false, checkedAt: new Date().toISOString() };
        return { ...receiptEvidence, model: current(), receipts: null };
      }
    },
    receiptEvidence: () => ({ ...receiptEvidence }),
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
