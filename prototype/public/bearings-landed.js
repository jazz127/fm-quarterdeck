// Just landed (BEARINGS.md). Poster cards for snapshot landed rows. Acknowledge is
// Quarterdeck viewing state. The one text box is a follow-up thread note, never an answer
// and never Procrastinate.
window.bearingsLanded = (() => {
  const MAX_BYTES = 2000;
  const STATE_PREFIX = "fm-quarterdeck-landed-follow.v1:";
  const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const bytes = (text) => new TextEncoder().encode(text).length;
  const clockText = (clock) => window.bearingsView?.clockText?.(clock) || (clock?.at ? `Landed: ${clock.at}` : "Landed: unknown");

  function artifactHtml(card) {
    if (card.url) return `<a class="call-link" href="${escape(card.url)}" target="_blank" rel="noopener noreferrer">${escape(card.url)}</a>`;
    if (!card.artifact) return "";
    const view = window.bearingsView;
    if (!view?.sourceShortened?.(card.artifact)) return `<p class="call-meta" data-landed-artifact>${escape(card.artifact)}</p>`;
    const id = view.idFor(`${card.key || card.task || "landed"}:artifact`);
    const panelId = `landed-artifact-${id}`;
    return `<p class="call-meta" data-landed-artifact data-call-truncated><button type="button" class="call-text-toggle" data-call-text-toggle aria-expanded="false" aria-controls="${panelId}">${escape(card.artifact)}</button></p><div class="call-full" id="${panelId}" data-call-full hidden><p>This is the full text Quarterdeck received.</p></div>`;
  }

  function cardHtml(card) {
    const about = [card.repo || "Repository not recorded", card.owner || "Owner not recorded"].join(" · ");
    const headline = window.bearingsView?.landedHeadlineHtml?.(card) || `<h3>${escape(card.what || "Landing not recorded")}</h3>`;
    const artifact = artifactHtml(card);
    const shortened = headline.includes("data-call-truncated") || artifact.includes("data-call-truncated");
    return `<div class="call-chrome"><header class="call-head"><span class="state-chip">Landed</span><div class="call-head-actions">${card.repo ? `<span class="call-repo">${escape(card.repo)}</span>` : ""}<button type="button" class="call-head-pill landed-ack" data-landed-ack>Acknowledge</button></div><span class="call-age">${escape(clockText(card.clock))}</span></header>
      ${headline}
      <dl class="call-context"><div class="call-context-row"><dt>About</dt><dd>${escape(about)}</dd></div></dl>
      <p class="call-id">Task <code>${escape(card.task || "unknown")}</code></p>
      ${shortened ? `<p class="call-shortened">Firstmate's snapshot shortened this landing; Quarterdeck shows everything it received.</p>` : ""}
      ${artifact}
      <p class="call-meta" data-landed-ack-note hidden>Hidden until this landing changes.</p>
      <p class="call-answer-error" data-landed-ack-error role="alert" hidden></p></div>
      <button type="button" class="call-thread-expand" data-landed-thread-expand aria-expanded="false" hidden>Thread</button>
      <section class="call-thread-history" data-landed-thread-history hidden><ol class="call-thread-log" data-landed-thread-log></ol></section>
      <p class="call-meta" data-landed-notice role="status" hidden></p>
      <form class="call-answer" data-landed-follow novalidate>
        <div class="call-answer-compose">
          <label class="call-answer-note"><span class="sr-only">Follow-up for this landing</span><textarea data-landed-text rows="1" placeholder="Write a follow-up"></textarea></label>
          <div class="call-answer-actions call-answer-bar"><button type="submit" class="call-answer-queue" data-landed-queue>Queue</button><button type="button" class="call-answer-send" data-landed-send hidden>Send</button><button type="button" data-landed-edit hidden>Edit</button></div>
        </div>
        <p class="call-box-hint">Write a follow-up. Firstmate replies in this thread.</p>
        <p class="call-answer-error" data-landed-error role="alert" hidden></p>
        <div class="call-answer-confirm" data-landed-confirm role="group" aria-label="Queued follow-up" hidden><p>Queued for Firstmate: <strong data-landed-preview></strong></p><p class="call-meta">Send sends this follow-up now. Edit takes it out of the queue. Nothing was decided.</p></div>
      </form>`;
  }

  function createController({ list, toggle, badge, invalid, onChange = () => {}, doc = document, storage = (() => { try { return window.sessionStorage; } catch { return null; } })(), fetchImpl = (...args) => globalThis.fetch(...args), timers = globalThis, uuid = () => globalThis.crypto.randomUUID(), pollMs = 15000 } = {}) {
    if (!list) return { update() {}, destroy() {}, count() { return 0; }, newCount() { return 0; } };
    const text = window.bearingsView?.createTextController?.({ list, keyAttribute: "data-landed-key" });
    const drafts = new Map();
    const histories = new Map();
    let model = { state: "loading", landed: [], omitted: [] };
    let acks = {};
    let reviewing = false;
    let pollTimer = null;
    let destroyed = false;
    const draftOf = (key) => {
      if (!drafts.has(key)) {
        let saved = null;
        try { saved = JSON.parse(storage?.getItem(STATE_PREFIX + key) || "null"); } catch {}
        const restored = typeof saved?.text === "string" && typeof saved?.requestId === "string";
        drafts.set(key, { text: restored ? saved.text : "", phase: restored ? "queued" : "draft", requestId: restored ? saved.requestId : null,
          attempted: restored, error: restored ? "Firstmate did not confirm the follow-up; retry sends the same follow-up once" : "", notice: "" });
      }
      return drafts.get(key);
    };
    const historyOf = (key) => {
      if (!histories.has(key)) histories.set(key, { entries: [], open: false });
      return histories.get(key);
    };
    const cards = () => Array.isArray(model.landed) ? model.landed : [];
    const acknowledged = (card) => acks[card.key] === card.rev;
    const newCount = () => cards().filter((card) => !acknowledged(card)).length;
    const nodeOf = (key) => [...list.querySelectorAll("[data-landed-key]")].find((node) => node.getAttribute("data-landed-key") === key) || null;

    function paintPhase(node, key) {
      const draft = draftOf(key);
      const box = node.querySelector("[data-landed-text]");
      const queue = node.querySelector("[data-landed-queue]");
      const send = node.querySelector("[data-landed-send]");
      const edit = node.querySelector("[data-landed-edit]");
      const confirm = node.querySelector("[data-landed-confirm]");
      const preview = node.querySelector("[data-landed-preview]");
      const error = node.querySelector("[data-landed-error]");
      const notice = node.querySelector("[data-landed-notice]");
      if (!box) return;
      if (doc.activeElement !== box && box.value !== draft.text) box.value = draft.text;
      const queued = draft.phase === "queued" || draft.phase === "sending";
      box.disabled = queued;
      if (queue) queue.hidden = queued;
      if (send) { send.hidden = !queued; send.disabled = draft.phase === "sending"; send.textContent = draft.attempted && draft.phase !== "sending" ? "Retry send" : "Send"; }
      if (edit) { edit.hidden = !queued; edit.disabled = draft.phase === "sending" || draft.attempted; }
      if (confirm) confirm.hidden = !queued;
      if (preview) preview.textContent = draft.text;
      if (error) { error.hidden = !draft.error; error.textContent = draft.error || ""; }
      if (notice) { notice.hidden = !draft.notice; notice.textContent = draft.notice || ""; }
    }

    function paintHistory(node, key) {
      const state = historyOf(key);
      const entries = state.entries || [];
      const expand = node.querySelector("[data-landed-thread-expand]");
      const history = node.querySelector("[data-landed-thread-history]");
      const log = node.querySelector("[data-landed-thread-log]");
      const notice = node.querySelector("[data-landed-notice]");
      const expandable = entries.length >= 2;
      if (expand) {
        expand.hidden = !expandable;
        expand.textContent = `Thread · ${entries.length}`;
        expand.setAttribute("aria-expanded", String(expandable && state.open));
      }
      if (history) history.hidden = !(expandable && state.open);
      if (log && expandable && state.open) {
        entries.forEach((entry, index) => {
          let item = log.children[index];
          if (!item) {
            item = doc.createElement("li");
            const head = doc.createElement("p");
            head.className = "call-thread-head";
            head.append(doc.createElement("strong"));
            const body = doc.createElement("p");
            body.className = "call-thread-text";
            item.append(head, body);
            log.append(item);
          }
          const className = `call-thread-entry call-thread-${entry.from === "captain" ? "captain" : "firstmate"}`;
          if (item.className !== className) item.className = className;
          const who = item.querySelector("strong");
          const label = entry.from === "captain" ? "You asked" : "Firstmate replied";
          if (who.textContent !== label) who.textContent = label;
          const body = item.querySelector(".call-thread-text");
          if (body.textContent !== (entry.text || "")) body.textContent = entry.text || "";
        });
        while (log.children.length > entries.length) log.children[log.children.length - 1].remove();
      }
      const draft = draftOf(key);
      if (entries.length === 1 && !draft.notice) {
        const only = entries[0];
        const text = only.from === "captain" ? "Question sent to Firstmate" : "Firstmate replied";
        if (notice && notice.textContent !== text) { notice.hidden = false; notice.textContent = text; }
      }
    }

    function paintCard(node, card) {
      const hidden = acknowledged(card) && !reviewing;
      node.hidden = hidden;
      const button = node.querySelector("[data-landed-ack]");
      const note = node.querySelector("[data-landed-ack-note]");
      const acked = acknowledged(card);
      if (button) {
        button.textContent = acked ? "Acknowledged" : "Acknowledge";
        button.disabled = acked;
      }
      if (note) note.hidden = !acked;
      paintPhase(node, card.key);
      paintHistory(node, card.key);
    }

    function emptyText() {
      const rows = cards();
      if (!rows.length) {
        if (model.state === "loading") return "Checking for landings…";
        if (model.state === "unavailable") return "Just landed unavailable";
        return "No recent completions are in the current baseline.";
      }
      if (!reviewing && rows.every(acknowledged)) return "Acknowledged landings are hidden. Use Acknowledged to review them.";
      return "";
    }

    function paintChrome() {
      const empty = list.querySelector("[data-landed-empty]");
      const text = emptyText();
      if (empty) {
        empty.hidden = !text;
        if (text && empty.textContent !== text) empty.textContent = text;
      }
      const count = cards().filter(acknowledged).length;
      const fresh = newCount();
      if (badge) {
        badge.textContent = String(fresh);
        badge.hidden = fresh === 0;
        badge.setAttribute("aria-label", fresh === 1 ? "1 new landing" : `${fresh} new landings`);
      }
      if (toggle) {
        toggle.textContent = `Acknowledged (${count})`;
        toggle.disabled = count === 0;
        if (count === 0) reviewing = false;
        toggle.setAttribute("aria-pressed", String(reviewing));
      }
      const withheld = (model.omitted || []).find((entry) => entry.kind === "invalid-landed" && entry.count);
      const target = invalid || list.parentElement?.querySelector?.("[data-landed-invalid]");
      if (target) {
        target.hidden = !withheld;
        target.textContent = withheld ? `${withheld.count} invalid landings withheld` : "";
      }
      onChange();
    }

    function render() {
      const rows = cards();
      const focused = list.contains(doc.activeElement) ? doc.activeElement : null;
      const selection = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
      const keys = new Set(rows.map((card) => card.key));
      for (const node of [...list.querySelectorAll("[data-landed-key]")]) {
        if (!keys.has(node.getAttribute("data-landed-key"))) node.remove();
      }
      for (const key of [...drafts.keys()]) if (!keys.has(key)) drafts.delete(key);
      for (const key of [...histories.keys()]) if (!keys.has(key)) histories.delete(key);
      text?.prune?.([...keys]);
      let position = list.querySelector("[data-landed-key]");
      for (const card of rows) {
        let node = nodeOf(card.key);
        if (!node || node.getAttribute("data-landed-rev") !== card.rev) {
          const fresh = doc.createElement("article");
          fresh.className = "call-card";
          fresh.setAttribute("data-landed-key", card.key);
          fresh.setAttribute("data-landed-rev", card.rev);
          fresh.setAttribute("data-call-type", "landed");
          fresh.innerHTML = cardHtml(card);
          if (node) {
            node.querySelector(".call-chrome").replaceWith(fresh.querySelector(".call-chrome"));
            node.setAttribute("data-landed-rev", card.rev);
          } else node = fresh;
        }
        if (node !== position) list.insertBefore(node, position);
        position = node.nextElementSibling;
        paintCard(node, card);
        text?.render?.(node);
        if (!historyOf(card.key).loaded && !node.hidden) void loadHistory(card.key);
      }
      paintChrome();
      if (focused?.isConnected && doc.activeElement !== focused && !focused.disabled) {
        focused.focus({ preventScroll: true });
        if (selection) focused.setSelectionRange(...selection);
      }
    }

    async function readJson(response) {
      try { return await response.json(); } catch { return {}; }
    }

    async function loadAcks() {
      try {
        const response = await fetchImpl("/api/bearings/landed/acks", { cache: "no-store" });
        if (!response.ok) return;
        const body = await readJson(response);
        if (body && body.acks && typeof body.acks === "object") acks = body.acks;
      } catch { /* a preview 404 still shows the cards */ }
      render();
    }

    async function loadHistory(key) {
      const state = historyOf(key);
      state.loaded = true;
      try {
        const response = await fetchImpl(`/api/bearings/thread?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        if (!response.ok) return;
        const body = await readJson(response);
        state.entries = Array.isArray(body.entries) ? body.entries : [];
      } catch { return; }
      const node = nodeOf(key);
      if (node) paintHistory(node, key);
    }

    async function acknowledge(node) {
      const key = node.getAttribute("data-landed-key");
      const button = node.querySelector("[data-landed-ack]");
      const error = node.querySelector("[data-landed-ack-error]");
      if (!key || button?.disabled) return;
      if (button) button.disabled = true;
      try {
        const response = await fetchImpl("/api/bearings/landed/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
        const body = await readJson(response);
        if (!response.ok) {
          if (button) button.disabled = false;
          if (error) { error.hidden = false; error.textContent = body.error || "Could not acknowledge this landing"; }
          return;
        }
        if (body.acks) acks = body.acks;
        if (error) error.hidden = true;
        render();
      } catch {
        if (button) button.disabled = false;
        if (error) { error.hidden = false; error.textContent = "Could not acknowledge this landing"; }
      }
    }

    function queue(node) {
      const key = node.getAttribute("data-landed-key");
      const draft = draftOf(key);
      if (draft.phase !== "draft" || draft.attempted) return;
      const text = (node.querySelector("[data-landed-text]")?.value || "").replace(/\r\n?/g, "\n").trim();
      draft.text = text;
      draft.notice = "";
      if (!text) draft.error = "Write a follow-up first";
      else if (bytes(text) > MAX_BYTES) draft.error = "The follow-up is longer than 2000 bytes";
      else { draft.error = ""; draft.phase = "queued"; draft.requestId ||= uuid(); }
      paintPhase(node, key);
    }

    async function send(node) {
      const key = node.getAttribute("data-landed-key");
      const draft = draftOf(key);
      if (!key || draft.phase !== "queued" || !draft.text) return;
      const uncertain = draft.attempted;
      draft.phase = "sending";
      draft.error = "";
      try {
        storage.setItem(STATE_PREFIX + key, JSON.stringify({ requestId: draft.requestId, text: draft.text }));
      } catch {
        draft.phase = "queued";
        draft.error = "Could not save this follow-up in the tab; this attempt was not sent";
        paintPhase(node, key);
        return;
      }
      draft.attempted = true;
      paintPhase(node, key);
      try {
        const response = await fetchImpl("/api/bearings/thread", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: draft.requestId, key, text: draft.text }),
        });
        const body = await readJson(response);
        if (destroyed) return;
        if (!response.ok) {
          const retry = response.status >= 500 || uncertain;
          draft.phase = retry ? "queued" : "draft";
          if (!retry) {
            draft.requestId = null;
            draft.attempted = false;
            try { storage.removeItem(STATE_PREFIX + key); } catch {}
          }
          draft.error = retry ? `${body.error || "Firstmate did not confirm the follow-up"}; retry sends the same follow-up once` : (body.error || "The follow-up was refused");
          paintPhase(node, key);
          return;
        }
        draft.phase = "draft";
        draft.text = "";
        draft.requestId = null;
        draft.attempted = false;
        try { storage.removeItem(STATE_PREFIX + key); } catch {}
        draft.notice = "Question sent to Firstmate";
        draft.error = "";
        paintPhase(node, key);
        await loadHistory(key);
      } catch {
        if (destroyed) return;
        draft.phase = "queued";
        draft.error = "Firstmate did not confirm the follow-up; retry sends the same follow-up once";
        paintPhase(node, key);
      }
    }

    const onClick = (event) => {
      const node = event.target?.closest?.("[data-landed-key]");
      if (!node || !list.contains(node)) return;
      if (event.target.closest("[data-call-text-toggle]")) return;
      if (event.target.closest("[data-landed-ack]")) { event.preventDefault(); void acknowledge(node); return; }
      if (event.target.closest("[data-landed-edit]")) {
        event.preventDefault();
        const draft = draftOf(node.getAttribute("data-landed-key"));
        if (draft.phase === "sending" || draft.attempted) return;
        draft.phase = "draft";
        paintPhase(node, node.getAttribute("data-landed-key"));
        return;
      }
      if (event.target.closest("[data-landed-send]")) { event.preventDefault(); void send(node); return; }
      if (event.target.closest("[data-landed-thread-expand]")) {
        const key = node.getAttribute("data-landed-key");
        const state = historyOf(key);
        state.open = !state.open;
        paintHistory(node, key);
      }
    };
    const onSubmit = (event) => {
      const form = event.target?.closest?.("[data-landed-follow]");
      const node = form?.closest?.("[data-landed-key]");
      if (!form || !node) return;
      event.preventDefault();
      queue(node);
    };
    const onInput = (event) => {
      const box = event.target?.closest?.("[data-landed-text]");
      const node = box?.closest?.("[data-landed-key]");
      if (!box || !node) return;
      const draft = draftOf(node.getAttribute("data-landed-key"));
      if (draft.phase === "draft" && !draft.attempted) draft.text = box.value;
    };
    list.addEventListener("click", onClick);
    list.addEventListener("submit", onSubmit);
    list.addEventListener("input", onInput);
    toggle?.addEventListener("click", () => {
      if (toggle.disabled) return;
      reviewing = toggle.getAttribute("aria-pressed") !== "true";
      render();
      if (reviewing) for (const card of cards()) if (acknowledged(card)) void loadHistory(card.key);
    });
    void loadAcks();
    pollTimer = timers.setInterval?.(() => {
      if (doc.visibilityState === "hidden") return;
      for (const node of list.querySelectorAll("[data-landed-key]")) {
        if (!node.hidden) void loadHistory(node.getAttribute("data-landed-key"));
      }
    }, pollMs);
    pollTimer?.unref?.();

    return {
      update(next) { model = next || model; render(); },
      count: () => cards().length,
      newCount,
      destroy() {
        destroyed = true;
        text?.destroy?.();
        timers.clearInterval?.(pollTimer);
        list.removeEventListener("click", onClick);
        list.removeEventListener("submit", onSubmit);
        list.removeEventListener("input", onInput);
      },
    };
  }

  return { createController, cardHtml };
})();
