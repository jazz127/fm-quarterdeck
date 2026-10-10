// Captain's Call lifecycle (BEARINGS.md "Lifecycle"). One state per open card, from data
// the page already has. Procrastinated wins, then Sent, then Queued, then Active.
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

  // A sent answer is the local sent phase or the durable inbox classification on the card.
  function answerSent(card, answer) {
    return Boolean(card?.answered || answer?.phase === "sent");
  }

  // A sent thread note is a captain ask or answer already in the card history, or the
  // sending tab's receipt before that history reload includes it.
  function threadSent(thread) {
    if (!thread) return false;
    const entries = Array.isArray(thread.entries) ? thread.entries : [];
    if (entries.some((entry) => entry && entry.from === "captain" && (entry.kind === "ask" || entry.kind === "answer"))) return true;
    return thread.captainAsked === true;
  }

  function cardState({ card = null, answer = null, thread = null, procrastinated = false } = {}) {
    return derive({
      procrastinated: Boolean(procrastinated),
      sent: answerSent(card, answer) || threadSent(thread),
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

  // Send queued (N) sits beside the status control. N is the staged-item count Send batch
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

  return { FILTERS, STORAGE_KEY, LABELS, derive, cardState, counts, readFilter, writeFilter, visible, emptyText, paintToggle, sendQueuedControl, paintSendQueued, answerQueued, answerSent, threadSent };
})();
