// Captain's Call one-box flow (BEARINGS.md "Answers"). Nothing is sent without an explicit
// captain click: Queue locks the note and shows exactly what will go to Firstmate, and
// only Send (this card) or Send batch (the review queue) relays it. A checked option is an
// answer. Text with no option is a card thread note. That path does not use the answer
// phase sent; the thread receipt marks the card Sent until Firstmate replies or closes it.
// A retry after an unconfirmed send is another explicit click and reuses the same request id.
// A card leaves only when Firstmate's next snapshot drops it; this controller never removes a card.
window.bearingsAnswerForm = (() => {
  const STATE_PREFIX = "fm-quarterdeck-call-answer.v1:";
  const MAX_ANSWER_BYTES = 512;
  const MAX_QUESTION_BYTES = 2000;
  const FINAL = new Set(["replied"]);
  const bytes = (text) => new TextEncoder().encode(text).length;
  const display = (selection, note) => selection ? (note ? `${selection} - ${note}` : selection) : note;
  const keyOf = (node) => node?.getAttribute?.("data-call-key") || null;

  // Phases: compose → confirm (queued) → sending → sent; failed (unconfirmed, retry allowed) and
  // refused (the server said no; edit and review again) return to the captain.
  function createStateStore(storage) {
    const memory = new Map();
    const get = (key) => {
      if (memory.has(key)) return memory.get(key);
      let value = null;
      try { const raw = storage?.getItem(STATE_PREFIX + key); const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed.phase === "string") {
        // Reload interrupted the response, not necessarily delivery. Keep its identity;
        // only an explicit Retry click may reconcile it through the idempotent inbox.
        value = ["sending", "failed"].includes(parsed.phase) ? { ...parsed, attempted: true, phase: "failed", error: parsed.error || "The send was interrupted and may already have reached Firstmate. Retry sends the same answer once." } : parsed;
      } } catch {}
      memory.set(key, value);
      return value;
    };
    const set = (key, value) => {
      memory.set(key, value);
      try { if (value) storage?.setItem(STATE_PREFIX + key, JSON.stringify(value)); else storage?.removeItem(STATE_PREFIX + key); } catch {}
    };
    const keys = () => {
      const found = new Set([...memory.keys()].filter((key) => memory.get(key)));
      try { for (let i = 0; i < (storage?.length || 0); i += 1) { const name = storage.key(i); if (name?.startsWith(STATE_PREFIX)) found.add(name.slice(STATE_PREFIX.length)); } } catch {}
      return [...found];
    };
    return { get, set, keys };
  }

  function receiptText(state) {
    const sent = `Sent to Firstmate: ${display(state.selectionLabel || state.selection, state.note)}`;
    const receipt = state.receipt?.state;
    if (receipt === "replied") return `${sent} · Firstmate replied${state.receipt.reply ? `: ${state.receipt.reply}` : ""}`;
    if (receipt === "received") return `${sent} · received by Firstmate · the card leaves when Firstmate resolves the call`;
    return `${sent} · waiting for Firstmate to pick it up`;
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  // The option hint already rendered for this value. No second store: the sent state
  // keeps the label, value and note, and the card still has the hint.
  function optionHint(node, selection) {
    if (!selection) return "";
    const input = [...node.querySelectorAll('input[type="radio"]')].find((item) => item.getAttribute("value") === selection);
    return input?.closest(".call-opt")?.querySelector(".call-opt-hint")?.textContent || "";
  }

  function paintSummary(node, state, sentLock) {
    const block = node.querySelector("[data-call-answer-summary]");
    if (!block) return;
    block.hidden = !sentLock;
    if (!sentLock || !state) return;
    const label = state.selectionLabel || "";
    const selection = state.selection || "";
    const note = state.note || "";
    const recordedHint = optionHint(node, selection);
    const valueHint = recordedHint || (selection && selection !== label ? selection : "");
    const labelNode = block.querySelector("[data-call-answer-summary-label]");
    const hintNode = block.querySelector("[data-call-answer-summary-hint]");
    const noteNode = block.querySelector("[data-call-answer-summary-note]");
    const choice = block.querySelector(".call-your-answer-choice");
    const sent = block.querySelector("[data-call-answer-summary-sent]");
    setText(labelNode, label);
    if (labelNode) labelNode.hidden = !label;
    setText(hintNode, valueHint);
    if (hintNode) hintNode.hidden = !valueHint;
    if (choice) choice.hidden = !label && !valueHint;
    setText(noteNode, note);
    if (noteNode) noteNode.hidden = !note;
    const sentAt = typeof state.sentAt === "string" ? state.sentAt : "";
    const parsed = Date.parse(sentAt);
    setText(sent, Number.isFinite(parsed) ? `Sent ${new Date(sentAt).toLocaleString()}` : "Sent time unknown");
    if (sent && sent.getAttribute("datetime") !== sentAt) sent.setAttribute("datetime", sentAt);
  }

  function createAnswerController({ list, drafts, doc = window.document, win = window, storage = (() => { try { return win.sessionStorage; } catch { return null; } })(),
    fetchImpl = (...args) => win.fetch(...args), timers = win, pollMs = 15000, uuid = () => win.crypto.randomUUID(), onChange = () => {}, onAsked = () => {} } = {}) {
    const states = createStateStore(storage);
    let pollTimer = null;
    let destroyed = false;
    const cardNode = (key) => [...list.querySelectorAll("[data-call-key]")].find((node) => keyOf(node) === key) || null;
    const part = (form, name) => form.querySelector(`[data-call-answer-${name}]`);

    function read(form) {
      const checked = [...form.querySelectorAll('input[type="radio"][data-call-draft="selection"]')].find((input) => input.checked);
      const note = (part(form, "text")?.value || "").replace(/\r\n?/g, "\n").trim();
      // A suggested chat reply is the captain's own words, never a keyed option value.
      // A checked reply is still an option, so it stays on the answer relay.
      const reply = checked?.getAttribute("data-call-reply");
      if (checked && reply) return { path: "answer", selection: "", selectionLabel: "", note: display(reply, note) };
      if (checked) {
        const selection = checked.getAttribute("value") || "";
        return { path: "answer", selection, selectionLabel: checked.getAttribute("data-call-option-label") || selection, note };
      }
      if (note) return { path: "thread", selection: "", selectionLabel: "", note };
      return { path: "", selection: "", selectionLabel: "", note: "" };
    }

    // The one box starts as a line and grows with the draft. Tests without layout skip this.
    function grow(field) {
      if (!field?.style || typeof field.scrollHeight !== "number") return;
      const previous = field.style.height;
      field.style.height = "auto";
      const height = field.scrollHeight;
      if (!height) { field.style.height = previous; return; }
      field.style.height = `${Math.min(Math.max(height, 44), 152)}px`;
    }

    // Applies the stored phase to a card's (possibly fresh) markup. Called by the patcher
    // after every fill, and after every phase change.
    function render(node, card = null) {
      const form = node?.querySelector?.("[data-call-answer]");
      const key = keyOf(node);
      if (!form || !key) return;
      let state = states.get(key);
      // A reply returns the answer to compose. The lifecycle banner shows the reply.
      if (state?.phase === "sent" && state.receipt?.state === "replied") {
        clearDraft(key);
        state = { phase: "compose", heldReply: typeof state.receipt.reply === "string" ? state.receipt.reply : "", heldAt: state.sentAt || new Date().toISOString() };
        states.set(key, state);
      }
      const rev = card?.rev || node.getAttribute("data-call-rev");
      // The captain reviewed a different version of this call: never send it as-is.
      if (state && ["confirm", "failed"].includes(state.phase) && state.cardRev !== rev) {
        state = { ...state, attempted: state.attempted || state.phase === "failed", phase: "refused", error: "This call changed while you were reviewing; check it and review your answer again." };
        states.set(key, state);
      }
      const phase = state?.phase || "compose";
      const previousPhase = form.getAttribute("data-call-answer-phase") || "";
      form.setAttribute("data-call-answer-phase", phase);
      const fields = part(form, "fields");
      // Sent stays on the card: the choices are visible and locked, and the thread
      // control in this fieldset stays usable. A read-only textarea can still be focused
      // and selected. Answer again clears the echo and returns to compose.
      const sentLock = phase === "sent";
      const queuedLock = ["confirm", "sending", "failed"].includes(phase);
      const locked = sentLock || queuedLock;
      if (fields) {
        fields.hidden = false;
        if (locked) fields.setAttribute("data-locked", ""); else fields.removeAttribute("data-locked");
        if (sentLock) fields.setAttribute("data-sent", ""); else fields.removeAttribute("data-sent");
        for (const input of fields.querySelectorAll('input[type="radio"], select')) {
          input.disabled = locked;
          if (!input.matches('input[type="radio"]')) continue;
          if (sentLock) input.checked = Boolean(state?.selection) && input.getAttribute("value") === state.selection;
          else if (previousPhase === "sent") input.checked = false;
        }
        const text = part(form, "text");
        if (text) {
          text.disabled = false;
          text.readOnly = locked;
          text.setAttribute("aria-readonly", String(locked));
          if (sentLock) {
            const note = state?.note || "";
            if (text.value !== note) text.value = note;
          } else if (previousPhase === "sent") text.value = "";
          if (!locked) grow(text);
        }
      }
      paintSummary(node, state, sentLock);
      const bar = form.querySelector(".call-answer-bar");
      if (bar) bar.hidden = sentLock;
      const confirmNote = part(form, "confirm-note");
      if (confirmNote) {
        const text = state?.path === "thread"
          ? "Send submits this note with a short batching delay; Send now in the message composer bypasses it; Send batch in the review queue sends every queued note together. Edit takes it out of the queue."
          : "Send submits this answer with a short batching delay; Send now in the message composer bypasses it; Send batch in the review queue sends every queued answer together. Edit takes it out of the queue.";
        if (confirmNote.textContent !== text) confirmNote.textContent = text;
      }
      const compose = part(form, "compose");
      if (compose) compose.hidden = phase !== "compose" && phase !== "refused";
      const confirm = part(form, "confirm");
      if (confirm) confirm.hidden = !queuedLock;
      const preview = part(form, "preview");
      if (preview) preview.textContent = queuedLock ? display(state.selectionLabel || state.selection, state.note) : "";
      const send = part(form, "send");
      if (send) {
        send.hidden = !queuedLock;
        // aria-disabled, not disabled: a disabled button would drop the captain's focus.
        send.setAttribute("aria-disabled", String(phase === "sending"));
        send.setAttribute("aria-busy", String(phase === "sending"));
        send.textContent = phase === "sending" ? "Pending · batching…" : phase === "failed" ? "Retry send" : "Send";
      }
      const edit = part(form, "edit");
      if (edit) { edit.hidden = !queuedLock; edit.setAttribute("aria-disabled", String(phase === "sending")); }
      const error = part(form, "error");
      if (error) {
        const text = ["refused", "failed"].includes(phase) ? state.error || "" : "";
        if (error.textContent !== text) error.textContent = text;
        error.hidden = !text;
      }
      const receipt = part(form, "receipt");
      if (receipt) {
        receipt.hidden = phase !== "sent";
        const text = phase === "sent" ? receiptText(state) : "";
        const holder = receipt.querySelector("[data-call-answer-receipt-text]") || receipt;
        if (holder.textContent !== text) holder.textContent = text;
      }
    }
    function update(key, state, focus = null) {
      states.set(key, state);
      const node = cardNode(key);
      if (node) {
        render(node);
        const form = node.querySelector("[data-call-answer]");
        if (focus && form) part(form, focus)?.focus?.();
      }
      onChange(key, state);
      schedulePoll();
    }

    function review(form, key) {
      const previous = states.get(key) || {};
      const answer = read(form);
      if (!answer.path) { update(key, { ...previous, phase: "refused", error: "Choose an option or write an answer first." }, "text"); return; }
      const thread = answer.path === "thread";
      const cap = thread ? MAX_QUESTION_BYTES : MAX_ANSWER_BYTES;
      const measured = thread ? answer.note : display(answer.selection, answer.note);
      if (bytes(measured) > cap) { update(key, { ...previous, phase: "refused", error: `The ${thread ? "note" : "answer"} is longer than ${cap} bytes; shorten it.` }, "text"); return; }
      update(key, { phase: "confirm", ...answer, label: form.getAttribute("data-call-answer-label") || key, cardRev: cardNode(key)?.getAttribute("data-call-rev") || null, requestId: previous.requestId || uuid(), attempted: previous.attempted === true }, "send");
    }

    function clearDraft(key) {
      drafts?.set?.(key, "selection", "");
      drafts?.set?.(key, "answer", "");
      const form = cardNode(key)?.querySelector("[data-call-answer]");
      if (!form) return;
      const text = part(form, "text");
      if (text) text.value = "";
      for (const input of form.querySelectorAll('input[type="radio"]')) input.checked = false;
    }

    async function send(key, { focus = true, immediate = false } = {}) {
      const state = states.get(key);
      if (!state || !["confirm", "failed"].includes(state.phase)) return false;
      // A stored send from before the one box has no path; it was an answer.
      const path = state.path || "answer";
      const thread = path === "thread";
      update(key, { ...state, path, phase: "sending", attempted: true, error: null });
      let response = null, body = null;
      try {
        response = await fetchImpl(thread ? "/api/bearings/thread" : "/api/bearings/answer", { method: "POST", headers: { "content-type": "application/json", ...(immediate ? { "x-quarterdeck-send-now": "1" } : {}) },
          body: JSON.stringify(thread ? { requestId: state.requestId, key, text: state.note }
            : { requestId: state.requestId, key, cardRev: state.cardRev, selection: state.selection, note: state.note }) });
        body = await response.json().catch(() => null);
      } catch {}
      if (destroyed) return;
      if (response && response.status === 202) {
        // The words now live in Firstmate's inbox; an unsent-text stub would be wrong.
        clearDraft(key);
        win.dispatchEvent?.(new Event("quarterdeck-sent"));
        if (thread) {
          // Stay in compose so the one box can ask again. onAsked records the thread receipt,
          // which keeps the card Sent until that note is acknowledged or Firstmate replies.
          update(key, null, focus ? "text" : null);
          onAsked(key);
          return true;
        }
        update(key, { phase: "sent", path, requestId: state.requestId, selection: state.selection, selectionLabel: state.selectionLabel, note: state.note, label: state.label, sentAt: body?.sentAt || new Date().toISOString(), receipt: { state: "accepted" } }, focus ? "receipt" : null);
        return true;
      }
      const noun = thread ? "note" : "answer";
      // Unconfirmed (network, 5xx): the same request id may be retried by an explicit click.
      if (!response || response.status >= 500) {
        update(key, { ...state, path, attempted: true, phase: "failed", error: `${body?.error || `Firstmate did not confirm the ${noun}.`} The earlier send may already have reached Firstmate. Retry uses the same request id; editing cannot replace an already recorded ${noun}.` }, focus ? "send" : null);
        return false;
      }
      // Refused (stale call, invalid answer, wrong origin, preview host): edit and queue again.
      update(key, { ...state, path, attempted: true, phase: "refused", error: body?.error || `The ${noun} was not accepted.` }, focus ? "text" : null);
      return false;
    }
    // Queued cards, for the review queue's list and its Send batch. Each item keeps its own
    // request id and its own path, an answer note or a thread note. The server combines nearby submissions into one guarded inbox note.
    const queuedPhases = new Set(["confirm", "sending", "failed"]);
    function queued() {
      const openKeys = new Set([...list.querySelectorAll("[data-call-key]")].map(keyOf));
      return states.keys().filter((key) => openKeys.has(key) && queuedPhases.has(states.get(key)?.phase))
        .map((key) => { const state = states.get(key); return { key, label: state.label || key, text: display(state.selectionLabel || state.selection, state.note), phase: state.phase }; });
    }
    async function sendQueued({ immediate = false } = {}) {
      return (await Promise.all(queued().filter((entry) => entry.phase !== "sending").map((entry) => send(entry.key, { focus: false, immediate })))).every(Boolean);
    }
    function unqueue(key) {
      const state = states.get(key);
      if (!state || !["confirm", "failed"].includes(state.phase)) return;
      update(key, state.attempted || state.phase === "failed" ? { ...state, phase: "compose", attempted: true } : null);
    }

    async function poll() {
      pollTimer = null;
      if (destroyed) return;
      const waiting = states.keys().map((key) => [key, states.get(key)]).filter(([, state]) => state?.phase === "sent" && !FINAL.has(state.receipt?.state));
      if (!waiting.length) return;
      if (doc.visibilityState !== "hidden") {
        try {
          // The status endpoint accepts at most 20 ids per read.
          for (let i = 0; i < waiting.length; i += 20) {
            const batch = waiting.slice(i, i + 20);
            const response = await fetchImpl(`/api/bearings/answer/status?ids=${batch.map(([, state]) => encodeURIComponent(state.requestId)).join(",")}`);
            const data = response.ok ? await response.json() : null;
            for (const [key, state] of batch) {
              const next = data?.answers?.[state.requestId];
              // Answer again or pruning may have happened while this read was pending.
              if (states.get(key) === state && next && next.state !== "unknown" && next.state !== state.receipt?.state) update(key, { ...state, receipt: next });
            }
          }
        } catch {}
      }
      schedulePoll();
    }
    function schedulePoll() {
      if (pollTimer || destroyed) return;
      if (!states.keys().some((key) => { const state = states.get(key); return state?.phase === "sent" && !FINAL.has(state.receipt?.state); })) return;
      pollTimer = timers.setTimeout(() => { void poll(); }, pollMs);
    }

    const onSubmit = (event) => {
      const form = event.target?.closest?.("[data-call-answer]");
      const key = keyOf(form?.closest?.("[data-call-key]"));
      if (!form || !key) return;
      event.preventDefault();
      const phase = states.get(key)?.phase || "compose";
      if (phase === "compose" || phase === "refused") review(form, key);
    };
    const onClick = (event) => {
      const target = event.target;
      const key = keyOf(target?.closest?.("[data-call-key]"));
      if (!key) return;
      if (target.closest("[data-call-answer-send]")) { event.preventDefault?.(); void send(key); }
      else if (target.closest("[data-call-answer-edit]")) { event.preventDefault?.(); if (states.get(key)?.phase !== "sending") {
        const state = states.get(key);
        update(key, state?.attempted || state?.phase === "failed" ? { ...state, phase: "compose", attempted: true } : null, "text");
      } }
      else if (target.closest("[data-call-answer-again]")) { event.preventDefault?.(); update(key, null, "text"); }
    };
    const onInput = (event) => { const field = event.target?.closest?.("[data-call-answer-text]"); if (field) grow(field); };
    list.addEventListener("submit", onSubmit);
    list.addEventListener("click", onClick);
    list.addEventListener("input", onInput);
    schedulePoll();

    return {
      render,
      // Forget answers for calls Firstmate no longer shows, so a re-held task starts fresh.
      prune(openKeys) {
        const open = new Set(openKeys);
        for (const key of states.keys()) if (!open.has(key) && states.get(key)?.phase !== "sending") states.set(key, null);
      },
      state: (key) => states.get(key),
      queued,
      sendQueued,
      unqueue,
      poll,
      destroy() {
        destroyed = true;
        timers.clearTimeout(pollTimer);
        list.removeEventListener("submit", onSubmit);
        list.removeEventListener("click", onClick);
        list.removeEventListener("input", onInput);
      },
    };
  }

  return { createAnswerController, createStateStore, STATE_PREFIX, MAX_ANSWER_BYTES, MAX_QUESTION_BYTES };
})();
