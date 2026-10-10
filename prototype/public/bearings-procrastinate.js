// Procrastinate is a Quarterdeck viewing status (BEARINGS.md). It never answers a call.
// This tab keeps return times in sessionStorage so a reload, Update now, and a failed
// read still show Procrastinated until the time passes or the captain chooses Bring back now.
window.bearingsProcrastinate = (() => {
  const DURATIONS = ["3h", "6h", "1d", "3d"];
  const CACHE_KEY = "fm-quarterdeck-call-procrastination.v1";
  function browserSession() {
    try { return window.sessionStorage || null; } catch { return null; }
  }
  function readCache(storage, at) {
    if (!storage) return {};
    try {
      const parsed = JSON.parse(storage.getItem(CACHE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const until = {};
      for (const [key, iso] of Object.entries(parsed)) {
        const stamp = Date.parse(iso);
        if (Number.isFinite(stamp) && stamp > at) until[key] = iso;
      }
      return until;
    } catch { return {}; }
  }
  function writeCache(storage, until) {
    if (!storage) return;
    try {
      if (Object.keys(until || {}).length) storage.setItem(CACHE_KEY, JSON.stringify(until));
      else storage.removeItem(CACHE_KEY);
    } catch {}
  }
  function createController({ list, doc = window.document, fetchImpl = (...args) => window.fetch(...args), onChange = () => {}, now = () => Date.now(), timers = window, storage } = {}) {
    if (storage === undefined) storage = browserSession();
    let untilMap = readCache(storage, now());
    let menuKey = null;
    let timer = null;
    let retry = null;
    let loadFailed = false;
    let destroyed = false;
    const keyOf = (node) => node?.getAttribute?.("data-call-key") || null;
    const parked = (key, at = now()) => {
      const stamp = Date.parse(untilMap[key] || "");
      return Number.isFinite(stamp) && stamp > at;
    };
    const cards = () => [...list.querySelectorAll("[data-call-key]")];
    function render(node) {
      if (!node?.querySelector) return;
      const key = keyOf(node);
      const menu = node.querySelector("[data-call-procrastinate-menu]");
      const toggle = node.querySelector("[data-call-procrastinate-toggle]");
      const back = node.querySelector("[data-call-procrastinate-return]");
      const when = node.querySelector("[data-call-procrastinate-until]");
      const box = node.querySelector("[data-call-procrastinate]");
      const open = Boolean(key && menuKey === key);
      if (menu) menu.hidden = !open;
      if (toggle) toggle.setAttribute("aria-expanded", String(open));
      const active = parked(key);
      if (back) back.hidden = !active;
      if (when) {
        when.hidden = !active;
        const label = active ? `Returns ${new Date(untilMap[key]).toLocaleString()}` : "";
        if (when.textContent !== label) when.textContent = label;
      }
      // The pill stays on every card, including Sent, so Procrastinate is reachable there
      // and from the Procrastinated status. Lifecycle, not this control, chooses the list.
      if (box) box.hidden = false;
    }
    const paint = () => { for (const node of cards()) render(node); onChange(); };
    function schedule() {
      timers.clearTimeout(timer);
      const next = Object.values(untilMap).map((iso) => Date.parse(iso)).filter((stamp) => stamp > now()).sort((a, b) => a - b)[0];
      if (next) timer = timers.setTimeout(() => { paint(); schedule(); }, Math.max(0, next - now()) + 25);
    }
    function retryLoad() {
      loadFailed = true;
      timers.clearTimeout(retry);
      retry = timers.setTimeout(() => { void load(); }, 3000);
    }
    async function load() {
      if (destroyed) return;
      timers.clearTimeout(retry);
      retry = null;
      let response, body;
      try {
        response = await fetchImpl("/api/bearings/procrastinate", { cache: "no-store" });
        body = await response.json();
      } catch {
        if (!destroyed) retryLoad();
        return;
      }
      if (destroyed) return;
      // A missing route or a bad body is not a transient failure. Keep the tab's memory and stop.
      if (response?.status === 503) { retryLoad(); return; }
      if (!response?.ok || !body || typeof body.until !== "object" || Array.isArray(body.until)) {
        loadFailed = false;
        return;
      }
      loadFailed = false;
      untilMap = body.until;
      writeCache(storage, untilMap);
      schedule();
      paint();
    }
    async function send(key, body, card) {
      let response, payload;
      try {
        response = await fetchImpl("/api/bearings/procrastinate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        payload = await response.json().catch(() => null);
      } catch {}
      const error = card?.querySelector?.("[data-call-procrastinate-error]");
      if (response?.ok && payload?.until && typeof payload.until === "object" && !Array.isArray(payload.until)) {
        untilMap = payload.until;
        writeCache(storage, untilMap);
        if (error) { error.hidden = true; error.textContent = ""; }
      } else if (error) {
        error.hidden = false;
        error.textContent = payload?.error || "Procrastination could not be saved";
      }
      schedule();
      paint();
    }
    const onClick = (event) => {
      const target = event.target;
      if (!target?.closest) return;
      const card = target.closest("[data-call-key]");
      const key = keyOf(card);
      if (target.closest("[data-call-procrastinate-toggle]")) {
        menuKey = menuKey === key ? null : key;
        paint();
        return;
      }
      const duration = target.closest("[data-call-procrastinate-for]")?.getAttribute("data-call-procrastinate-for");
      if (duration && key && DURATIONS.includes(duration)) {
        menuKey = null;
        void send(key, { key, duration }, card);
        return;
      }
      if (target.closest("[data-call-procrastinate-return]") && key) { menuKey = null; void send(key, { key, clear: true }, card); }
    };
    const onDocumentClick = (event) => {
      if (!menuKey || event.target?.closest?.("[data-call-procrastinate]")) return;
      menuKey = null;
      paint();
    };
    const onKey = (event) => {
      if (event.key !== "Escape" || !menuKey) return;
      menuKey = null;
      paint();
    };
    const onVisible = () => {
      if (doc.visibilityState === "hidden") return;
      if (loadFailed) void load();
      else { schedule(); paint(); }
    };
    list.addEventListener("click", onClick);
    doc.addEventListener("click", onDocumentClick);
    doc.addEventListener("keydown", onKey);
    doc.addEventListener("visibilitychange", onVisible);
    schedule();
    void load();
    return {
      render, load, parked, durations: DURATIONS,
      until: () => ({ ...untilMap }),
      destroy() {
        destroyed = true;
        timers.clearTimeout(timer);
        timers.clearTimeout(retry);
        list.removeEventListener("click", onClick);
        doc.removeEventListener("click", onDocumentClick);
        doc.removeEventListener("keydown", onKey);
        doc.removeEventListener("visibilitychange", onVisible);
      },
    };
  }
  return { createController, DURATIONS };
})();
