// Live Captain's Call transport (BEARINGS.md). One EventSource per visible tab on the
// host; previews and stream failures fall back to ?since polling. A changed served
// revision keeps the update notice and rebinds this document to the new commit.
window.bearingsLive = (() => {
  function createBearingsLive({
    onModel = () => {}, onObserved = () => {}, onConnection = () => {}, onRevision = () => window.quarterdeckRevision?.showUpdate?.(),
    onStreamLost = () => window.quarterdeckRevision?.recheck?.(),
    url = "/api/bearings", streamUrl = "/api/bearings/stream",
    doc = window.document, win = window, EventSourceImpl = window.EventSource, fetchImpl = (...args) => window.fetch(...args),
    bootRevision = window.FM_BOOT_REVISION, streamAllowed = !(window.FM_PREVIEW_ID && window.FM_PREVIEW_ID !== window.FM_HOST_ID),
    pollMs = 15000, backoffMs = [3000, 10000, 30000], timers = window,
  } = {}) {
    let rev = null;
    let source = null;
    let failures = 0;
    let retryTimer = null, pollTimer = null;
    let started = false;
    let servedRevision = bootRevision;
    let recoveringRevision = false;
    const visible = () => doc.visibilityState !== "hidden";
    const status = (state) => onConnection({ state, failures });

    function acceptModel(model) {
      if (!model || typeof model.rev !== "string") return;
      if (model.unchanged) { onObserved(model); return; }
      rev = model.rev;
      onModel(model);
    }
    async function catchUp() {
      try {
        const response = await fetchImpl(rev ? `${url}?since=${encodeURIComponent(rev)}` : url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Captain's Call unavailable (${response.status})`);
        acceptModel(await response.json());
        return true;
      } catch { status(recoveringRevision ? "revision" : "disconnected"); return false; }
    }
    function closeStream() {
      source?.close();
      source = null;
    }
    function stopTimers() {
      timers.clearTimeout(retryTimer);
      timers.clearTimeout(pollTimer);
      retryTimer = pollTimer = null;
    }
    function poll() {
      timers.clearTimeout(pollTimer);
      pollTimer = timers.setTimeout(async () => {
        pollTimer = null;
        if (!started || !visible() || source) return;
        await catchUp();
        if (started && visible() && !source) poll();
      }, pollMs);
    }
    function scheduleRetry() {
      poll();
      const delay = backoffMs[Math.min(Math.max(failures - 1, 0), backoffMs.length - 1)];
      timers.clearTimeout(retryTimer);
      retryTimer = timers.setTimeout(() => { retryTimer = null; void catchUp().then(() => openStream()); }, delay);
    }
    function goLive() {
      recoveringRevision = false;
      failures = 0;
      timers.clearTimeout(pollTimer);
      pollTimer = null;
      status("live");
    }
    // The server closes a stream when its checkout no longer matches its boot
    // commit. Retry that feed here; do not latch the open document shut.
    function revisionStop() {
      recoveringRevision = true;
      if (source) source.revisionHandled = true;
      closeStream();
      stopTimers();
      failures += 1;
      status("revision");
      onRevision();
      if (started && visible()) scheduleRetry();
    }
    function openStream() {
      if (!started || !visible() || source) return;
      if (!streamAllowed || typeof EventSourceImpl !== "function") { status(recoveringRevision ? "revision" : "polling"); poll(); return; }
      const events = new EventSourceImpl(streamUrl);
      source = events;
      const parse = (event) => { try { return JSON.parse(event.data); } catch { return null; } };
      events.addEventListener("hello", (event) => {
        const hello = parse(event);
        const advertised = hello && typeof hello.servedCommit === "string" ? hello.servedCommit : "";
        if (servedRevision && advertised !== servedRevision) {
          if (!advertised) { revisionStop(); return; }
          servedRevision = advertised;
          onRevision();
          goLive();
          return;
        }
        goLive();
      });
      events.addEventListener("model", (event) => acceptModel(parse(event)));
      events.addEventListener("observed", (event) => { const data = parse(event); if (data) onObserved(data); });
      events.addEventListener("revision", () => revisionStop());
      // The server recycles long-lived streams; reconnect at once and catch up.
      events.addEventListener("bye", () => { closeStream(); void catchUp().then(() => openStream()); });
      events.onerror = () => {
        if (events.revisionHandled || source !== events) return;
        // Take reconnection over from EventSource so backoff and polling stay bounded.
        closeStream();
        failures += 1;
        status(recoveringRevision ? "revision" : "reconnecting");
        onStreamLost();
        scheduleRetry();
      };
    }
    function resume() {
      if (!started || !visible()) return;
      void catchUp().then(() => openStream());
    }
    function suspend() {
      closeStream();
      stopTimers();
      status("paused");
    }
    const onVisibility = () => { if (visible()) resume(); else suspend(); };
    const onPageHide = () => suspend();
    const onPageShow = () => resume();
    return {
      start() {
        if (started) return;
        started = true;
        doc.addEventListener("visibilitychange", onVisibility);
        win.addEventListener("pagehide", onPageHide);
        win.addEventListener("pageshow", onPageShow);
        if (visible()) resume();
        else status("paused");
      },
      stop() {
        started = false;
        suspend();
        doc.removeEventListener("visibilitychange", onVisibility);
        win.removeEventListener("pagehide", onPageHide);
        win.removeEventListener("pageshow", onPageShow);
      },
      refresh: () => catchUp(),
      get rev() { return rev; },
      get connected() { return Boolean(source); },
    };
  }
  return { createBearingsLive };
})();
