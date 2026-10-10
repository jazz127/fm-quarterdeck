import { taggedEnvelope } from "./bearings-thread.js";

// Only durable Quarterdeck answer notes count. A receipt/reply is not closure:
// the caller supplies only cards still open in bearings. Match the card's intake key,
// not its presentation revision: a summary update is not Firstmate confirmation.
export function classifyAnsweredCalls(cards, receipts) {
  const notes = [...(receipts?.pending || []), ...(receipts?.handled || [])];
  return cards.map((card) => {
    const answered = notes.some((note) => {
      if (!note?.request_id?.startsWith("quarterdeck-call:")) return false;
      const answer = taggedEnvelope(note.body, "fm-bearings-answer");
      return answer?.schema === "fm-bearings-answer.v1" && answer.channel === "quarterdeck"
        && answer.type === card.type
        && answer.question === card.answer?.question;
    });
    return answered ? { ...card, answered: true } : card;
  });
}
