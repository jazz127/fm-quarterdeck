import { stat } from "node:fs/promises";
import { shortHash } from "./bearings.js";
import { displayAnswer } from "./bearings-answer.js";
import { discoverPrimarySources, mentionsTask, recordTurns } from "./chat-asks.js";
import { createHistoryReader } from "./history-reader.js";
import { inboxReceipts, noteWithRequestId } from "./inbox.js";

// Card threads (BEARINGS.md "Card threads"). Text in a Captain's Call card's one box, with
// no option selected, sends the captain's note to Firstmate through the same guarded,
// idempotent inbox note the answers and review notes use, under a request id that names
// the card key. Firstmate answers with `fm-inbox.sh reply <note id>`, or in the main chat.
// The thread view is a
// read-only, mechanical join of the card's inbox notes, their replies, and Firstmate's own
// primary-transcript messages that mention the card's task id. No model, no writes under
// FM_HOME beyond the inbox note itself.
export const THREAD_SCHEMA = "fm-quarterdeck-card-thread.v1";
export const THREAD_NOTE_TAG = "fm-quarterdeck-thread";
export const MAX_THREAD_BODY_BYTES = 4096;
export const MAX_QUESTION_BYTES = 2000;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CARD_KEY = /^(?:decision|merge|chat|landed):[A-Za-z0-9._-]{1,160}$/;
// fm-inbox.sh request ids: [A-Za-z0-9._:-], at most 128 characters.
const INBOX_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PREFIX = "quarterdeck-thread:";
const MAX_REMEMBERED = 200;
const MAX_ENTRIES = 80;
const MAX_ENTRY_CHARS = 16000;
const TRANSCRIPT_WINDOW_BYTES = 4 * 1024 * 1024;

export class ThreadRefused extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new ThreadRefused(status, code, message); };
const bytes = (text) => Buffer.byteLength(text, "utf8");

export const validCardKey = (key) => typeof key === "string" && CARD_KEY.test(key);
// The card key is embedded verbatim when it fits the inbox id grammar; a longer key is
// replaced by its hash, and the note's tagged fence still names the exact key.
export const threadKeyPart = (key) => INBOX_ID.test(`${PREFIX}${key}:${"0".repeat(36)}`) ? key : `h-${shortHash(key)}`;
export const threadRequestId = (key, requestId) => `${PREFIX}${threadKeyPart(key)}:${requestId}`;
const threadPrefix = (key) => `${PREFIX}${threadKeyPart(key)}:`;

// The task a card is about: the card's own task, or the one its key names.
export function cardTask(card, key) {
  if (card?.task) return card.task;
  const match = /^(?:decision|merge|landed):(.+)$/.exec(key);
  return match ? match[1] : null;
}
const cardByKey = (model, key) => (model?.cards || []).find((entry) => entry.key === key) || (model?.landed || []).find((entry) => entry.key === key);
const cardLabel = (card, key) => {
  if (card?.type === "chat" || key.startsWith("chat:")) return `Chat ask ${key.slice(5)}`;
  const kind = card?.type === "landed" || key.startsWith("landed:") ? "Landed" : key.startsWith("merge:") ? "Merge" : "Decision";
  return `${kind} ${cardTask(card, key)}`;
};

