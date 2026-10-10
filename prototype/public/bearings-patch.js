// Captain's Call keyed patcher and per-card engagement hold (BEARINGS.md).
// Only engaged cards wait; unrelated cards reconcile immediately. Drafts survive
// every rebuild, including a card leaving.
window.bearingsPatch = (() => {
  const DRAFT_PREFIX = "fm-quarterdeck-call-draft.v1:";
  const SORT_KEY = "fm-quarterdeck-call-sort.v1";
  function sortCards(cards, order) {
    return [...cards].sort((a, b) => {
      const left = Date.parse(a.clock?.at), right = Date.parse(b.clock?.at);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.isFinite(left) ? -1 : Number.isFinite(right) ? 1 : 0;
      return order === "oldest" ? left - right : right - left;
    });
  }
  // Clicks on controls act on the control; they never select or deselect the card.
  const INTERACTIVE = "a, button, input, textarea, select, label, summary, [contenteditable]";
  const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const keyOf = (node) => node?.getAttribute?.("data-call-key") || null;

  // Minimal fallback presentation; bearings-view.js supplies the product rendering.
  const fallbackView = {
    cardHtml: (card) => `<p><strong>${escapeHtml(card.type === "merge" ? "Merge" : "Decision")}</strong> ${escapeHtml(card.summary || card.reason || card.task)}</p>`,
    emptyHtml: (model) => escapeHtml(model.state === "loading" ? "Checking for captain's calls…" : model.coverage?.provenClear ? "Nothing needs your action right now" : model.error && !model.coverage ? `Captain's Call unavailable: ${model.error}` : "No decision is recorded"),
    coverageText: (model) => model.coverage ? `checked ${model.coverage.checked} of ${model.coverage.known}` : "",
    heldText: (change) => `Call ${change} — updates when you're done`,
    stubHtml: () => '<p>Resolved by Firstmate — your unsent text</p><pre data-call-stub-text></pre><button type="button" data-call-stub-copy>Copy</button> <button type="button" data-call-stub-dismiss>Dismiss</button>',
  };

  // Session-scoped per-card drafts. Storage may be absent or throw (private windows,
  // previews), so an in-memory copy is always authoritative for this page.
  function createDraftStore(storage) {
    const memory = new Map();
    const read = (key) => {
      if (memory.has(key)) return memory.get(key);
      let value = {};
      try { const raw = storage?.getItem(DRAFT_PREFIX + key); const parsed = raw ? JSON.parse(raw) : null; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed; } catch {}
      memory.set(key, value);
      return value;
    };
    const write = (key, value) => {
      memory.set(key, value);
      try { if (Object.keys(value).length) storage?.setItem(DRAFT_PREFIX + key, JSON.stringify(value)); else storage?.removeItem(DRAFT_PREFIX + key); } catch {}
    };
    return {
      get: read,
      set(key, field, text) {
        const next = { ...read(key) };
        if (typeof text === "string" && text) next[field] = text; else delete next[field];
        write(key, next);
      },
      text: (key) => Object.values(read(key)).filter((value) => typeof value === "string" && value.trim()).join("\n\n"),
      clear: (key) => write(key, {}),
    };
  }

  function rangeTouches(range, node) {
    try { return range.intersectsNode(node); } catch { return false; }
  }

  function createEngagementTracker(section, { doc = window.document, timers = window, onChange = () => {} } = {}) {
    const state = { focus: false, selection: false, pointer: false, selected: null };
    let pointerKey = null;
    const keys = () => {
      const result = new Set();
      const focusKey = keyOf(doc.activeElement?.closest?.("[data-call-key]"));
      if (state.focus && focusKey) result.add(focusKey);
      if (pointerKey) result.add(pointerKey);
      if (state.selected) result.add(state.selected);
      const selection = doc.getSelection?.();
      if (selection && !selection.isCollapsed) {
        for (const card of section.querySelectorAll("[data-call-key]")) {
          for (let i = 0; i < selection.rangeCount; i++) if (rangeTouches(selection.getRangeAt(i), card)) result.add(keyOf(card));
        }
      }
      return result;
    };
    const engaged = () => state.focus || state.selection || state.pointer || Boolean(state.selected);
    const notify = () => onChange(engaged(), keys());
    const cardByKey = (key) => [...section.querySelectorAll("[data-call-key]")].find((node) => keyOf(node) === key) || null;
    function deselect(key = null) {
      if (!state.selected || (key && key !== state.selected)) return;
      cardByKey(state.selected)?.removeAttribute("aria-current");
      state.selected = null;
      notify();
    }
    function select(card) {
      if (state.selected) cardByKey(state.selected)?.removeAttribute("aria-current");
      card.setAttribute("aria-current", "true");
      state.selected = keyOf(card);
      notify();
    }
    const selectionInside = () => {
      const selection = doc.getSelection?.();
      return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0 && rangeTouches(selection.getRangeAt(0), section));
    };
    const listeners = [
      [section, "focusin", () => { state.focus = true; notify(); }],
      // Re-read after the move settles. Window blur keeps activeElement inside the
      // section, so switching apps does not count as finishing.
      [section, "focusout", () => { timers.setTimeout(() => { state.focus = section.contains(doc.activeElement); notify(); }, 0); }],
      [doc, "selectionchange", () => { state.selection = selectionInside(); notify(); }],
      [section, "pointerdown", (event) => { state.pointer = true; pointerKey = keyOf(event.target?.closest?.("[data-call-key]")); notify(); }],
      [doc, "pointerup", () => { if (state.pointer) { state.pointer = false; pointerKey = null; notify(); } }],
      [doc, "pointercancel", () => { if (state.pointer) { state.pointer = false; pointerKey = null; notify(); } }],
      [section, "click", (event) => {
        // Finishing a drag-selection is not a card click.
        if (selectionInside() || event.target?.closest?.(INTERACTIVE)) return;
        const card = event.target?.closest?.("[data-call-key]");
        if (!card || !section.contains(card)) return;
        if (keyOf(card) === state.selected) deselect(); else select(card);
      }],
      [doc, "click", (event) => { if (state.selected && !section.contains(event.target)) deselect(); }],
      [doc, "keydown", (event) => { if (event.key === "Escape") deselect(); }],
    ];
    for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
    return {
      engaged,
      keys,
      state: () => ({ ...state }),
      deselect,
      destroy() { for (const [target, type, listener] of listeners) target.removeEventListener(type, listener); },
    };
  }

  // Counts against what is on screen, so the held message names what will change.
  function diffCards(appliedRevs, cards) {
    let added = 0, changed = 0;
    const seen = new Set();
    for (const card of cards || []) {
      seen.add(card.key);
      if (!appliedRevs.has(card.key)) added += 1;
      else if (appliedRevs.get(card.key) !== card.rev) changed += 1;
    }
    const removed = [...appliedRevs.keys()].filter((key) => !seen.has(key)).length;
    return { added, changed, removed, total: added + changed + removed };
  }

  function createCallPatcher({ section, list, status, coverage = null, view = window.bearingsView || fallbackView, doc = window.document, win = window, storage = (() => { try { return win.sessionStorage; } catch { return null; } })(),
    sortControl = null, viewerStorage = (() => { try { return win.localStorage; } catch { return null; } })(), timers = win, holdDelayMs = 600, scroller = null, highlightMs = 2400, leaveMs = 320, onApply = () => {}, onHeld = () => {}, onRender = () => {} } = {}) {
    const render = { ...fallbackView, ...view };
    const drafts = createDraftStore(storage);
    const appliedRevs = new Map();
    let appliedRev = null;
    let applied = null;
    let pending = null;
    const releaseTimers = new Map();
    let engagedKeys = new Set();
    let sortReleaseTimer = null;
    let held = false;
    let sortOrder = "newest", appliedSort = null, clockTimer = null;
    try { if (viewerStorage?.getItem(SORT_KEY) === "oldest") sortOrder = "oldest"; } catch {}
    if (sortControl) sortControl.value = sortOrder;
    const reducedMotion = () => Boolean(win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    const tracker = createEngagementTracker(section, { doc, timers, onChange: (engaged, keys) => {
      for (const key of keys) { timers.clearTimeout(releaseTimers.get(key)); releaseTimers.delete(key); }
      for (const key of engagedKeys) if (!keys.has(key) && !releaseTimers.has(key)) {
        releaseTimers.set(key, timers.setTimeout(() => {
          releaseTimers.delete(key);
          if (pending) update(pending);
        }, holdDelayMs));
      }
      engagedKeys = keys;
      timers.clearTimeout(sortReleaseTimer);
      sortReleaseTimer = null;
      if (!engaged) sortReleaseTimer = timers.setTimeout(() => {
        sortReleaseTimer = null;
        if (pending) update(pending);
      }, holdDelayMs);
    } });
    // Card changes never use the old section status line.
    status.hidden = true;
    status.innerHTML = "";
    const sortNotice = sortControl ? doc.createElement("span") : null;
    if (sortNotice) {
      sortNotice.setAttribute("data-call-sort-pending", "");
      sortNotice.setAttribute("role", "status");
      sortNotice.innerHTML = "Sort waits until you're done <button type=\"button\" data-call-sort-now>Update now</button>";
      sortNotice.hidden = true;
      sortControl.parentNode.append(sortNotice);
    }
    const heldKeys = () => new Set([...tracker.keys(), ...releaseTimers.keys()]);
    function cancelRelease() {
      for (const timer of releaseTimers.values()) timers.clearTimeout(timer);
      releaseTimers.clear();
      timers.clearTimeout(sortReleaseTimer);
      sortReleaseTimer = null;
    }
    function showNotices(model) {
      const next = new Map(model.cards.map((card) => [card.key, card]));
      let count = 0;
      for (const node of list.querySelectorAll("[data-call-key]")) {
        const card = next.get(keyOf(node));
        const change = !card ? "resolved" : card.rev !== node.getAttribute("data-call-rev") ? "updated" : null;
        let notice = node.querySelector("[data-call-held]");
        if (!change || node.classList.contains("call-card-leaving")) {
          notice?.remove(); node.removeAttribute("data-held"); node.removeAttribute("aria-busy"); continue;
        }
        count++;
        if (!notice) {
          notice = doc.createElement("div");
          notice.className = "call-card-notice";
          notice.setAttribute("data-call-held", "");
          notice.setAttribute("role", "status");
          notice.innerHTML = '<span data-call-held-text></span> <button type="button" data-call-update-now>Update now</button>';
          node.append(notice);
        }
        const text = render.heldText(change);
        if (notice.querySelector("[data-call-held-text]").textContent !== text) notice.querySelector("[data-call-held-text]").textContent = text;
        node.setAttribute("data-held", "true");
        node.setAttribute("aria-busy", "true");
      }
      held = Boolean(count || appliedSort !== sortOrder);
      if (sortNotice) sortNotice.hidden = appliedSort === sortOrder;
      onHeld(held, diffCards(appliedRevs, model.cards));
    }

    function restoreDrafts(node, key) {
      const saved = drafts.get(key);
      for (const field of node.querySelectorAll("[data-call-draft]")) {
        const name = field.getAttribute("data-call-draft");
        // A radio group keeps its chosen value; every radio shares the field name.
        if (field.getAttribute("type") === "radio") field.checked = saved[name] === field.getAttribute("value");
        else if (typeof saved[name] === "string") field.value = saved[name];
      }
    }
    function fill(node, card) {
      node.innerHTML = render.cardHtml(card);
      node.setAttribute("data-call-rev", card.rev);
      node.setAttribute("data-call-type", card.type);
      restoreDrafts(node, card.key);
      // Per-card controllers (answer form, overflow) re-apply their own state to fresh markup.
      try { onRender(node, card); } catch {}
    }
    function createCard(card) {
      const node = doc.createElement("article");
      node.className = "call-card";
      node.setAttribute("data-call-key", card.key);
      fill(node, card);
      return node;
    }
    function createStub(key, text) {
      const node = doc.createElement("article");
      node.className = "call-card call-card-resolved";
      node.setAttribute("data-call-stub", key);
      node.innerHTML = render.stubHtml(key, text);
      const holder = node.querySelector("[data-call-stub-text]");
      if (holder) holder.textContent = text;
      return node;
    }
    function leave(node) {
      if (node.classList.contains("call-card-leaving")) return;
      node.classList.add("call-card-leaving");
      node.setAttribute("aria-hidden", "true");
      const remove = () => { if (node.classList.contains("call-card-leaving")) node.remove(); };
      if (reducedMotion() || !leaveMs) remove(); else timers.setTimeout(remove, leaveMs);
    }
    function viewportTop() { return scroller ? scroller.getBoundingClientRect().top : 0; }
    // Keep the first visible card still when cards above it change, but only once the
    // list has scrolled; at the top a new call should push in visibly.
    function captureAnchor() {
      const top = viewportTop();
      // Prefer an engaged visible card even before the list has scrolled.
      for (const node of list.children) {
        const rect = node.getBoundingClientRect();
        if (heldKeys().has(keyOf(node)) && rect.bottom > top && !node.hidden) return { node, top: rect.top };
      }
      if (list.getBoundingClientRect().top >= top) return null;
      for (const node of list.children) {
        const key = keyOf(node) || node.getAttribute("data-call-stub");
        if (!key) continue;
        const rect = node.getBoundingClientRect();
        if (rect.bottom > top) return { node, top: rect.top };
      }
      return null;
    }
    function restoreAnchor(anchor) {
      if (!anchor || !anchor.node.isConnected) return;
      const delta = anchor.node.getBoundingClientRect().top - anchor.top;
      if (Math.abs(delta) < 1) return;
      if (scroller) scroller.scrollTop += delta; else win.scrollBy?.(0, delta);
    }

    // Empty state and coverage hold no captain input, so freshness may refresh them
    // even while the cards are held.
    function renderChrome(model) {
      const empty = list.querySelector("[data-call-empty]");
      if (empty) {
        const html = render.emptyHtml(model);
        if (empty.innerHTML !== html) empty.innerHTML = html;
      }
      if (coverage) {
        const text = render.coverageText(model);
        if (coverage.textContent !== text) coverage.textContent = text;
      }
    }
    function observe(freshness) {
      if (!applied || !freshness || freshness.rev !== appliedRev) return;
      const { unchanged, cards, ...fields } = freshness;
      applied = { ...applied, ...fields };
      renderChrome(applied);
    }

    function apply(model, protectedKeys = new Set(), order = sortOrder) {
      const cards = model.cards;
      const existing = new Map();
      const stubs = new Map();
      const leaving = [];
      let empty = null;
      for (const node of [...list.children]) {
        if (node.hasAttribute("data-call-empty")) empty = node;
        else if (node.hasAttribute("data-call-stub")) stubs.set(node.getAttribute("data-call-stub"), node);
        else if (node.classList.contains("call-card-leaving")) leaving.push(node);
        else if (keyOf(node)) existing.set(keyOf(node), node);
      }
      const ordered = [];
      for (const card of cards) {
        let node = existing.get(card.key) || leaving.find((entry) => keyOf(entry) === card.key);
        if (node) {
          existing.delete(card.key);
          if (node.classList.contains("call-card-leaving")) {
            leaving.splice(leaving.indexOf(node), 1);
            node.classList.remove("call-card-leaving");
            node.removeAttribute("aria-hidden");
          }
          if (node.getAttribute("data-call-rev") !== card.rev) fill(node, card);
        } else {
          node = createCard(card);
          stubs.get(card.key)?.remove();
          stubs.delete(card.key);
          if (applied && !reducedMotion() && highlightMs) {
            node.classList.add("call-card-new");
            timers.setTimeout(() => node.classList.remove("call-card-new"), highlightMs);
          }
        }
        ordered.push(node);
      }
      for (const [key, node] of existing) {
        const text = drafts.text(key);
        if (text) {
          // Never lose typed text: a resolved card becomes a copyable stub.
          const stub = createStub(key, text);
          list.insertBefore(stub, node);
          node.remove();
          stubs.set(key, stub);
        } else { leave(node); leaving.push(node); }
      }
      if (!cards.length && !stubs.size) {
        if (!empty) { empty = doc.createElement("p"); empty.className = "call-empty"; empty.setAttribute("data-call-empty", ""); }
        ordered.push(empty);
      } else empty?.remove();
      // Move nodes into place; never recreate them.
      const desired = [...ordered, ...stubs.values(), ...leaving];
      // Do not detach an engaged node: moving it can drop focus/selection.
      // Place neighbours around it instead.
      for (let index = desired.length - 1; index >= 0; index--) {
        const node = desired[index], before = desired[index + 1] || null;
        const current = [...list.children];
        if (!protectedKeys.has(keyOf(node)) && (current[current.indexOf(node) + 1] || null) !== before) list.insertBefore(node, before);
        else if (!node.parentNode) list.insertBefore(node, before);
      }
      renderChrome(model);
      appliedRevs.clear();
      for (const card of cards) appliedRevs.set(card.key, card.rev);
      appliedRev = model.rev;
      applied = model;
      appliedSort = order;
      onApply(model);
    }

    function update(model) {
      if (!model || !Array.isArray(model.cards)) return "ignored";
      if (applied && model.rev === appliedRev && !diffCards(appliedRevs, model.cards).total && appliedSort === sortOrder) {
        // Back to what is on screen: nothing is waiting any more.
        pending = null;
        cancelRelease();
        showNotices(model);
        observe(model);
        return "unchanged";
      }
      return reconcile(model);
    }
    function reconcile(model, releaseKey = null, forceSort = false) {
      const protectedKeys = heldKeys();
      if (releaseKey) protectedKeys.delete(releaseKey);
      const cards = [...model.cards];
      for (const card of applied?.cards || []) if (protectedKeys.has(card.key)) {
        const index = cards.findIndex((entry) => entry.key === card.key);
        if (index >= 0) cards[index] = card;
        else cards.splice(Math.min(applied.cards.indexOf(card), cards.length), 0, card);
      }
      const waitSort = !forceSort && applied && (tracker.engaged() || releaseTimers.size || sortReleaseTimer);
      const order = waitSort ? appliedSort : sortOrder;
      const ordered = sortCards(cards, order);
      const anchor = captureAnchor();
      // Explicit sort Update now may move selected nodes, but never releases
      // their pending card changes. Normal background patches never detach them.
      apply({ ...model, cards: ordered }, forceSort ? new Set() : protectedKeys, order);
      pending = diffCards(appliedRevs, model.cards).total || appliedSort !== sortOrder ? model : null;
      showNotices(model);
      restoreAnchor(anchor);
      return pending ? "held" : "applied";
    }
    function applyNow(key = null) {
      tracker.deselect(key);
      if (key) { timers.clearTimeout(releaseTimers.get(key)); releaseTimers.delete(key); }
      if (pending) reconcile(pending, key, !key);
    }

    function setSort(order) {
      if (!["oldest", "newest"].includes(order)) return;
      sortOrder = order;
      if (sortControl) sortControl.value = order;
      try { viewerStorage?.setItem(SORT_KEY, order); } catch {}
      if (pending || applied) update(pending || applied);
    }
    const onSort = () => setSort(sortControl.value);
    sortControl?.addEventListener("change", onSort);
    // Tick only clock text, never rebuild a card or disturb its answer phase.
    function tickClocks() {
      if (doc.visibilityState !== "hidden" && !tracker.state().selection) {
        for (const node of list.querySelectorAll("[data-call-clock]")) {
          const text = render.clockText?.({ at: node.getAttribute("data-call-clock"), label: node.getAttribute("data-call-clock-label") });
          if (typeof text === "string" && node.textContent !== text) node.textContent = text;
        }
      }
      clockTimer = timers.setTimeout(tickClocks, 1000);
    }
    clockTimer = timers.setTimeout(tickClocks, 1000);

    const onInput = (event) => {
      const field = event.target?.closest?.("[data-call-draft]");
      const card = field?.closest?.("[data-call-key]");
      const radio = field?.getAttribute("type") === "radio";
      if (!field || !card || (radio && !field.checked)) return;
      drafts.set(keyOf(card), field.getAttribute("data-call-draft"), radio ? field.getAttribute("value") : field.value);
    };
    const onClick = (event) => {
      const target = event.target;
      if (target?.closest?.("[data-call-update-now]")) { applyNow(keyOf(target.closest("[data-call-key]"))); return; }
      if (target?.closest?.("[data-call-sort-now]")) { applyNow(); return; }
      const stub = target?.closest?.("[data-call-stub]");
      if (!stub) return;
      const key = stub.getAttribute("data-call-stub");
      if (target.closest("[data-call-stub-dismiss]")) {
        drafts.clear(key);
        stub.remove();
        // The captain's own action may restore the empty state, but never drops a waiting update.
        if (!pending && applied && !applied.cards.length && ![...list.children].some((node) => node.hasAttribute("data-call-stub"))) apply(applied);
      } else if (target.closest("[data-call-stub-copy]")) {
        const text = drafts.text(key);
        const holder = stub.querySelector("[data-call-stub-text]");
        const selectText = () => { if (holder) doc.getSelection?.()?.selectAllChildren?.(holder); };
        // Without clipboard access, select the text so the platform copy works.
        if (win.navigator?.clipboard?.writeText) win.navigator.clipboard.writeText(text).catch(selectText);
        else selectText();
      }
    };
    list.addEventListener("input", onInput);
    list.addEventListener("change", onInput);
    section.addEventListener("click", onClick);

    return {
      update,
      observe,
      applyNow,
      setSort,
      get sortOrder() { return sortOrder; },
      tracker,
      drafts,
      get held() { return held; },
      get pending() { return pending; },
      get applied() { return applied; },
      destroy() {
        cancelRelease();
        timers.clearTimeout(clockTimer);
        sortControl?.removeEventListener("change", onSort);
        tracker.destroy();
        sortNotice?.remove();
        list.removeEventListener("input", onInput);
        list.removeEventListener("change", onInput);
        section.removeEventListener("click", onClick);
      },
    };
  }

  return { createCallPatcher, createEngagementTracker, createDraftStore, diffCards, sortCards, fallbackView, DRAFT_PREFIX, SORT_KEY };
})();
