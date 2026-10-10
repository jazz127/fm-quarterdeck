import { parseReviewNote } from "./review-note.js";

// Authorship is a trust boundary (TRANSCRIPTS.md "Authorship"). The Captain identity is
// granted only to an authoritative explicit-send record: a note Quarterdeck itself sent
// through Firstmate's guarded `fm-inbox.sh note --request-id` path. An LLM role
// (`role=user`), a `[captain]` mirror label, a content prefix, a lane marker, a filename
// or mere presence in an inbox proves nothing about who wrote the text. Such input keeps
// its text, clock and record identity, but is shown as unverified input, never as the
// Captain's and never relabelled Firstmate. Lane routing does not depend on authorship.

// One message kind for every unverified input. It is outside the default feed.
export const UNVERIFIED_INPUT = Object.freeze({ role: "input", state: "input", kind: "input" });

const SESSION_INPUT_AUTHOR = { "main Claude": "Claude session input" };
// Pi and Claude transcript `role=user` entries, including `[captain]` mirror records.
export function sessionInput(origin) {
  return { ...UNVERIFIED_INPUT, author: SESSION_INPUT_AUTHOR[origin] || "Pi session input" };
}
export const inboxInput = () => ({ ...UNVERIFIED_INPUT, author: "Inbox note" });
export const VERIFIED_CAPTAIN = Object.freeze({ author: "Captain", role: "captain", state: "captain", kind: "conversation" });

// Quarterdeck's own send namespaces (inbox.js, bearings-answer.js, bearings-thread.js).
// Each request id must agree with the Quarterdeck envelope Quarterdeck wrote in the body.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BATCH_ID = new RegExp(`^quarterdeck-batch:(${UUID})$`);
const REVIEW_ID = new RegExp(`^agentos-review:(${UUID})$`, "i");
const ANSWER_ID = new RegExp(`^quarterdeck-call:(${UUID})$`);
const THREAD_ID = new RegExp(`^quarterdeck-thread:[A-Za-z0-9._:-]+:(${UUID})$`);
export const ANSWER_ENVELOPE = { tag: "fm-bearings-answer", schema: "fm-bearings-answer.v1" };
export const THREAD_ENVELOPE = { tag: "fm-quarterdeck-thread", schema: "fm-quarterdeck-card-thread.v1" };

function fencedEnvelope(body, tag) {
  const match = body.match(new RegExp(`\\n\`\`\`json ${tag}\\n([^]*?)\\n\`\`\`\\s*$`));
  if (!match) return null;
  try { const value = JSON.parse(match[1]); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
}

export function quarterdeckSendMatches(requestId, body) {
  if (typeof requestId !== "string" || requestId.length > 128 || typeof body !== "string" || body.length > 4_000_000) return false;
  if (BATCH_ID.test(requestId)) {
    const envelope = fencedEnvelope(body, "fm-quarterdeck-batch");
    return envelope?.schema === "fm-quarterdeck-inbox-batch.v1" && envelope.requestId === requestId &&
      Array.isArray(envelope.items) && envelope.items.length > 0 && envelope.items.length <= 30 &&
      new Set(envelope.items.map((item) => item.requestId)).size === envelope.items.length &&
      envelope.items.every((item) => !BATCH_ID.test(item.requestId) && quarterdeckSendMatches(item.requestId, item.text));
  }
  let match;
  if ((match = requestId.match(REVIEW_ID))) return parseReviewNote(body)?.batch?.toLowerCase() === match[1].toLowerCase();
  if ((match = requestId.match(ANSWER_ID))) {
    const envelope = fencedEnvelope(body, ANSWER_ENVELOPE.tag);
    return envelope?.schema === ANSWER_ENVELOPE.schema && envelope.channel === "quarterdeck";
  }
  if ((match = requestId.match(THREAD_ID))) {
    const envelope = fencedEnvelope(body, THREAD_ENVELOPE.tag);
    return envelope?.schema === THREAD_ENVELOPE.schema && envelope.requestId === match[1];
  }
  return false;
}

// A captain inbox note is the Captain's only when all of these hold:
// - it is a `.note` that Firstmate's inbox (state/inbox or its handled/) holds under its own id;
// - its request id is in a Quarterdeck send namespace and matches the Quarterdeck envelope;
// - Firstmate's idempotent request reservation for that request id names this note id,
//   proving it came through `fm-inbox.sh note --request-id`, the path Quarterdeck sends by.
// `reservation(requestId)` returns the reserved note id, or null.
export async function verifiedQuarterdeckNote({ name, inFirstmateInbox, headers, body, reservation }) {
  if (!inFirstmateInbox || !name.endsWith(".note") || headers.id !== name.slice(0, -".note".length)) return false;
  if (!quarterdeckSendMatches(headers.request_id, body)) return false;
  return await reservation(headers.request_id) === headers.id;
}