// Free text keeps its line breaks but never serves an absolute path or control characters.
export function threadText(value, max = MAX_ENTRY_CHARS) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/(^|[\s("'`=,])(?:~\/|\/)(?:[^\s/"'`)]+\/)+([^\s/"'`)]*)/g, (_, lead, last) => `${lead}…/${last}`)
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function parseBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "key,requestId,text") refuse(400, "invalid", "Ask must be exactly requestId, key and text");
  if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId)) refuse(400, "invalid", "Ask request id must be a lowercase UUID");
  if (!validCardKey(body.key)) refuse(400, "invalid", "Ask must name an open card");
  if (typeof body.text !== "string") refuse(400, "invalid", "Ask text must be text");
  const text = body.text.replace(/\r\n?/g, "\n").trim();
  if (!text) refuse(422, "empty", "Write a question first");
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) refuse(422, "invalid-text", "The question contains control characters");
  if (bytes(text) > MAX_QUESTION_BYTES) refuse(422, "too-long", `The question is longer than ${MAX_QUESTION_BYTES} bytes`);
  return { requestId: body.requestId, key: body.key, text };
}

// One human line, the reply route, then the tagged fence. Backticks inside JSON strings are
// escaped so the captain's text can never close the fence.
export function formatThreadNote({ key, card, text, requestId }) {
  const task = cardTask(card, key);
  const envelope = { schema: THREAD_SCHEMA, key, type: card?.type || key.split(":")[0], ...(task ? { task } : {}),
    ...(card?.type === "chat" ? { ask: threadText(`${card.marker}: ${card.summary}`, 1024) } : {}), question: text, requestId };
  return [
    `Captain asks about ${cardLabel(card, key)} from Quarterdeck: ${text.replace(/\s+/g, " ")}`,
    "Answer with `bin/fm-inbox.sh reply <this note id>` (it appears in this card's thread) or in the main chat naming the task id. This is a question, not an answer; nothing was decided.",
    "",
    `\`\`\`json ${THREAD_NOTE_TAG}`,
    JSON.stringify(envelope, null, 2).replaceAll("`", "\\u0060"),
    "```",
  ].join("\n");
}

// The JSON of a tagged fence at the end of a note body, or null.
export function taggedEnvelope(body, tag) {
  if (typeof body !== "string" || body.length > 64 * 1024) return null;
  const match = body.match(new RegExp(`\\n\`\`\`json ${tag}\\n([^]*?)\\n\`\`\`\\s*$`));
  if (!match) return null;
  try { const value = JSON.parse(match[1]); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

// Does an inbox note belong to this card? Thread asks by request id or tagged key;
// Captain's Call answers by their fm-bearings-answer envelope's question/task.
export function noteForCard(note, key, card) {
  const id = typeof note?.request_id === "string" ? note.request_id : "";
  if (id.startsWith(PREFIX)) {
    const envelope = taggedEnvelope(note.body, THREAD_NOTE_TAG);
    if (envelope ? envelope.key === key : id.startsWith(threadPrefix(key))) return { kind: "ask", text: typeof envelope?.question === "string" ? envelope.question : note.body };
    return null;
  }
  if (id.startsWith("quarterdeck-call:")) {
    const envelope = taggedEnvelope(note.body, "fm-bearings-answer");
    if (!envelope || envelope.channel !== "quarterdeck") return null;
    const task = cardTask(card, key);
    const mine = key.startsWith("chat:") ? envelope.type === "chat" && envelope.question === `chat.${key.slice(5)}`
      : envelope.type === key.split(":")[0] && Boolean(task) && envelope.task === task;
    if (!mine) return null;
    return { kind: "answer", text: displayAnswer(String(envelope.selection || ""), String(envelope.note || "")) };
  }
  // Any other note that carries a thread fence for this exact card (for example one
  // Firstmate filed by hand with the tag).
  const envelope = taggedEnvelope(note?.body, THREAD_NOTE_TAG);
  return envelope?.key === key && typeof envelope.question === "string" ? { kind: "ask", text: envelope.question } : null;
}

// Firstmate's own text in the newest window of each primary source. Cached per source by
// inode, size and mtime, so an unchanged transcript is never re-parsed.
export function createTranscriptTurns({ home, claudeConfigDir = null, discover = discoverPrimarySources, windowBytes = TRANSCRIPT_WINDOW_BYTES, discoverEveryMs = 30000, now = Date.now } = {}) {
  const cache = new Map();
  let sources = null, discoveredAt = -Infinity;
  return async function firstmateTurns() {
    if (!home) return { turns: [], omitted: false };
    if (!sources || now() - discoveredAt >= discoverEveryMs) { sources = (await discover(home, { claudeConfigDir })).sources; discoveredAt = now(); }
    const turns = [];
    let omitted = false;
    for (const entry of sources) {
      let info;
      try { info = await stat(entry.file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
      let cached = cache.get(entry.file);
      if (cached?.stamp !== stamp) {
        const reader = createHistoryReader({ maxFileBytes: windowBytes, maxTotalBytes: windowBytes * 2, windowReserveBytes: 0, maxRecords: 200000, maxLineBytes: 2 * 1024 * 1024 });
        const window = await reader.recent(entry.file, windowBytes);
        const found = [];
        const toolNames = new Map();
        if (window) for await (const { line, offset } of window.lines) {
          // Cheap filter before parsing: only records that can carry Firstmate's text.
          if (!line.includes('"assistant"')) continue;
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          const at = new Date(record.timestamp ?? record.message?.timestamp);
          for (const turn of recordTurns(record, entry.origin, toolNames)) {
            if (turn.role === "firstmate") found.push({ at: Number.isNaN(at.valueOf()) ? null : at.toISOString(), text: turn.text, source: entry.source, offset, part: turn.part });
          }
        }
        cached = { stamp, turns: found, omitted: Boolean(window?.omittedBytes) || !window };
        cache.set(entry.file, cached);
      }
      turns.push(...cached.turns);
      omitted ||= cached.omitted;
    }
    return { turns, omitted };
  };
}

export function createThreadRelay({ home, note = noteWithRequestId, receipts = inboxReceipts, transcript = createTranscriptTurns({ home }), now = Date.now } = {}) {
  const sent = new Map();
  const remember = (requestId, record) => {
    sent.set(requestId, record);
    while (sent.size > MAX_REMEMBERED) sent.delete(sent.keys().next().value);
  };
  return {
    // A question may be asked about any open card, answerable or not. A retry of the same
    // request id resends the identical note (idempotent in Firstmate) even after the card left.
    async submit(body, model, { immediate = false } = {}) {
      if (!home) refuse(503, "unconfigured", "Firstmate home is not configured");
      const parsed = parseBody(body);
      const digest = shortHash([parsed.key, parsed.text]);
      const previous = sent.get(parsed.requestId) || await note.lookup?.(threadRequestId(parsed.key, parsed.requestId));
      if (previous && previous.digest !== digest) refuse(409, "request-reused", "This request id was already used for a different question");
      const record = previous || (() => {
        const card = cardByKey(model, parsed.key);
        if (!card) refuse(409, "gone", "This call is no longer open; ask in chat");
        return { digest, key: parsed.key, display: parsed.text, text: formatThreadNote({ key: parsed.key, card, text: parsed.text, requestId: parsed.requestId }), at: new Date(now()).toISOString() };
      })();
      remember(parsed.requestId, record);
      let receipt;
      try { receipt = await note(home, threadRequestId(parsed.key, parsed.requestId), record.text, { record, immediate }); } catch { refuse(502, "unconfirmed", "Firstmate did not confirm the question; retry sends the same question once"); }
      return { state: "accepted", requestId: parsed.requestId, key: record.key, noteId: receipt.id, replay: receipt.outcome === "replay", sentAt: record.at };
    },
    // The card's own history, oldest first. Inbox receipts are required; the transcript is
    // best effort and its absence is reported, never hidden.
    async history(key, model) {
      if (!home) refuse(503, "unconfigured", "Firstmate home is not configured");
      if (!validCardKey(key)) refuse(400, "invalid", "Thread must name an open card");
      const card = cardByKey(model, key) || null;
      const entries = [];
      const data = await receipts(home);
      const notes = new Map();
      for (const item of [...data.pending, ...data.handled]) if (item?.id && !notes.has(item.request_id || item.id)) notes.set(item.request_id || item.id, item);
      for (const item of notes.values()) {
        const match = noteForCard(item, key, card);
        if (!match) continue;
        const reply = data.replies?.find((entry) => entry.id === item.id || entry.note_id === item.id || entry.in_reply_to === item.id) || item.reply;
        const replyText = typeof reply?.body === "string" ? reply.body : typeof reply?.text === "string" ? reply.text : null;
        entries.push({ kind: match.kind, from: "captain", at: item.at || null, text: threadText(match.text), noteId: item.id, state: reply ? "replied" : data.handled.some((entry) => entry.id === item.id) ? "received" : "waiting" });
        if (replyText !== null) entries.push({ kind: "reply", from: "firstmate", at: reply.at || null, text: threadText(replyText), noteId: item.id });
      }
      if (card?.type === "chat") entries.push({ kind: "chat-ask", from: "firstmate", at: card.clock?.at || null, text: threadText(`${card.marker}: ${card.summary}`) });
      for (const ask of card?.chatAsks || []) entries.push({ kind: "chat-ask", from: "firstmate", at: ask.clock?.at || null, text: threadText(`${ask.kind ? `${ask.kind.toUpperCase()} NEEDED: ` : ""}${ask.summary}`) });
      const task = cardTask(card, key);
      let transcriptState = "ready", omitted = false;
      if (task) {
        try {
          const found = await transcript();
          omitted = found.omitted;
          for (const turn of found.turns) if (mentionsTask(turn.text, task)) entries.push({ kind: "chat", from: "firstmate", at: turn.at, text: threadText(turn.text) });
        } catch { transcriptState = "unavailable"; }
      } else transcriptState = "not-applicable";
      // Oldest first; unknown times keep their discovery order at the end.
      const ordered = entries.map((entry, index) => ({ entry, index }))
        .sort((a, b) => (a.entry.at ? 0 : 1) - (b.entry.at ? 0 : 1) || String(a.entry.at).localeCompare(String(b.entry.at)) || a.index - b.index)
        .map(({ entry }) => entry);
      const dropped = Math.max(0, ordered.length - MAX_ENTRIES);
      return { schema: THREAD_SCHEMA, key, task, entries: ordered.slice(dropped), omitted: dropped, transcript: { state: transcriptState, windowed: omitted }, checkedAt: new Date(now()).toISOString() };
    },
  };
}
