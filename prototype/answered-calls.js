import { noteForCard, taggedEnvelope, threadText } from "./bearings-thread.js";
import { currentCardNote, receiptReply, replyBody, noteIdentity } from "./receipt-provenance.js";

// A receipt or reply is not closure: the caller supplies only cards still open in bearings.
// Match the card's intake key, not its presentation revision: a summary update is not
// Firstmate confirmation.
// sentReceipt is the latest matching captain note: pending, acknowledged, or replied.
function notePosture(note, where, receipts) {
  const { reply, scope } = receiptReply(receipts, note);
  if (reply) return { posture: "replied", reply: scope === "individual" ? replyBody(reply) : "", scope, at: note?.at || reply?.at || "", where };
  if (where === "handled") return { posture: "acknowledged", reply: "", at: note?.at || "", where };
  return { posture: "pending", reply: "", at: note?.at || "", where };
}

// Dated notes stay in time order. An undated pending note is the newest unread one.
function latestReceipt(matches) {
  if (!matches.length) return null;
  const dated = matches.filter((item) => item.at).sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.identity?.sequence ?? 0) - (b.identity?.sequence ?? 0) || (a.identity?.itemIndex ?? 0) - (b.identity?.itemIndex ?? 0));
  const undated = matches.filter((item) => !item.at);
  const pending = undated.filter((item) => item.where === "pending" && item.posture === "pending");
  const rest = undated.filter((item) => !pending.includes(item));
  return [...dated, ...rest, ...pending].at(-1);
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
