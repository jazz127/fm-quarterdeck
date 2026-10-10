import { shortHash } from "./bearings.js";
import { inboxNoteState, inboxReceipts, noteWithRequestId } from "./inbox.js";

// Captain's Call answers (BEARINGS.md "Answers"). Quarterdeck only relays the captain's
// explicit answer to Firstmate as an fm-bearings-answer.v1 envelope, the same context the
// /bearings lavish board queues, through the guarded idempotent inbox note. Feeding
// keyed-answer intake needs a separately integrated Firstmate receiver. Quarterdeck
// never runs fm-captain-hold.sh or merges; only chat-only asks resolve locally.
export const ANSWER_SCHEMA = "fm-bearings-answer.v1";
// The board's own cap on the displayed answer ("value - note"), in UTF-8 bytes.
export const MAX_ANSWER_BYTES = 512;
export const MAX_BODY_BYTES = 4096;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ["cardRev", "key", "note", "requestId", "selection"];
const MAX_REMEMBERED = 200;
export const answerRequestId = (id) => `quarterdeck-call:${id}`;

export class AnswerRefused extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const refuse = (status, code, message) => { throw new AnswerRefused(status, code, message); };
const bytes = (text) => Buffer.byteLength(text, "utf8");
function clipBytes(text, max) {
  if (bytes(text) <= max) return text;
  let out = "";
  for (const char of text) { if (bytes(out + char) > max - 3) break; out += char; }
  return `${out}…`;
}
// What the board shows and caps: the option value, its note, or the note alone.
export const displayAnswer = (selection, note) => selection ? (note ? `${selection} - ${note}` : selection) : note;

// Shape and size checks that need no model. The note keeps the captain's words; only
// line endings are normalised, and other control characters are refused.
function parseBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse(400, "invalid", "Answer must be a JSON object");
  if (Object.keys(body).sort().join(",") !== FIELDS.join(",")) refuse(400, "invalid", "Answer fields must be requestId, key, cardRev, selection and note");
  const { requestId, key, cardRev, selection } = body;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) refuse(400, "invalid", "Answer request id must be a lowercase UUID");
  if (typeof key !== "string" || key.length > 200 || typeof cardRev !== "string" || !/^[0-9a-f]{16}$/.test(cardRev)) refuse(400, "invalid", "Answer must name a card and the revision shown");
  if (typeof selection !== "string" || typeof body.note !== "string") refuse(400, "invalid", "Selection and note must be text");
  const note = body.note.replace(/\r\n?/g, "\n").trim();
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(note)) refuse(422, "invalid-text", "The note contains control characters");
  // reconcile asks Firstmate to re-check reality; it is never the captain's answer.
  if (selection === "reconcile") refuse(422, "reconcile", "Reconcile is not an answer; ask Firstmate to re-check in chat");
  if (!selection && !note) refuse(422, "empty", "Choose an option or write an answer");
  if (bytes(displayAnswer(selection, note)) > MAX_ANSWER_BYTES) refuse(422, "too-long", `The answer is longer than ${MAX_ANSWER_BYTES} bytes`);
  return { requestId, key, cardRev, selection, note };
}

// The key must still be open in the current model, shown at the same revision, and the
// selection must be one of that card's own options.
export function validateAnswer(body, model) {
  const parsed = parseBody(body);
  // A chat ask is current when the transcript scan is; it never waits on the snapshot.
  const chat = parsed.key.startsWith("chat:");
  if ((chat ? model?.chat?.state : model?.state) !== "ready") refuse(409, "not-current", "Captain's Call is not current; wait for it to refresh");
  const card = (model.cards || []).find((entry) => entry.key === parsed.key);
  if (!card) refuse(409, "gone", "This call is no longer open");
  if (card.rev !== parsed.cardRev) refuse(409, "changed", "This call changed; review it before answering");
  if (!card.answer) refuse(409, "not-answerable", "This call cannot be answered from Quarterdeck; answer in chat");
  if (parsed.selection && !card.answer.options.some((option) => option.value === parsed.selection)) refuse(422, "bad-option", "That option is not offered for this call");
  return { ...parsed, card };
}

