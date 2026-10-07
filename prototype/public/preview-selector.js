// Stable-host UI: only an allowlisted ID crosses the lifecycle write boundary.
(async () => {
  const current = window.FM_PREVIEW_ID || "main";
  const storage = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch {} },
    remove(key) { try { sessionStorage.removeItem(key); } catch {} },
  };
  let deliveries = 0;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, options) => {
    const delivery = options?.method === "POST" && typeof input === "string" && /\/api\/(chat|review)$/.test(input);
    if (delivery) deliveries++;
    try { return await originalFetch(input, options); } finally { if (delivery) deliveries--; }
  };
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Quarterdeck version");
  select.id = "preview-selector";
  const detail = document.createElement("small");
  detail.id = "preview-identity";
  const status = document.createElement("small");
  status.id = "preview-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const box = document.createElement("footer");
  box.className = "preview-control";
  box.setAttribute("aria-label", "Version footer");
  const toggle = document.createElement("button");
  toggle.type = "button"; toggle.id = "preview-toggle";
  toggle.setAttribute("aria-controls", "preview-details");
  toggle.setAttribute("aria-label", "Expand version details");
  const active = document.createElement("span");
  active.id = "preview-active"; active.setAttribute("role", "status");
  const heading = document.createElement("div"); heading.className = "preview-heading";
  heading.append(toggle, active);
  const details = document.createElement("div"); details.id = "preview-details";
  details.className = "preview-details";
  details.setAttribute("role", "region"); details.setAttribute("aria-label", "Version selector and provenance");
  const expanded = storage.get("fm-preview-footer-expanded") === "true";
  function disclose(open) {
    box.dataset.expanded = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} version details`);
    details.hidden = !open;
  }
  disclose(expanded);
  toggle.addEventListener("click", () => {
    const open = box.dataset.expanded !== "true";
    disclose(open);
    storage.set("fm-preview-footer-expanded", String(open));
  });
  const label = document.createElement("label");
  label.textContent = "Version "; label.append(select);
  const actions = document.createElement("div");
  actions.className = "preview-actions";
  const retry = document.createElement("button");
  retry.type = "button"; retry.textContent = "Start / retry";
  const home = document.createElement("button");
  home.type = "button"; home.textContent = "Stable host";
  const previous = document.createElement("button");
  previous.type = "button"; previous.textContent = "Restart previous"; previous.hidden = true;
  actions.append(retry, home, previous);
  details.append(label, detail, status, actions);
  box.append(heading, details);
  const workspace = document.querySelector(".workspace") || document.body;
  const desktopFooter = document.querySelector("#desktop-review-footer");
  const desktop = window.matchMedia?.("(min-width: 721px)");
  const sidebarVersion = document.querySelector("#sidebar-version");
  sidebarVersion?.addEventListener("click", () => toggle.click());
  function placeVersion() {
    const destination = desktop?.matches && desktopFooter ? desktopFooter : workspace;
    if (box.parentElement !== destination) {
      if (destination === desktopFooter) destination.insertBefore(box, destination.firstChild);
      else destination.append(box);
    }
  }
  desktop?.addEventListener?.("change", placeVersion);
  placeVersion();

  let entries = [], intent = null, loading = false, notice = "", failure = null;
  const hostId = () => window.FM_HOST_ID || (entries.some((entry) => entry.id === "main") ? "main" : "uat");
  try { failure = JSON.parse(storage.get("fm-preview-failure")); } catch {}
  if (failure) notice = failure.message;
  const displayName = (entry) => entry.id === "uat" ? "UAT" : entry.id === "stg" ? "Staging" : entry.name;
  const names = { stopped: "Stopped", starting: "Starting", ready: "Ready", failed: "Failed", "revision-mismatch": "Revision mismatch", busy: "Busy", idling: "Idling" };
  function render() {
    const selected = select.value || failure?.id || current;
    for (const entry of entries) {
      let option = [...select.options].find((item) => item.value === entry.id);
      if (!option) { option = document.createElement("option"); option.value = entry.id; select.append(option); }
      const text = `${displayName(entry)} · ${names[entry.state] || entry.state}`;
      if (option.textContent !== text) option.textContent = text;
    }
    select.value = entries.some((e) => e.id === selected) ? selected : current;
    const entry = entries.find((e) => e.id === select.value);
    const served = entries.find((e) => e.id === current);
    const transition = intent ? entries.find((e) => e.id === intent.id) : null;
    home.textContent = hostId() === "main" ? "Warm Main" : "Local UAT";
    const phase = notice && /^(Starting|Busy|Failed|Stopped|Revision mismatch)/.test(notice)
      ? notice.split(" · ")[0] : transition && !["ready", "idling"].includes(transition.state)
        ? names[transition.state] || transition.state : failure ? "Failed" : "";
    active.textContent = served
      ? `${displayName(served)} · ${current === hostId() ? "local" : "remote"} · ${(window.FM_SERVED_COMMIT || served.commit).slice(0, 12)}${phase ? ` · ${phase}${current === hostId() && failure ? ` (${hostId() === "main" ? "Main" : "UAT"} warm)` : ""}` : ""}`
      : `Version unavailable${phase ? ` · ${phase}` : ""}`;
    active.title = served ? `Full revision ${window.FM_SERVED_COMMIT || served.commit}; ${displayName(served)} ${current === hostId() ? "local" : "remote"}.` : "Served revision unavailable.";
    const revision = window.FM_SERVED_COMMIT || served?.commit;
    window.fmSidebarVersion?.render(served && { name: displayName(served), source: current === hostId() ? "local" : "origin", revision,
      publication: served.remoteCheckpoint === revision && served.relation === "equal" ? "published"
        : served.relation === "unknown" ? "publication unverified" : "unpublished", action: "Expand version details" });
    if (!entry) return;
    detail.textContent = `Active local ${entry.commit} · published checkpoint ${entry.remoteCheckpoint || "absent"} · ${entry.relation} · ${entry.validation} · ${entry.health} · ${entry.freshness}`;
    detail.title = `Local checkout HEAD ${entry.commit}; operator-recorded remote checkpoint ${entry.remoteCheckpoint || "absent"}; health sampled ${entry.checkedAt || "not yet"}. Divergence is normal for viewing UAT/Staging, but must be deliberately reconciled before publication or promotion.`;
    status.textContent = notice || `${names[entry.state]} · ${entry.reason}${["uat", "stg"].includes(entry.id) && !["equal", "absent"].includes(entry.relation) ? ". Divergence is normal for viewing; reconcile deliberately before publication/promotion." : ""}`;
    box.dataset.state = entry.state;
    retry.disabled = Boolean(intent);
    retry.textContent = ["failed", "revision-mismatch"].includes(entry.state) ? "Retry start" : "Open version";
    previous.textContent = failure?.previous ? `Restart ${entries.find((e) => e.id === failure.previous)?.name || "previous"}` : "Restart previous";
    previous.hidden = !failure?.previous || !entries.some((e) => e.id === failure.previous);
  }
  async function navigate(id) {
    if (deliveries) { notice = "Busy · wait for this tab’s chat or annotation delivery; drafts are retained"; render(); return; }
    // Hashes never enter the controller request. Same-origin session drafts survive navigation.
    location.assign(`/preview/${id}/${location.hash || "#overview"}`);
  }
  function failed(entry) {
    intent = null;
    failure = { id: entry.id, previous: entry.previous || null, message: `${names[entry.state] || "Failed"} · ${entry.name}. ${entry.reason}` };
    storage.set("fm-preview-failure", JSON.stringify(failure));
    notice = failure.message;
    if (current !== hostId()) navigate(hostId());
    else render();
  }
  async function choose(id) {
    if (deliveries) { notice = "Busy · finish delivery before switching; your draft is retained"; render(); return; }
    if (loading || intent) { notice = `Busy · selection already in progress. ${home.textContent} remains available.`; render(); return; }
    loading = true; notice = "Starting · requesting registered version…"; render();
    try {
      const response = await fetch("/api/previews/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const entry = await response.json();
      if (!response.ok || !entry.accepted) { notice = entry.reason || entry.error || "Selection unavailable; retry"; if (["failed", "revision-mismatch"].includes(entry.state)) failed(entry); return; }
      storage.remove("fm-preview-failure"); failure = null;
      if (["ready", "idling"].includes(entry.state)) return navigate(id);
      intent = { id, operation: entry.operation };
      notice = "";
    } catch { notice = "Failed · gateway unavailable. Drafts retained; retry when connected."; }
    finally { loading = false; await refresh(); }
  }
  async function refresh() {
    try {
      const response = await fetch("/api/previews", { cache: "no-store" });
      if (!response.ok) throw new Error();
      entries = await response.json();
      if (!entries.length) throw new Error();
      select.disabled = false;
      if (intent) {
        const entry = entries.find((e) => e.id === intent.id);
        if (entry?.operation !== intent.operation) { intent = null; notice = "Busy · another selection superseded this request; choose again"; }
        else if (["failed", "revision-mismatch"].includes(entry.state)) failed(entry);
        else if (entry.state === "stopped") { intent = null; notice = `Stopped before navigation; choose again. ${home.textContent} remains warm and drafts are retained.`; }
        else if (["ready", "idling"].includes(entry.state)) {
          // A final ID-only selection re-proves exact health and holds use before navigating.
          const id = intent.id; intent = null; return choose(id);
        }
      }
      render();
    } catch { status.textContent = `Versions unavailable · gateway disconnected; drafts retained. Retry or use ${home.textContent}.`;  active.textContent = `${current} · version unverified · gateway disconnected`; }
  }
  select.addEventListener("change", () => { notice = ""; choose(select.value); });
  retry.addEventListener("click", () => choose(select.value));
  home.addEventListener("click", () => navigate(hostId()));
  previous.addEventListener("click", () => { select.value = failure.previous; choose(failure.previous); });

  if (document.querySelector(".feed-actions")) {
    const drawer = document.createElement("details"); drawer.className = "preview-chat-control";
    const summary = document.createElement("summary"); summary.textContent = "Chat Firstmate"; drawer.append(summary);
    const form = document.createElement("form"); form.className = "preview-chat";
    const input = document.createElement("textarea"); input.setAttribute("aria-label", "Message primary Firstmate");
    input.placeholder = "Message firstmate"; input.maxLength = 4000;
    input.value = storage.get("fm-preview-chat-draft") || "";
    let pendingChat;
    try { pendingChat = JSON.parse(storage.get("fm-preview-chat-pending") || "null"); } catch { pendingChat = null; }
    input.addEventListener("input", () => {
      storage.set("fm-preview-chat-draft", input.value);
      if (pendingChat?.text !== input.value) { pendingChat = null; storage.remove("fm-preview-chat-pending"); }
    });
    const button = document.createElement("button"); button.textContent = "Send to Firstmate";
    const deliveryStatus = document.createElement("small"); deliveryStatus.setAttribute("role", "status");
    form.append(input, button, deliveryStatus);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value;
      if (!text.trim() || button.disabled) return;
      button.disabled = true; deliveryStatus.textContent = "Sending to primary Firstmate…";
      try {
        const served = entries.find((entry) => entry.id === current);
        if (!served || !window.fmChatViewContext) throw new Error("View context unavailable; retry after loading the feed");
        if (!pendingChat || pendingChat.text !== text) {
          pendingChat = { schema: "fm-agentos-chat.v1", messageId: crypto.randomUUID(), route: location.hash || "#overview", text,
            viewContext: window.fmChatViewContext({ branch: served.branch, commit: window.FM_SERVED_COMMIT || served.commit }) };
          storage.set("fm-preview-chat-pending", JSON.stringify(pendingChat));
        }
        const response = await fetch(`/preview/${current}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(pendingChat) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Unconfirmed");
        deliveryStatus.textContent = `Delivered to primary Firstmate · view context attached as advisory only · receipt ${result.receiptId}`;
        pendingChat = null; storage.remove("fm-preview-chat-pending");
        if (input.value === text) { input.value = ""; storage.remove("fm-preview-chat-draft"); }
      } catch (error) { deliveryStatus.textContent = `${error.message}; message and send-time view context retained for retry`; }
      finally { button.disabled = false; }
    });
    drawer.append(form); document.querySelector(".feed-actions").append(drawer);
  }
  await refresh();
  setInterval(() => { if (!loading && (intent || !document.hidden)) refresh(); }, 1000);
})();
