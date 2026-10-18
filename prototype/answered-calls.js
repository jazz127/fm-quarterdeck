import { noteForCard, taggedEnvelope, threadText } from "./bearings-thread.js";
import { currentCardNote, receiptReply, replyBody, noteIdentity, compareNoteIdentity } from "./receipt-provenance.js";

// A receipt or reply is not closure: the caller supplies only cards still open in bearings.
// Match the card's intake key, not its presentation revision: a summary update is not
// Firstmate confirmation.
// sentReceipt is the latest matching captain note: pending, acknowledged, or replied.
function notePosture(note, where, receipts) {
  const { reply, scope } = receiptReply(receipts, note);
  if (reply) return { posture: "replied", reply: scope === "individual" ? replyBody(reply) : "", scope };
  if (where === "handled") return { posture: "acknowledged", reply: "" };
  return { posture: "pending", reply: "" };
}

function latestReceipt(matches) {
  if (!matches.length) return null;
  const rank = { pending: 0, acknowledged: 1, replied: 2 };
  return matches.sort((a, b) => compareNoteIdentity(a.identity, b.identity) || rank[b.posture] - rank[a.posture]).at(-1);
}

export function classifyAnsweredCalls(cards, receipts) {
  const pending = receipts?.pending || [];
  const handled = receipts?.handled || [];
  const notes = [...pending, ...handled];
  const seen = new Set();
  const unique = [];
  for (const item of [...handled.map((note) => ({ note, where: "handled" })), ...pending.map((note) => ({ note, where: "pending" }))]) {
    const id = item.note?.id;
    if (typeof id === "string" && id) {
      // Expanded batch items share the inbox note id, but retain their own
      // request identity. Only duplicate receipts for the same item collapse.
      const identity = JSON.stringify([id, item.note.request_id || ""]);
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    unique.push(item);
  }
  return cards.map((card) => {
    const current = (note) => currentCardNote(card, taggedEnvelope(note?.body, "fm-bearings-answer") || taggedEnvelope(note?.body, "fm-quarterdeck-thread") || {}, note?.at);
    const answered = notes.some((note) => {
      if (!current(note)) return false;
      if (!note?.request_id?.startsWith("quarterdeck-call:")) return false;
      const answer = taggedEnvelope(note.body, "fm-bearings-answer");
      return answer?.schema === "fm-bearings-answer.v1" && answer.channel === "quarterdeck"
        && answer.type === card.type
        && answer.question === card.answer?.question;
    });
    const matches = card?.key ? unique.flatMap((item) => current(item.note) && noteForCard(item.note, card.key, card) ? [{ ...notePosture(item.note, item.where, receipts), identity: noteIdentity(item.note) }] : []) : [];
    const latest = latestReceipt(matches);
    if (!latest) return answered ? { ...card, answered: true } : card;
    const next = answered ? { ...card, answered: true } : { ...card };
    next.sentReceipt = latest.posture;
    next.sentReceiptIdentity = latest.identity;
    if (latest.posture === "replied") {
      next.sentReplyScope = latest.scope;
      if (latest.scope === "individual") next.sentReply = threadText(latest.reply);
    }
    return next;
  });
}
