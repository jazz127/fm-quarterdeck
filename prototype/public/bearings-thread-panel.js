// Card threads (BEARINGS.md "Card threads"). History stays collapsed until the captain
// expands a card with two or more entries. A lone entry is not shown. A question is the
// answer controller's thread path; this panel reloads that history and counts new replies.
window.bearingsThread = (() => {
  const STATE_PREFIX = "fm-quarterdeck-call-thread.v1:";
  const MAX_QUESTION_BYTES = 2000;
  const keyOf = (node) => node?.getAttribute?.("data-call-key") || null;
  const LABELS = { ask: "You asked", answer: "Your answer", reply: "Firstmate replied", chat: "Firstmate in chat", "chat-ask": "Firstmate asked in chat" };

  function createThreadController({ list, drafts, doc = window.document, win = window, storage = (() => { try { return win.sessionStorage; } catch { return null; } })(),
    fetchImpl = (...args) => win.fetch(...args), timers = win, pollMs = 15000, uuid = () => win.crypto.randomUUID(), onChange = () => {} } = {}) {
    // Per card key: { entries, checkedAt, loading, error, transcript, notice, baselined, seen }.
    // History is always re-read. A thread send's retry identity lives on the answer controller.
    const states = new Map();
    let pollTimer = null;
    let destroyed = false;
    const stateOf = (key) => {
      if (!states.has(key)) states.set(key, { entries: null, error: null, notice: null });
      return states.get(key);
    };
    const cardNode = (key) => [...list.querySelectorAll("[data-call-key]")].find((node) => keyOf(node) === key) || null;
    const part = (node, name) => node.querySelector(`[data-call-thread-${name}]`);

    const identity = (entry) => JSON.stringify([entry.kind, entry.noteId, entry.at, entry.text]);
    const replies = (state) => (state.entries || []).filter((entry) => entry.kind === "reply");
    const unread = (state) => replies(state).filter((entry) => !state.seen?.has(identity(entry))).length;
    const markRead = (state) => { state.seen = new Set(replies(state).map(identity)); };
    // The latest exchange is the newest turn, plus the message it answers when the
    // two sides differ. Everything before that is "earlier" and stays one click away.
    const latestExchange = (entries) => {
      if (entries.length < 2) return entries.slice();
      const last = entries[entries.length - 1];
      const prev = entries[entries.length - 2];
      return prev.from !== last.from ? [prev, last] : [last];
    };

    function entryNode(entry, state) {
      const item = doc.createElement("li");
      item.className = `call-thread-entry call-thread-${entry.from === "captain" ? "captain" : "firstmate"}`;
      const head = doc.createElement("p");
      head.className = "call-thread-head";
      const who = doc.createElement("strong");
      who.textContent = LABELS[entry.kind] || "Firstmate";
      const when = doc.createElement("time");
      if (entry.at) when.setAttribute("datetime", entry.at);
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(entry.at)) / 60000));
      const relative = age < 1 ? "just now" : age < 60 ? `${age}m ago` : age < 1440 ? `${Math.floor(age / 60)}h ago` : `${Math.floor(age / 1440)}d ago`;
      when.textContent = entry.at && Number.isFinite(Date.parse(entry.at)) ? `${new Date(entry.at).toLocaleString()} · ${relative}` : "time unknown";
      const meta = doc.createElement("span");
      meta.textContent = entry.from === "captain" && entry.state ? ` · ${entry.state === "replied" ? "replied" : entry.state === "received" ? "received by Firstmate" : "waiting for Firstmate"}` : "";
      const dot = doc.createElement("span");
      dot.textContent = " · ";
      head.append(who, dot, when, meta);
      const body = doc.createElement("p");
      body.className = "call-thread-text";
      const text = entry.text || "";
      body.textContent = text;
      item.append(head, body);
      const copy = doc.createElement("button");
      copy.type = "button";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", `Copy ${LABELS[entry.kind] || "message"}`);
      copy.addEventListener("click", async () => {
        try { await win.navigator.clipboard.writeText(text); state.notice = "Message copied"; }
        catch { state.notice = "Copy unavailable; select the message text to copy it"; }
        const node = cardNode(state.key);
        const status = part(node, "status");
        if (status) status.textContent = statusText(state);
        const notice = part(node, "notice");
        if (notice) { notice.textContent = state.notice || ""; notice.hidden = !state.notice; }
      });
      item.append(copy);
      return item;
    }

    function statusText(state) {
      if (state.loading && !state.entries) return "Loading this call's history…";
      if (state.error && !state.entries) return "";
      const count = state.entries?.length || 0;
      const parts = [count ? `${count} ${count === 1 ? "message" : "messages"} about this call` : "Nothing about this call yet."];
      if (state.transcript?.state === "unavailable") parts.push("Firstmate's chat could not be read");
      else if (state.transcript?.windowed) parts.push("chat searched from its newest part only");
      if (state.omitted) parts.push(`${state.omitted} older messages not shown`);
      if (state.notice) parts.push(state.notice);
      return parts.join(" · ");
    }

    // Re-applies thread state to a card's (possibly fresh) markup after every fill.
    function render(node) {
      const key = keyOf(node);
      const history = node?.querySelector?.("[data-call-thread-history]");
      if (!key || !history) return;
      const state = stateOf(key);
      state.key = key;
      const newReplies = unread(state);
      const loaded = Array.isArray(state.entries) ? state.entries.length : null;
      const replyPart = newReplies ? ` · ${newReplies} new ${newReplies === 1 ? "reply" : "replies"}` : "";
      const count = part(node, "count");
      if (count) {
        const label = `Thread${loaded == null ? "" : ` · ${loaded}`}${replyPart}`;
        if (count.textContent !== label) count.textContent = label;
      }
      const replyStatus = part(node, "replies");
      if (replyStatus) {
        const message = newReplies ? `${newReplies} new ${newReplies === 1 ? "reply" : "replies"} from Firstmate for this call` : "";
        if (replyStatus.textContent !== message) replyStatus.textContent = message;
      }
      const entries = state.entries || [];
      const exchange = latestExchange(entries);
      const expandable = entries.length >= 2;
      const open = expandable && state.threadOpen === true;
      const shown = open ? (state.historyOpen ? entries : exchange) : [];
      const earlier = entries.length - exchange.length;
      history.hidden = !open;
      const expand = part(node, "expand");
      if (expand) {
        expand.hidden = !expandable;
        expand.setAttribute("aria-expanded", String(open));
      }
      const log = part(node, "log");
      if (log) {
        const signature = JSON.stringify({ historyOpen: Boolean(state.historyOpen), entries: shown });
        if (log.getAttribute("data-history") !== signature) {
          log.textContent = "";
          log.append(...shown.map((entry) => entryNode(entry, state)));
          log.hidden = shown.length === 0;
          log.setAttribute("data-history", signature);
        }
      }
      const earlierNode = part(node, "earlier");
      if (earlierNode) {
        const message = entries.length === 0 ? "" : state.historyOpen ? `Showing all ${entries.length} messages` : earlier ? `${earlier} earlier ${earlier === 1 ? "message" : "messages"}` : "";
        if (earlierNode.textContent !== message) earlierNode.textContent = message;
        earlierNode.hidden = !message;
      }
      const historyToggle = part(node, "history-toggle");
      if (historyToggle) {
        historyToggle.hidden = earlier <= 0;
        historyToggle.setAttribute("aria-expanded", String(Boolean(state.historyOpen)));
        const label = state.historyOpen ? "Show latest only" : `Show ${earlier} earlier ${earlier === 1 ? "message" : "messages"}`;
        if (historyToggle.textContent !== label) historyToggle.textContent = label;
      }
      const notice = part(node, "notice");
      if (notice) {
        if (notice.textContent !== (state.notice || "")) notice.textContent = state.notice || "";
        notice.hidden = !state.notice;
      }
      const status = part(node, "status");
      const text = entries.length || state.notice || state.error ? statusText(state) : "";
      if (status && status.textContent !== text) status.textContent = text;
      if (state.entries == null && !state.loading && !state.loadQueued) {
        state.loadQueued = true;
        void load(key);
      }
      schedulePoll();
    }
    const rerender = (key) => { const node = cardNode(key); if (node) render(node); };

    async function load(key) {
      const state = stateOf(key);
      if (state.loading) { state.again = true; return; }
      state.loading = true;
      state.again = false;
      rerender(key);
      let response = null, body = null;
      try {
        response = await fetchImpl(`/api/bearings/thread?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        body = await response.json().catch(() => null);
      } catch {}
      if (destroyed) return;
      state.loading = false;
      if (response?.ok && body && Array.isArray(body.entries)) {
        Object.assign(state, { entries: body.entries, omitted: body.omitted || 0, transcript: body.transcript || null, checkedAt: body.checkedAt || null });
        // History is the durable signal. Keep the local receipt until that history includes the ask.
        if (body.entries.some((entry) => entry?.kind === "ask" && entry?.from === "captain")) state.captainAsked = false;
        // The first read marks replies already on the card as seen. Later replies count as new.
        if (!state.baselined) { markRead(state); state.baselined = true; }
        state.error = null;
      } else state.error = body?.error || "This call's history is unavailable right now; it retries while this card is present.";
      rerender(key);
      onChange(key);
      schedulePoll();
      if (state.again) return load(key);
    }

    // The answer controller calls this after a confirmed thread note so the receipt shows at once.
    // captainAsked keeps the card Sent until the reloaded history includes that note.
    function noteSent(key) {
      const state = stateOf(key);
      state.captainAsked = true;
      state.notice = "Question sent to Firstmate; the reply appears here";
      state.error = null;
      rerender(key);
      onChange(key);
      void load(key);
    }

    // Every present card is read once so its history can show above the text box.
    // Polling continues for those cards while the page is visible.
    function watchedKeys() { return [...states.keys()].filter((key) => { const state = states.get(key); return state && (state.entries || state.loadQueued) && cardNode(key); }); }
    async function poll() {
      pollTimer = null;
      if (destroyed) return;
      if (doc.visibilityState !== "hidden") for (const key of watchedKeys()) await load(key);
      schedulePoll();
    }
    function schedulePoll() {
      if (pollTimer || destroyed || !watchedKeys().length) return;
      pollTimer = timers.setTimeout(() => { void poll(); }, pollMs);
    }

    const onClick = (event) => {
      const target = event.target;
      const key = keyOf(target?.closest?.("[data-call-key]"));
      if (!key) return;
      if (target.closest("[data-call-thread-expand]")) {
        event.preventDefault?.();
        const state = stateOf(key);
        state.threadOpen = !state.threadOpen;
        if (state.threadOpen) markRead(state);
        rerender(key);
        return;
      }
      if (target.closest("[data-call-thread-history-toggle]")) {
        event.preventDefault?.();
        const state = stateOf(key);
        state.historyOpen = !state.historyOpen;
        markRead(state);
        rerender(key);
        return;
      }
      if (target.closest("[data-call-thread-history]") && unread(stateOf(key))) { markRead(stateOf(key)); rerender(key); }
    };
    list.addEventListener("click", onClick);

    return {
      render,
      load,
      noteSent,
      state: (key) => states.get(key) || null,
      // Forget threads for calls that left.
      prune(keys) {
        const open = new Set(keys);
        for (const key of [...states.keys()]) if (!open.has(key)) { states.delete(key); try { storage?.removeItem(STATE_PREFIX + key); } catch {} }
      },
      poll,
      destroy() {
        destroyed = true;
        timers.clearTimeout(pollTimer);
        list.removeEventListener("click", onClick);
      },
    };
  }
  return { createThreadController, STATE_PREFIX, MAX_QUESTION_BYTES };
})();
