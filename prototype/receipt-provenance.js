// Read-only receipt projection. Membership proves intake/posture, not reply-topic ownership.
// Optional hold metadata comes from the existing card; this module creates no cycles.
export function currentCardNote(card, envelope = {}, at = null) {
  if (!card?.holdVersion) return true;
  const updated = Date.parse(card.holdAt || card.clock?.at), sent = Date.parse(at);
  if (Number.isFinite(updated) && Number.isFinite(sent) && updated > sent) return false;
  if (envelope.holdVersion) return envelope.holdVersion === card.holdVersion;
  if (envelope.cardRev) return envelope.cardRev === card.rev;
  return Number.isFinite(updated) && Number.isFinite(sent) && sent >= updated;
}

export function receiptReply(data, note) {
  if (typeof note?.id !== 'string' || !note.id) return { reply: null, scope: 'individual' };
  const reply = data?.replies?.find(entry => entry.id === note.id || entry.note_id === note.id || entry.in_reply_to === note.id) || note.reply;
  // Prefer sealed outbox membership. The fallback uses immutable receipt tuples,
  // never body equality, numbered headings, task names or topic inference.
  const members = new Set([...(data?.pending || []), ...(data?.handled || [])]
    .filter(entry => entry.id === note.id && typeof entry.request_id === 'string').map(entry => entry.request_id));
  const combined = note.submission?.count > 1 || members.size > 1;
  return { reply, scope: combined ? 'combined' : 'individual' };
}

export function replyBody(reply) {
  return typeof reply?.body === 'string' ? reply.body : typeof reply?.text === 'string' ? reply.text : null;
}
