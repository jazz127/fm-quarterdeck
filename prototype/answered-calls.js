import { noteForCard, taggedEnvelope, threadText } from "./bearings-thread.js";

// Only durable Quarterdeck answer notes count as answered. A receipt or reply is not closure:
// the caller supplies only cards still open in bearings. Match the card's intake key,
// not its presentation revision: a summary update is not Firstmate confirmation.
// sentReceipt is the latest matching captain note: pending, acknowledged, or replied.
function sameNote(reply, note) {
  if (!note?.id || typeof note.id !== "string") return false;
  return reply?.id === note.id || reply?.note_id === note.id || reply?.in_reply_to === note.id;
}

function replyBody(reply) {
  if (typeof reply?.body === "string") return reply.body;
  if (typeof reply?.text === "string") return reply.text;
  return "";
}

function notePosture(note, where, replies) {
  const reply = (replies || []).find((entry) => sameNote(entry, note));
  if (reply) return { posture: "replied", reply: replyBody(reply), at: note?.at || reply?.at || "", where };
  if (where === "handled") return { posture: "acknowledged", reply: "", at: note?.at || "", where };
  return { posture: "pending", reply: "", at: note?.at || "", where };
}

// Dated notes stay in time order. An undated pending note is the newest unread one.
function latestReceipt(matches) {
  if (!matches.length) return null;
  const dated = matches.filter((item) => item.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const undated = matches.filter((item) => !item.at);
  const pending = undated.filter((item) => item.where === "pending" && item.posture === "pending");
  const rest = undated.filter((item) => !pending.includes(item));
  return [...dated, ...rest, ...pending].at(-1);
}

export function classifyAnsweredCalls(cards, receipts) {
  const pending = receipts?.pending || [];
  const handled = receipts?.handled || [];
  const replies = receipts?.replies || [];
  const notes = [...pending, ...handled];
  const seen = new Set();
  const unique = [];
  for (const item of [...handled.map((note) => ({ note, where: "handled" })), ...pending.map((note) => ({ note, where: "pending" }))]) {
    const id = item.note?.id;
    if (typeof id === "string" && id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    unique.push(item);
  }
  return cards.map((card) => {
    const answered = notes.some((note) => {
      if (!note?.request_id?.startsWith("quarterdeck-call:")) return false;
      const answer = taggedEnvelope(note.body, "fm-bearings-answer");
      return answer?.schema === "fm-bearings-answer.v1" && answer.channel === "quarterdeck"
        && answer.type === card.type
        && answer.question === card.answer?.question;
    });
    const matches = card?.key ? unique.flatMap((item) => noteForCard(item.note, card.key, card) ? [notePosture(item.note, item.where, replies)] : []) : [];
    const latest = latestReceipt(matches);
    if (!latest) return answered ? { ...card, answered: true } : card;
    const next = answered ? { ...card, answered: true } : { ...card };
    next.sentReceipt = latest.posture;
    if (latest.posture === "replied") next.sentReply = threadText(latest.reply);
    return next;
  });
}