// The board's fm-bearings-answer.v1 context ({schema, question, selection, note, close?})
// plus Quarterdeck provenance. Firstmate's lavish adapter ignores unknown fields, so the
// same parse rule maps it to one keyed line: <question> TAB <selection or note> TAB <label>.
export function answerEnvelope({ card, selection, note }, observedRev) {
  // Only an exact, note-free merge is an order. A selected merge with a note
  // must reach the keyed intake as instruction text, not as the bare option.
  if (card.type === "merge" && selection === "merge" && note) {
    note = displayAnswer(selection, note);
    selection = "";
  }
  // A chat ask has no hold behind it: its quoted reply is sent as the captain's own words,
  // exactly as if typed in chat, so the keyed line never carries an internal option value.
  if (card.type === "chat") {
    const reply = card.answer.options.find((option) => option.value === selection)?.label;
    if (reply) { note = displayAnswer(reply, note); selection = ""; }
  }
  const envelope = { schema: ANSWER_SCHEMA, question: card.answer.question, selection, note };
  if (card.answer.close) envelope.close = card.answer.close;
  const title = cardTitle(card);
  const provenance = card.type === "chat" ? { ask: clipBytes(`${card.marker}: ${card.summary}`.replace(/\s+/g, " "), 1024) } : { task: card.task };
  return { ...envelope, channel: "quarterdeck", type: card.type, ...provenance, label: clipBytes(`${title} -> ${displayAnswer(selection, note)}`.replace(/\s+/g, " "), 512), cardRev: card.rev, observedRev: observedRev ?? null };
}
const cardTitle = (card) => card.type === "chat" ? `Chat ask ${card.answer.question}` : `${card.type === "merge" ? "Merge" : "Decision"} ${card.task}`;

// One human line, then the envelope in a tagged fence. Backticks inside JSON strings are
// escaped so captain text can never close the fence.
export function formatAnswerNote(envelope) {
  const shown = displayAnswer(envelope.selection, envelope.note).replace(/\s+/g, " ");
  if (envelope.type === "chat") return [
    `Captain's Call answer from Quarterdeck · reply to your chat ask: ${shown}`,
    `Your ask: ${envelope.ask}`,
    "This answers an ask you made in chat (no captain hold was filed). Act on it as the captain's reply; it is not a keyed-intake answer.",
    "",
    "```json fm-bearings-answer",
    JSON.stringify(envelope, null, 2).replaceAll("`", "\\u0060"),
    "```",
  ].join("\n");
  return [
    `Captain's Call answer from Quarterdeck · ${envelope.type === "merge" ? "Merge" : "Decision"} ${envelope.task}: ${shown}`,
    "Route it like a /bearings board answer (bearings skill, Handling a board wake). Quarterdeck closed nothing.",
    "",
    "```json fm-bearings-answer",
    JSON.stringify(envelope, null, 2).replaceAll("`", "\\u0060"),
    "```",
  ].join("\n");
}

// Remembers what this process relayed, so a retry of the same request id resends the
// identical note (idempotent in Firstmate) even after the card has left the model.
export function createAnswerRelay({ home, note = noteWithRequestId, receipts = inboxReceipts, now = Date.now } = {}) {
  const sent = new Map();
  const remember = (requestId, record) => {
    sent.set(requestId, record);
    while (sent.size > MAX_REMEMBERED) sent.delete(sent.keys().next().value);
  };
  return {
    async submit(body, model) {
      if (!home) refuse(503, "unconfigured", "Firstmate home is not configured");
      const parsed = parseBody(body);
      const digest = shortHash([parsed.key, parsed.cardRev, parsed.selection, parsed.note]);
      const previous = sent.get(parsed.requestId);
      if (previous && previous.digest !== digest) refuse(409, "request-reused", "This request id was already used for a different answer");
      const record = previous || (() => {
        const valid = validateAnswer(body, model);
        const envelope = answerEnvelope(valid, model.rev);
        return { digest, key: valid.key, envelope, text: formatAnswerNote(envelope), at: new Date(now()).toISOString() };
      })();
      // A failed acknowledgement can follow a saved note (for example a missing wake).
      // Freeze the original envelope before attempting delivery, so a same-id retry
      // never substitutes newer model provenance or loses a now-resolved call.
      remember(parsed.requestId, record);
      let receipt;
      try { receipt = await note(home, answerRequestId(parsed.requestId), record.text); } catch { refuse(502, "unconfirmed", "Firstmate did not confirm the answer; retry sends the same answer once"); }
      remember(parsed.requestId, { ...record, noteId: receipt.id });
      return { state: "accepted", requestId: parsed.requestId, key: record.key, noteId: receipt.id, replay: receipt.outcome === "replay", sentAt: record.at, envelope: record.envelope };
    },
    async status(ids) {
      if (!home) refuse(503, "unconfigured", "Firstmate home is not configured");
      const list = [...new Set(ids)].filter((id) => REQUEST_ID.test(id)).slice(0, 20);
      if (!list.length) return { answers: {} };
      const data = await receipts(home);
      return { answers: Object.fromEntries(list.map((id) => [id, inboxNoteState(data, answerRequestId(id)) || { state: "unknown" }])) };
    },
  };
}
