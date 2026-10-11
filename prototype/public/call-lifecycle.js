// Captain's Call lifecycle (BEARINGS.md "Lifecycle"). One state per open card, from data
// the page already has. Procrastinated wins, then Sent, then Queued, then Active.
// Sent is only while the latest captain note is pending or acknowledged.
// A recorded reply returns the open card to Active.
window.callLifecycle = (() => {
  const FILTERS = ["active", "queued", "sent", "procrastinated", "all"];
  const STORAGE_KEY = "fm-quarterdeck-call-lifecycle.v1";
  const LABELS = { active: "Active", queued: "Queued", sent: "Sent", procrastinated: "Procrastinated", all: "All" };
  const QUEUED_PHASES = new Set(["confirm", "sending", "failed"]);

  function derive({ procrastinated = false, sent = false, queued = false } = {}) {
    if (procrastinated) return "procrastinated";
    if (sent) return "sent";
    if (queued) return "queued";
    return "active";
  }

  // The one-box queue (confirm, an in-flight send, or a retry) stages an answer or a thread note.
  function answerQueued(answer) {
    return QUEUED_PHASES.has(answer?.phase);
  }

  function entryPosture(entry) {
    if (entry?.state === "replied") return "replied";
    if (entry?.state === "received") return "acknowledged";
    return "pending";
  }

  function receiptPosture(state) {
    if (state === "replied") return "replied";
    if (state === "received") return "acknowledged";
    return "pending";
  }

  const POSTURE_RANK = { pending: 0, acknowledged: 1, replied: 2 };

  function replyText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // The reply joined to this captain note, else the latest reply text when the note is replied.
  function replyFor(entry, entries) {
    if (!entry || !Array.isArray(entries)) return "";
    const matched = entries.find((item) => item && item.kind === "reply" && item.noteId && entry.noteId && item.noteId === entry.noteId && replyText(item.text));
    if (matched) return replyText(matched.text);
    if (entry.state !== "replied") return "";
    const replies = entries.filter((item) => item && item.kind === "reply" && replyText(item.text));
    return replies.length ? replyText(replies[replies.length - 1].text) : "";
  }

  function cardPosture(card) {
    if (card?.sentReceipt === "pending" || card?.sentReceipt === "acknowledged" || card?.sentReceipt === "replied") return card.sentReceipt;
    if (card?.answered) return "pending";
    return null;
  }

  // Latest captain note from receipts the page already holds.
  // Pending: still unread. Acknowledged: read, no reply. Replied: the call is the captain's again.
  function delivery({ card = null, answer = null, thread = null } = {}) {
    const entries = Array.isArray(thread?.entries) ? thread.entries : null;
    const captain = entries ? entries.filter((entry) => entry && entry.from === "captain" && (entry.kind === "ask" || entry.kind === "answer")) : [];
    const latest = captain.length ? captain[captain.length - 1] : null;
    let posture = latest ? entryPosture(latest) : null;
    let reply = posture === "replied" ? replyFor(latest, entries) : "";

    if (answer?.phase === "sent") {
      const local = receiptPosture(answer.receipt?.state);
      const localReply = local === "replied" ? replyText(answer.receipt?.reply) : "";
      const answerIsLatest = !latest || latest.kind === "answer";
      const answerIsNewer = Boolean(answer.sentAt && latest?.at && String(answer.sentAt) > String(latest.at));
      if (answerIsLatest || answerIsNewer) {
        if (!posture || POSTURE_RANK[local] >= POSTURE_RANK[posture] || answerIsNewer) {
          posture = local;
          reply = local === "replied" ? (localReply || reply) : "";
        }
      }
    }

    const held = answer?.heldReply != null && answer?.phase !== "sent" && !["confirm", "sending", "failed"].includes(answer?.phase);
    if (held && answer.heldAt && latest?.at && String(answer.heldAt) > String(latest.at)) {
      posture = "replied";
      reply = replyText(answer.heldReply);
    } else if (held && posture !== "pending" && posture !== "acknowledged") {
      posture = "replied";
      reply = reply || replyText(answer.heldReply);
    }

    // A thread send the history does not list yet is newer than the reply already on the card.
    if (thread?.captainAsked === true) {
      posture = "pending";
      reply = "";
    }

    if (!posture) {
      const fallback = cardPosture(card);
      if (fallback) {
        posture = fallback;
        reply = fallback === "replied" ? replyText(card?.sentReply) : "";
      }
    }

    return { posture, reply: posture === "replied" ? reply : "" };
  }

  function sentLabel(posture) {
    return posture === "acknowledged" ? "Firstmate is on it" : "Sent - waiting for Firstmate to read";
  }

  function replyBanner(reply) {
    const text = replyText(reply);
    return text ? `Firstmate replied: ${text}` : "Firstmate replied";
  }

  function cardState({ card = null, answer = null, thread = null, procrastinated = false } = {}) {
    const posture = delivery({ card, answer, thread }).posture;
    return derive({
      procrastinated: Boolean(procrastinated),
      sent: posture === "pending" || posture === "acknowledged",
      queued: answerQueued(answer),
    });
  }

  function counts(states) {
    const tally = { active: 0, queued: 0, sent: 0, procrastinated: 0, all: 0 };
    for (const state of states || []) {
      tally.all += 1;
      if (state !== "all" && Object.hasOwn(tally, state)) tally[state] += 1;
    }
    return tally;
  }

  function readFilter(storage) {
    try {
      const value = storage?.getItem(STORAGE_KEY);
      if (FILTERS.includes(value)) return value;
    } catch {}
    return "active";
  }

  function writeFilter(storage, value) {
    if (!FILTERS.includes(value)) return readFilter(storage);
    try { storage?.setItem(STORAGE_KEY, value); } catch {}
    return value;
  }

  function visible(state, filter) {
    return filter === "all" || state === filter;
  }

  function emptyText(filter, tally) {
    if (!FILTERS.includes(filter) || filter === "all" || !tally || tally.all === 0 || (tally[filter] || 0) > 0) return "";
    return `No ${LABELS[filter]} cards.`;
  }

  function paintToggle(root, tally, filter) {
    if (!root?.querySelectorAll) return;
    for (const button of root.querySelectorAll("[data-call-lifecycle]")) {
      const name = button.getAttribute("data-call-lifecycle");
      if (!FILTERS.includes(name)) continue;
      const label = `${LABELS[name]} (${tally?.[name] ?? 0})`;
      if (button.textContent !== label) button.textContent = label;
      const pressed = String(name === filter);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
  }

  // Send queued (N) sits beside the status control. N is the staged-item count Send
  // would send. The button exists only on Active while that count is positive.
  function sendQueuedControl({ filter = "active", count = 0, sending = false } = {}) {
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    const busy = Boolean(sending);
    const noun = n === 1 ? "answer" : "answers";
    return {
      hidden: filter !== "active" || n === 0,
      disabled: busy,
      text: `Send queued (${n})`,
      label: `${busy ? "Sending" : "Send"} ${n} queued Captain's Call ${noun}`,
    };
  }

  function paintSendQueued(button, options) {
    if (!button) return;
    const view = sendQueuedControl(options);
    button.hidden = view.hidden;
    button.disabled = view.disabled;
    if (button.textContent !== view.text) button.textContent = view.text;
    if (button.getAttribute("aria-label") !== view.label) button.setAttribute("aria-label", view.label);
  }

  return { FILTERS, STORAGE_KEY, LABELS, derive, cardState, delivery, sentLabel, replyBanner, counts, readFilter, writeFilter, visible, emptyText, paintToggle, sendQueuedControl, paintSendQueued, answerQueued };
})();
