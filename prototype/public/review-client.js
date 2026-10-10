// Native review overlay. Annotation is always available; the toggle swaps click precedence.
const el = (id) => document.getElementById(id);
const capture = window.QuarterdeckReviewTarget;
// Content taps/clicks annotate immediately, including on touch devices with no hover.
// The pen toggles interaction mode; while it is on every click annotates, Alt-click interacts.
let annotateByDefault = false;
let awaitingReview = null;
function showAwaitingReview(count) {
  awaitingReview = Number.isSafeInteger(count) && count >= 0 ? count : null;
  const badge = el("review-awaiting");
  badge.hidden = !awaitingReview;
  badge.textContent = awaitingReview || "";
  updateReviewControl();
}
let selected = null;
let pointerTextRange = null;
const recordTexts = new WeakMap(); // Never persist whole no-ID message bodies in drafts.
let activeReviewTab = "conversation";
// Sent history is a collapsed section; expanding it never replaces the queue or composer.
let sentOpen = false;
let pickingRegion = false;
let returnToArmed = false;
let touchStart = null;
let scrollUntil = 0;
const pickNotice = document.createElement("div");
pickNotice.className = "review-pick-notice";
pickNotice.hidden = true;
pickNotice.setAttribute?.("role", "status");
pickNotice.innerHTML = '<span>Tap a place to attach your message</span><button type="button">Cancel</button>';
const updateNotice = document.createElement("div");
updateNotice.className = "app-update-notice";
updateNotice.hidden = true;
updateNotice.setAttribute("role", "status");
const updateMessage = document.createElement("span");
updateMessage.textContent = "Quarterdeck updated — reload to continue";
const reloadButton = document.createElement("button");
reloadButton.type = "button";
reloadButton.textContent = "Reload";
reloadButton.addEventListener("click", () => location.reload());
updateNotice.append(updateMessage, reloadButton);
// Stack variable-height notices without covering the live location-picker controls.
const noticeStack = document.createElement("div");
noticeStack.className = "app-notice-stack";
noticeStack.append(pickNotice, updateNotice);
document.body.append(noticeStack);
// Phone width keeps Message/Review tabs; desktop shows Sent over Queued with no tabs.
function reviewHistoryTab() { return Boolean(phoneReview?.matches) && activeReviewTab === "review"; }
function setReviewTab(tab) {
  activeReviewTab = tab;
  const annotation = tab === "annotation";
  const phone = Boolean(phoneReview?.matches);
  for (const [id, value] of [["review-conversation-tab", "conversation"], ["review-annotation-tab", "annotation"], ["review-history-tab", "review"]]) {
    const selectedTab = tab === value && !(phone && value === "annotation");
    el(id)?.setAttribute("aria-selected", String(selectedTab));
    el(id)?.setAttribute("tabindex", selectedTab ? "0" : "-1");
  }
  el("review-select-location")?.setAttribute("aria-pressed", String(annotation && phone));
  el("review-panel").setAttribute("data-review-tab", phone ? tab : annotation ? "annotation" : sentOpen ? "review" : "conversation");
  syncReviewScrollLock();
  el("review-phone-thread").hidden = !phone || tab !== "review";
}
function endPicking() {
  pickingRegion = false;
  pickNotice.hidden = true;
  updateSelectionAction();
}
let hovered = null;
let hoveredNode = null;
let config = { ready: false, version: "unknown", sessionId: "", delivery: "local" };
let queue = [];
let queueIds = []; // Tab-local authoring identities; never sent in the review payload.
// Prompt Queue last took from the compose box. Send batch must not add that text again.
let composeQueuedText = "";
let sent = []; // Receipt-confirmed batches in this tab, including across a document reload.
const openBatches = new Set();
const openNotes = new Set();
let pending = false;
let inFlight = null; // Cutoff snapshot, separate from annotations queued during delivery.
let inFlightIndex = null; // Original order among failed/uncertain batches on reload.
let retryBatches = []; // Unconfirmed deliveries keep their own payloads and IDs.
let batchId = null;
// Captain's Call answers queued on their cards (app.js registers the provider). They are
// listed and sent with this queue, but each is still relayed through its own answer route.
const callQueue = () => { try { return window.quarterdeckCallQueue?.list?.() || []; } catch { return []; } };
// One semantic control for both the desktop label and the compact phone icon.
// Only receipt-backed entries without confirmed supervisor intake count; drafts remain local.
function updateReviewControl() {
  const awaiting = awaitingReview === null ? "annotation count unavailable"
    : `${awaitingReview} ${awaitingReview === 1 ? "annotation" : "annotations"} awaiting Firstmate receipt`;
  const queuedHere = queue.length + callQueue().length;
  el("review-panel-toggle").setAttribute("aria-label", `${phoneReview?.matches ? "Chat" : "Review messages"}, ${awaiting}; ${queuedHere} ${queuedHere === 1 ? "note" : "notes"} queued locally`);
  el("review-count").textContent = queuedHere ? `· ${queuedHere} queued` : "";
}
const DRAFT_KEY = "fm-agentos-review-draft-v1";
function saveDraft() {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ queue, queueIds, sent, message: el("review-message").value, open: !el("review-panel").hidden, selected, batchId, retryBatches, inFlight, inFlightIndex }));
  } catch {
    const warning = "Reload persistence unavailable (browser storage is full or disabled). Keep this tab open and send retained notes before closing.";
    if (!el("review-state").textContent.includes(warning)) el("review-state").textContent += ` ${warning}`;
  }
}
function restoreDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY));
    if (!draft || !Array.isArray(draft.queue) || draft.queue.length > 30) return;
    const valid = (entry) => entry && (typeof entry.prompt === "string" && entry.prompt.length <= 4000 && typeof entry.selector === "string" && typeof entry.tag === "string" && typeof entry.text === "string" || ["message", "annotation", "lane-message-annotation"].includes(entry.kind)
      && typeof entry.text === "string" && entry.text.length <= 4000
      && typeof entry.route === "string" && typeof entry.version === "string"
      && (entry.kind === "lane-message-annotation"
        ? entry.region === null && (entry.target?.type === "record" && typeof entry.target.recordId === "string"
          || entry.target?.type === "quote" && typeof entry.target.time === "string" && typeof entry.target.text === "string" && Array.isArray(entry.target.lanes))
        : !Object.hasOwn(entry, "target") && (entry.kind === "message" ? entry.region === null : entry.region && typeof entry.region.id === "string" && typeof entry.region.label === "string")));

    if (!draft.queue.every(valid)) return;
    // Older drafts had no item IDs. Dedupe only repeated IDs, never equal text.
    const ids = Array.isArray(draft.queueIds) && draft.queueIds.length === draft.queue.length
      ? draft.queueIds.map((id) => typeof id === "string" && id ? id : crypto.randomUUID())
      : draft.queue.map(() => crypto.randomUUID());
    const seen = new Set();
    queue = draft.queue.filter((_, index) => {
      const id = ids[index];
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (capture) queue = queue.map(capture.migrateEntry);
    queueIds = ids.filter((id, index) => ids.indexOf(id) === index);
    if (Array.isArray(draft.sent)) sent = draft.sent.filter((batch) =>
      batch && typeof batch.id === "string" && typeof batch.receiptId === "string" &&
      Array.isArray(batch.entries) && batch.entries.length <= 30 && batch.entries.every(valid) &&
      [undefined, null, "accepted", "received", "handling", "completed", "failed", "replied", "unavailable"].includes(batch.state));
    if (typeof draft.message === "string") el("review-message").value = draft.message.slice(0, 4000);
    if (draft.selected && draft.selected.route === route() && typeof draft.selected.label === "string"
      && typeof draft.selected.version === "string"
      && (typeof draft.selected.selector === "string" || typeof draft.selected.id === "string" || draft.selected.target?.type === "record" || draft.selected.target?.type === "quote")) selected = draft.selected;
    batchId = typeof draft.batchId === "string" ? draft.batchId : null;
    const validBatch = (captured) => captured && typeof captured.id === "string" && /^[0-9a-f-]{36}$/i.test(captured.id)
      && captured.payload?.batchId === captured.id && ["fm-agentos-review.v1", "fm-agentos-review.v2"].includes(captured.payload.schema)
      && typeof captured.payload.version === "string" && typeof captured.payload.route === "string"
      && typeof captured.payload.sessionId === "string" && typeof captured.payload.end === "boolean"
      && Array.isArray(captured.payload.entries) && captured.payload.entries.length > 0 && captured.payload.entries.length <= 30
      && captured.payload.entries.every(valid);
    retryBatches = Array.isArray(draft.retryBatches) ? draft.retryBatches.filter(validBatch) : [];
    if (validBatch(draft.inFlight)) retryBatches.splice(
      Number.isSafeInteger(draft.inFlightIndex) && draft.inFlightIndex >= 0 ? Math.min(draft.inFlightIndex, retryBatches.length) : retryBatches.length,
      0, draft.inFlight);
    retryBatches = retryBatches.filter((batch, index, all) => all.findIndex((item) => item.id === batch.id) === index);
    if (draft.open === true) panel(true);
  } catch { /* Ignore unavailable or corrupt storage. */ }
}
const route = () => location.hash || "#overview";
const controls = "button, input, textarea, select, a, label, summary";
const label = (node) => (node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("placeholder") || (node.matches(controls) || !node.children.length ? node.textContent : node.querySelector?.("h1, h2, h3, strong")?.textContent) || node.id || node.tagName || "Region").replace(/\s+/g, " ").trim().slice(0, 160);

function targetFor(node) {
  const surface = node?.closest?.(".product-view, .lane-list, .context-rail");
  if (!surface) return null;
  const target = node.closest(controls);
  const actual = target && surface.contains(target) ? target : node;
  // Empty background in a broad region is not an annotation target.
  return actual === surface ? null : actual;
}

function regionFor(node) {
  const range = pointerTextRange || capture?.textRangeTarget(window.getSelection?.());
  const actual = range?.element || targetFor(node);
  if (!actual) return null;
  const accessibleName = (actual.getAttribute("aria-label") || actual.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const precise = capture ? { selector: capture.cssSelector(actual), tag: actual.tagName.toLowerCase(), text: capture.excerpt(actual), ...(accessibleName ? { wireLabel: accessibleName } : {}) } : null;
  if (precise) {
    const table = capture.tableCellTarget(actual);
    if (table) precise.target = table;
    if (range) { Object.assign(precise, range); delete precise.element; }
  }
  const message = actual.closest(".message[data-lane-message-index]");
  if (message) {
    const index = Number(message.dataset.laneMessageIndex);
    const target = window.quarterdeckMessageTargets?.[index];
    if (!Number.isSafeInteger(index) || !target) return null;
    if (!precise) return { target, label: "Fleet Chat message", route: route(), version: config.version };
    const record = target.recordId ? { recordId: target.recordId } : { source: target.source, at: target.occurredAt, lanes: target.lanes };
    const result = { ...precise, record, label: label(actual), route: route(), version: config.version };
    if (!record.recordId) recordTexts.set(result, target.text);
    return result;
  }
  const surface = actual.closest(".product-view, .lane-list, .context-rail");
  const anchor = actual.closest("[data-review-id], [id]") || surface;
  const anchorId = anchor.dataset.reviewId || anchor.id;
  if (!anchorId) return null;
  // The address and label refer to the same clicked control/element, not the anchor's text.
  const path = [];
  for (let child = actual; child && child !== anchor; child = child.parentElement) {
    const parent = child.parentElement;
    if (!parent) break;
    path.unshift(`${child.tagName.toLowerCase()}:${Array.from(parent.children).indexOf(child)}`);
  }
  return { id: `${anchorId}${path.length ? `/${path.join("/")}` : ""}`.slice(0, 300), ...precise, label: label(actual), route: route(), version: config.version };
}

const highlight = document.createElement("div");
highlight.className = "review-highlight";
highlight.hidden = true;
document.body.append(highlight);
let selectedNode = null;
function positionHighlight() {
  highlight.hidden = !selectedNode || el("review-panel").hidden || !selectedNode.isConnected;
  if (highlight.hidden) return;
  const rect = selectedNode.getBoundingClientRect();
  Object.assign(highlight.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}
window.addEventListener("resize", positionHighlight);
document.addEventListener("scroll", positionHighlight, true);
const phoneReview = window.matchMedia?.("(max-width: 720px)");
let bodyOverflowBeforeReview = null;
function syncReviewViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  if (!root?.style?.setProperty) return;
  const height = viewport?.height || window.innerHeight;
  root.style.setProperty("--review-vv-height", `${height}px`);
  root.style.setProperty("--review-vv-top", `${Math.max(0, viewport?.offsetTop || 0)}px`);
  // When the keyboard is visible the fixed phone navigation is below the visual viewport.
  root.style.setProperty("--review-nav-space", window.innerHeight - height - (viewport?.offsetTop || 0) > 120 ? "0px" : "calc(72px + env(safe-area-inset-bottom, 0px))");
}
function syncReviewScrollLock() {
  const lock = Boolean(phoneReview?.matches && !el("review-panel").hidden && activeReviewTab === "review");
  if (lock && bodyOverflowBeforeReview === null) {
    bodyOverflowBeforeReview = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  } else if (!lock && bodyOverflowBeforeReview !== null) {
    document.body.style.overflow = bodyOverflowBeforeReview;
    bodyOverflowBeforeReview = null;
  }
}
phoneReview?.addEventListener?.("change", () => { syncReviewScrollLock(); updateReviewControl(); });
window.visualViewport?.addEventListener?.("resize", syncReviewViewport);
window.visualViewport?.addEventListener?.("scroll", syncReviewViewport);
window.addEventListener("resize", syncReviewViewport);
syncReviewViewport();

function panel(open) {
  if (open) closeAnnotation();
  el("review-panel").hidden = !open;
  if (!open) {
    selectedNode = null;
    el("review-form").classList?.remove("review-form-anchored");
    if (el("review-form").style) el("review-form").style.left = el("review-form").style.top = "";
    selectedNode = null;
  }
  syncReviewViewport();
  syncReviewScrollLock();
  el("review-panel-toggle").setAttribute("aria-expanded", String(open));
  // Click's default focus may return to the opener after its handler; focus after it completes.
  if (open && !(phoneReview?.matches && activeReviewTab === "annotation")) setTimeout(() => { if (!el("review-panel").hidden) el("review-message").focus(); }, 0);
  positionHighlight();
  saveDraft();
}
const statusLabels = {
  accepted: "Accepted durably · Firstmate intake not yet confirmed",
  received: "Received by Firstmate · awaiting outcome",
  handling: "Actively being handled",
  completed: "Completed (explicit supervisor outcome)",
  failed: "Failed (explicit supervisor outcome) · contact the operator or requeue as a new batch",
  replied: "Firstmate replied · see the recorded reply below",
  unavailable: "Status unavailable · receipt retained; retry status check",
};
const statusShort = {
  accepted: "Accepted",
  received: "Received",
  handling: "Handling",
  completed: "Completed",
  failed: "Failed",
  replied: "Replied",
  unavailable: "Status unavailable",
};
const noteCount = (count) => `${count} ${count === 1 ? "note" : "notes"}`;
// Pending and announced in the inbox is the pending receipt posture. The collapsed
// header and the expanded header both use that posture's sent label.
function pendingReceiptLabel() {
  const owned = window.callLifecycle?.sentLabel?.("pending");
  return typeof owned === "string" && owned ? owned : "Sent - waiting for Firstmate to read";
}
function batchStatusFull(batch) {
  if (config.delivery === "lavish") return "Delivery confirmed; downstream status unavailable";
  if (batch.state === "accepted" && batch.intake === "accepted" && batch.announced) return pendingReceiptLabel();
  return statusLabels[batch.state] || statusLabels.accepted;
}
function batchStatusShort(batch) {
  if (config.delivery === "lavish") return "Sent";
  if (batch.state === "accepted" && batch.intake === "accepted" && batch.announced) return pendingReceiptLabel();
  return statusShort[batch.state] || "Accepted";
}
// A real batch id is shortened for the closed header. The call-answer group and an
// unsaved draft are not batch ids, so they do not invent one.
function batchIdShort(id) {
  if (typeof id !== "string") return "";
  const trimmed = id.trim();
  if (!trimmed || trimmed === "call-answers" || trimmed === "draft") return "";
  return trimmed.slice(0, 7);
}
function batchWhen(sentAt, now = Date.now()) {
  const date = new Date(sentAt);
  const stamp = date.getTime();
  if (!Number.isFinite(stamp)) return null;
  const delta = now - stamp;
  const abs = Math.abs(delta);
  let relative = "just now";
  if (abs >= 60000) {
    const unitMs = abs < 3600000 ? 60000 : abs < 86400000 ? 3600000 : 86400000;
    const unit = unitMs === 60000 ? "minute" : unitMs === 3600000 ? "hour" : "day";
    const count = Math.max(1, Math.round(abs / unitMs));
    const phrase = `${count} ${unit}${count === 1 ? "" : "s"}`;
    relative = delta >= 0 ? `${phrase} ago` : `in ${phrase}`;
  }
  return { iso: date.toISOString(), short: date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), relative };
}
function copyBatchId(node, text) {
  const mark = () => node.setAttribute("data-copied", "true");
  const select = () => {
    const selection = document.getSelection?.();
    if (!selection || !document.createRange) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const write = typeof navigator !== "undefined" && navigator.clipboard?.writeText;
  if (typeof write !== "function") { select(); return; }
  try { Promise.resolve(write.call(navigator.clipboard, text)).then(mark).catch(select); }
  catch { select(); }
}
// The message plus the batch sentence, real id, and sent time. Call-answer groups
// and unsaved drafts are not batch ids.
function reviewMessageCopyText(text, batch = {}) {
  const lines = [typeof text === "string" ? text : ""];
  const details = [];
  if (batch.full) details.push(batch.full);
  const id = typeof batch.id === "string" ? batch.id.trim() : "";
  if (id && id !== "call-answers" && id !== "draft") details.push(id);
  const when = batchWhen(batch.sentAt);
  if (when) details.push(`${when.iso} · ${when.relative}`);
  if (details.length) lines.push("", ...details);
  return lines.join("\n");
}
function copyReviewMessage(button, text) {
  const mark = () => { button.textContent = "Copied"; button.setAttribute("data-copied", "true"); };
  const select = () => {
    const body = button.closest?.("article")?.querySelector?.(".review-note-text");
    const selection = document.getSelection?.();
    if (!body || !selection || !document.createRange) return;
    const range = document.createRange();
    range.selectNodeContents(body);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const write = typeof navigator !== "undefined" && navigator.clipboard?.writeText;
  if (typeof write !== "function") { select(); return; }
  try { Promise.resolve(write.call(navigator.clipboard, text)).then(mark).catch(select); }
  catch { select(); }
}
function appendMessageCopy(card, text, batch) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-note-copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy message and batch details");
  button.addEventListener("click", (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    copyReviewMessage(button, reviewMessageCopyText(text, batch));
  });
  card.append(button);
}
// The closed summary shows one short line: chevron, title, then sent time and a
// short batch id when this batch has them. The full sentence stays on the tooltip
// and in the first span, which opens into view with the batch.
function fillBatchSummary(summary, short, full, meta = {}) {
  summary.className = "review-batch-summary";
  summary.title = full;
  summary.textContent = "";
  const fullText = document.createElement("span");
  fullText.className = "review-batch-full";
  fullText.textContent = full;
  const label = document.createElement("span");
  label.className = "review-batch-label";
  label.textContent = short;
  label.setAttribute("aria-hidden", "true");
  summary.append(fullText, label);
  const id = batchIdShort(meta.id);
  const when = batchWhen(meta.sentAt);
  if (!id && !when) return;
  const row = document.createElement("span");
  row.className = "review-batch-meta";
  row.addEventListener("click", (event) => event.stopPropagation?.());
  if (when) {
    const time = document.createElement("time");
    time.setAttribute("datetime", when.iso);
    time.title = when.relative;
    time.textContent = when.short;
    row.append(time);
  }
  if (id) {
    const code = document.createElement("button");
    code.type = "button";
    code.className = "review-batch-id";
    code.textContent = id;
    code.title = meta.id;
    code.setAttribute("aria-label", `Copy batch id ${meta.id}`);
    code.addEventListener("click", (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      copyBatchId(code, meta.id);
    });
    row.append(code);
  }
  summary.append(row);
}
async function refreshStatuses() {
  if (config.delivery !== "local") return;
  for (const batch of sent.filter((item) => !["completed", "failed", "replied"].includes(item.state))) {
    try {
      const response = await fetch(`/api/review/status?batchId=${encodeURIComponent(batch.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Status read failed");
      const status = await response.json();
      if (status.receiptId !== batch.receiptId || !statusLabels[status.state]) throw new Error("Status mismatch");
      batch.state = status.state;
      batch.intake = status.intake;
      batch.announced = status.announced;
      batch.updatedAt = status.updatedAt;
      batch.reply = status.reply;
    } catch { batch.state = "unavailable"; }
    if (batch.end && ["accepted", "received", "handling", "completed", "replied"].includes(batch.state)) {
      sent = sent.filter((item) => item.id !== batch.id);
      openBatches.clear(); openNotes.clear();
    }
    if (!el("review-panel").hidden) el("review-state").textContent = `${batchStatusFull(batch)} · receipt ${batch.receiptId}`;
  }
  update();
}
function update() {
  el("review-toggle").checked = annotateByDefault;
  document.querySelector(".gesture-description").textContent = annotateByDefault ? "Alt-click to interact (click annotates)" : "Alt-click to annotate (click interacts)";
  const gestureCurrent = el("review-gesture-current");
  if (gestureCurrent) gestureCurrent.textContent = `The toggle is ${annotateByDefault ? "on" : "off"}.`;
  updateReviewControl();
  const acceptedCount = sent.reduce((count, batch) => count + batch.entries.length, 0);
  const calls = callQueue();
  const queuedCount = calls.length + queue.length + retryBatches.reduce((count, batch) => count + batch.payload.entries.length, 0) + (inFlight?.payload.entries.length || 0);
  const compactSummary = [queuedCount && `${queuedCount} queued`, acceptedCount && `${acceptedCount} sent`].filter(Boolean).join(" · ");
  el("review-inline-summary").textContent = compactSummary;

  el("review-toggle").setAttribute("aria-label", annotateByDefault
    ? "Annotation mode on: tap or click content to annotate; every click is captured. Alt-click to interact."
    : "Annotation mode off: tap or click to interact; Alt-click to annotate on desktop.");
  el("review-target").textContent = selected ? `Annotating ${selected.label} · ${selected.route}` : "";
  el("review-target").hidden = !selected && Boolean(phoneReview?.matches);
  updateSelectionAction();
  const queueLabel = selected ? "Queue annotation" : "Queue message";
  el("review-queue").textContent = "Queue";
  el("review-queue").setAttribute("aria-label", `${queueLabel} (Enter)`);
  el("review-context").textContent = `Version ${config.version.slice(0, 12)} · ${config.delivery === "lavish" ? `Lavish session ${config.sessionId}` : config.intakeReady ? "Firstmate inbox intake" : "Local receipt · Firstmate intake unavailable"}`;
  const sendable = calls.length || queue.length || retryBatches.length || (!reviewHistoryTab() && el("review-message").value.trim());
  // Queued call answers use their own route, so review delivery being down does not block them.
  el("review-send").disabled = !sendable || pending || (!config.ready && !calls.some((entry) => entry.phase !== "sending"));
  el("review-end").disabled = pending || !config.ready || !sendable;
  el("review-queue").disabled = false;
  el("review-pick").hidden = !hovered || Boolean(desktopComposer?.matches);
  const thread = el("review-thread");
  const sentList = el("review-sent-list");
  const phoneThread = el("review-phone-thread");
  thread.replaceChildren();
  sentList.replaceChildren();
  phoneThread.replaceChildren();
  el("review-sent-count").textContent = String(sent.length);
  el("review-sent-summary").setAttribute("aria-label", `Sent batches, ${sent.length}`);
  el("review-queued-count").textContent = String(queuedCount);
  saveDraft();
  function renderNote(entry, key, removeIndex = null, batch = null) {
    if (entry.prompt !== undefined) entry = { ...entry, text: entry.prompt, kind: entry.tag === "message" ? "message" : "annotation", target: null, region: entry.label ? { label: entry.label } : null, version: entry.version || config.version, route: entry.route || route() };
    const card = document.createElement("article");
    const header = document.createElement("div");
    header.className = "review-note-header";
    const heading = document.createElement("strong");
    heading.textContent = `${entry.delivered ? "Sent" : "Queued"} ${entry.kind === "lane-message-annotation" ? "message annotation" : entry.kind}${entry.target ? ` · ${entry.target.type === "record" ? entry.target.recordId : `quoted ${entry.target.time} · ${entry.target.lanes.join(", ")}`}` : entry.region ? ` · ${entry.region.label}` : ""}`;
    const context = document.createElement("small");
    context.textContent = `${entry.route} · ${entry.version.slice(0, 12)}`;
    header.append(heading);

    const isLong = typeof entry.text === "string" && (entry.text.length > 100 || entry.text.includes("\n"));
    if (isLong) {
      const details = document.createElement("details");
      details.className = "review-note-details";
      details.open = openNotes.has(key);
      const summary = document.createElement("summary");
      summary.className = "review-note-summary";
      const preview = document.createElement("span");
      preview.className = "review-note-preview";
      const firstLine = entry.text.split("\n")[0];
      preview.textContent = firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine + (entry.text.includes("\n") ? "…" : "");
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "review-note-toggle";
      toggle.textContent = details.open ? "Collapse" : "Expand";
      toggle.setAttribute("aria-expanded", String(details.open));
      header.append(toggle);
      summary.append(preview);
      const fullText = document.createElement("p");
      fullText.className = "review-note-text review-note-full";
      fullText.textContent = entry.text;
      details.append(summary, fullText);
      details.addEventListener("toggle", () => {
        toggle.textContent = details.open ? "Collapse" : "Expand";
        toggle.setAttribute("aria-expanded", String(details.open));
        if (details.open) openNotes.add(key); else openNotes.delete(key);
      });
      heading.className = "review-card-heading review-card-heading-collapsible";
      toggle.addEventListener("click", () => {
        details.open = !details.open;
        toggle.textContent = details.open ? "Collapse" : "Expand";
        toggle.setAttribute("aria-expanded", String(details.open));
        if (details.open) openNotes.add(key); else openNotes.delete(key);
      });
      card.append(header, details, context);
    } else {
      const text = document.createElement("p");
      text.className = "review-note-text";
      text.textContent = entry.text;
      card.append(header, text, context);
    }

    if (removeIndex !== null) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove queued ${entry.kind}`);
      remove.addEventListener("click", () => { queue.splice(removeIndex, 1); queueIds.splice(removeIndex, 1); if (!queue.length) batchId = null; openNotes.clear(); update(); });
      header.append(remove);
    }
    appendMessageCopy(card, entry.text, batch);
    return card;
  }
  function renderSentBatch(batch) {
    const details = document.createElement("details");
    details.className = "review-batch";
    details.open = openBatches.has(batch.id);
    const summary = document.createElement("summary");
    // A delivery receipt proves sent, not that another device or a reviewer received it.
    const sentFull = `${batchStatusFull(batch)} · ${noteCount(batch.entries.length)} · receipt ${batch.receiptId}`;
    fillBatchSummary(summary, `${batchStatusShort(batch)} · ${noteCount(batch.entries.length)}`, sentFull, { id: batch.id, sentAt: batch.sentAt });
    details.append(summary);
    for (const [index, entry] of batch.entries.entries()) details.append(renderNote({ ...entry, delivered: true }, `${batch.id}:${index}`, null, { full: sentFull, id: batch.id, sentAt: batch.sentAt }));
    if (batch.reply) {
      const reply = document.createElement("p");
      reply.textContent = batch.reply;
      details.append(reply);
    }
    if (batch.state === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Requeue as new batch";
      retry.disabled = pending || queue.length + batch.entries.length > 30;
      retry.addEventListener("click", () => {
        queue.push(...batch.entries.map((entry) => ({ ...(capture ? capture.migrateEntry(entry) : entry), route: entry.route || batch.route || route(), version: config.version })));
        queueIds.push(...batch.entries.map(() => crypto.randomUUID()));
        batchId = crypto.randomUUID();
        el("review-state").textContent = "Failed notes requeued with a new ID. Check targets and press Send; original receipt remains failed.";
        update();
      });
      details.append(retry);
    }
    details.addEventListener("toggle", () => { if (details.open) openBatches.add(batch.id); else openBatches.delete(batch.id); });
    return details;
  }
  function renderQueuedBatch() {
    const details = document.createElement("details");
    details.className = "review-batch";
    details.open = openBatches.has(batchId || "draft");
    const summary = document.createElement("summary");
    fillBatchSummary(summary, `Queued · ${noteCount(queue.length)}`, `Queued batch · ${noteCount(queue.length)}`, { id: batchId });
    details.append(summary);
    for (const [index, entry] of queue.entries()) details.append(renderNote(entry, `queued:${index}`, index, { full: `Queued batch · ${noteCount(queue.length)}`, id: batchId }));
    details.addEventListener("toggle", () => {
      const key = batchId || "draft";
      if (details.open) openBatches.add(key); else openBatches.delete(key);
    });
    return details;
  }
  function renderCaptured(captured, title) {
    const details = document.createElement("details");
    details.className = "review-batch";
    details.open = openBatches.has(captured.id);
    const summary = document.createElement("summary");
    const capturedCount = noteCount(captured.payload.entries.length);
    fillBatchSummary(summary, `${title === "Retry needed" ? "Retry" : title} · ${capturedCount}`, `${title} batch · ${capturedCount}`, { id: captured.id });
    details.append(summary);
    captured.payload.entries.forEach((entry, index) => details.append(renderNote(entry, `${captured.id}:${index}`, null, { full: `${title} batch · ${capturedCount}`, id: captured.id })));
    if (title === "Retry needed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry batch";
      retry.disabled = pending || !config.ready;
      retry.addEventListener("click", () => { void submitBatch(captured); });
      details.append(retry);
      if (captured.rejected && captured.payload.version !== config.version) {
        const rebind = document.createElement("button");
        rebind.type = "button";
        rebind.textContent = "Targets rechecked · use current version";
        rebind.disabled = pending || !config.ready;
        rebind.addEventListener("click", async () => {
          // Reconcile again at the moment of conversion. A response lost in
          // another tab or a delayed publication must not become a new send.
          if (await submitBatch(captured) || !captured.rejected || captured.payload.version === config.version) return;
          const id = crypto.randomUUID();
          captured.id = id;
          captured.payload = { ...captured.payload, batchId: id, version: config.version, sessionId: config.sessionId,
            entries: captured.payload.entries.map((entry) => captured.payload.schema === "fm-agentos-review.v2" ? { ...entry } : { ...entry, version: config.version }) };
          delete captured.rejected;
          el("review-state").textContent = "Targets rechecked. New version-bound batch retained; press Retry batch to send.";
          update();
        });
        details.append(rebind);
      }
    }
    details.addEventListener("toggle", () => { if (details.open) openBatches.add(captured.id); else openBatches.delete(captured.id); });
    return details;
  }
  function renderCallAnswer(entry) {
    const card = document.createElement("article");
    card.className = "review-call-answer";
    const header = document.createElement("div");
    header.className = "review-note-header";
    const heading = document.createElement("strong");
    heading.textContent = `${entry.phase === "sending" ? "Sending" : entry.phase === "failed" ? "Retry needed" : "Queued"} Captain's Call answer · ${entry.label}`;
    header.append(heading);
    const text = document.createElement("p");
    text.className = "review-note-text";
    text.textContent = entry.text;
    if (entry.phase !== "sending") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove queued answer for ${entry.label}; it returns to its card for editing`);
      remove.addEventListener("click", () => { window.quarterdeckCallQueue?.remove?.(entry.key); update(); });
      header.append(remove);
    }
    card.append(header, text);
    appendMessageCopy(card, entry.text, { full: `Queued Captain's Call answers · ${calls.length}`, id: "call-answers" });
    return card;
  }
  function renderCallBatch() {
    const details = document.createElement("details");
    details.className = "review-batch";
    details.open = openBatches.has("call-answers");
    const summary = document.createElement("summary");
    fillBatchSummary(summary, `Call answers · ${calls.length}`, `Queued Captain's Call answers · ${calls.length}`, { id: "call-answers" });
    details.append(summary, ...calls.map(renderCallAnswer));
    details.addEventListener("toggle", () => { if (details.open) openBatches.add("call-answers"); else openBatches.delete("call-answers"); });
    return details;
  }
  const capturedBatches = [[inFlight, "Sending"], ...retryBatches.map((batch) => [batch, "Retry needed"])].filter(([captured]) => captured);
  // Desktop: Sent list over an always-listed queue (count lives in the section heading).
  for (const batch of sent) sentList.append(renderSentBatch(batch));
  for (const entry of calls) thread.append(renderCallAnswer(entry));
  for (const [index, entry] of queue.entries()) thread.append(renderNote(entry, `queued:${index}`, index, { full: `Queued batch · ${noteCount(queue.length)}`, id: batchId }));
  for (const [captured, title] of capturedBatches) thread.append(renderCaptured(captured, title));
  // Phone: the Review tab lists sent batches, the queued batch, then in-flight/retry batches.
  for (const batch of sent) phoneThread.append(renderSentBatch(batch));
  if (calls.length) phoneThread.append(renderCallBatch());
  if (queue.length) phoneThread.append(renderQueuedBatch());
  for (const [captured, title] of capturedBatches) phoneThread.append(renderCaptured(captured, title));
}
function selectRegion(node, point) {
  const next = regionFor(node);
  if (!next) return;
  returnToArmed = pickingRegion;
  selected = next;
  pointerTextRange = null;
  if (next.record && !next.record.recordId) capture.recordFingerprint(recordTexts.get(next)).then((sha256) => { next.record.sha256 = sha256; saveDraft(); }).catch(() => { el("review-state").textContent = "Message identity unavailable; reselect the target before sending."; });
  hovered = null;
  hoveredNode = null;
  endPicking();
  if (phoneReview?.matches) {
    document.activeElement?.blur?.();
    setReviewTab("annotation");
    panel(true);
    selectedNode = targetFor(node);
    resizeMessage();
    update();
    el("review-state").textContent = "Location attached. Edit your message or queue it.";
    return;
  }
  panel(false);
  selectedNode = targetFor(node);
  const dialog = el("review-annotation");
  const composer = el("review-form");
  dialog.append(composer);
  dialog.hidden = false;
  const rect = selectedNode.getBoundingClientRect();
  const x = point?.x ?? rect.left + rect.width / 2;
  const y = point?.y ?? rect.top + rect.height / 2;
  composer.classList?.add("review-form-anchored");
  resizeMessage();
  update();
  if (desktopComposer?.matches) {
    if (window.paneBounds?.controller) window.paneBounds.controller.place(dialog, { left: x, top: y + 12 });
    else {
      dialog.style.left = `${Math.max(8, Math.min(x, innerWidth - dialog.offsetWidth - 8))}px`;
      dialog.style.top = `${Math.max(8, Math.min(y + 12, innerHeight - dialog.offsetHeight - 8))}px`;
    }
  }
  positionHighlight();
  setTimeout(() => { if (!dialog.hidden) el("review-message").focus(); }, 0);
  el("review-state").textContent = `Selected ${selected.label}. Describe it, then queue annotation.`;
}

function useCurrentVersion(next) {
  if (!next?.ready || typeof next.version !== "string") return false;
  config = next;
  if (!queue.some((entry) => entry.version !== next.version) && (!selected || selected.version === next.version)
    && retryBatches.every((batch) => batch.payload.version === next.version)) return false;
  // A changed payload cannot reuse an earlier batch ID. Keep the notes for
  // deliberate review before another send; never auto-retry a rejected batch.
  queue = queue.map((entry) => ({ ...entry, version: next.version }));
  if (selected) selected = { ...selected, version: next.version };
  batchId = null;
  // Captured batches may already be durable after a lost response. Preserve
  // their entire original payload until the server reconciles the receipt.
  el("review-state").textContent = "Preview updated. Check unsent annotation targets. Unconfirmed deliveries retain their original IDs; retry to reconcile receipts.";
  return true;
}
const UNAVAILABLE = "Review delivery unavailable (Quarterdeck server down or restarting). Send resumes automatically when it is back; notes remain queued.";
async function loadConfig() {
  try {
    const response = await fetch("/api/review", { cache: "no-store" });
    if (!response.ok) throw new Error("Review configuration unavailable");
    const next = await response.json();
    useCurrentVersion(next);
    updateNotice.hidden = !(next.ready && typeof next.version === "string"
      && window.FM_BOOT_REVISION && next.version !== window.FM_BOOT_REVISION);
    showAwaitingReview(next.awaitingReview);
  } catch { config = { ready: false, version: "unknown", sessionId: "", delivery: "local" }; showAwaitingReview(null); }
  if (!config.ready) el("review-state").textContent = UNAVAILABLE;
  else if (el("review-state").textContent === UNAVAILABLE) el("review-state").textContent = "Review delivery reconnected.";
  update();
  // Status reads would fail too; keep the unavailable reason visible instead.
  if (config.ready) void refreshStatuses();
}
// Recovery re-reads run one at a time while a composer can send: the review
// panel, or the desktop inline composer while that panel is hidden. Tab return
// re-reads too.
let recheck = null;
function recheckConfig() { recheck ||= loadConfig().finally(() => { recheck = null; }); }
function reviewComposerOpen() {
  const panel = el("review-panel");
  const inline = el("review-annotation");
  return Boolean(panel && !panel.hidden) || Boolean(inline && !inline.hidden);
}
// Live Captain's Call reuses this one update notice; it never reloads on its own.
window.quarterdeckRevision = { recheck: recheckConfig, showUpdate: () => { updateNotice.hidden = false; } };
if (typeof setInterval === "function") setInterval(() => {
  if (!config.ready && reviewComposerOpen()) recheckConfig();
  else if (config.ready && sent.some((batch) => !["completed", "failed", "replied"].includes(batch.state))) void refreshStatuses();
}, 5000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "hidden") recheckConfig(); });
// Keep one composer and its draft across layout switches. Phones retain the in-pane row.
const desktopComposer = window.matchMedia?.("(min-width: 721px)");
function resizeMessage() {
  const message = el("review-message");
  message.style.height = "0px";
  message.style.height = `${Math.min(message.scrollHeight, Math.max(80, window.innerHeight * .3))}px`;
}
function closeAnnotation() {
  const dialog = el("review-annotation");
  if (dialog.hidden) return;
  dialog.hidden = true;
  dialog.style.left = dialog.style.top = "";
  placeComposer();
}
function placeComposer() {
  const form = el("review-form");
  const footer = el("desktop-review-footer");
  const banner = document.querySelector(".uat-deployment-label");
  // Standalone UAT's compact phone identity stays in the workspace; desktop
  // version identity belongs solely to the dark sidebar, not the composer footer.
  if (banner && banner.parentElement !== el("lanes")) el("lanes").append(banner);
  const destination = desktopComposer?.matches ? footer : el("review-panel");
  if (!destination?.insertBefore || (form.parentElement === destination && el("review-annotation").hidden)) return;
  if (desktopComposer?.matches) {
    // Restore the shared trigger before placing the composer during a phone-to-desktop resize.
    if (el("review-panel-toggle").parentElement !== destination) destination.append(el("review-panel-toggle"));
    destination.insertBefore(form, el("review-panel-toggle"));
  }
  else destination.insertBefore(form, el("review-state"));
  form.classList.remove("review-form-anchored");
  form.style.left = form.style.top = "";
  resizeMessage();
}
function placeSelectionAction() {
  const action = el("review-select-location");
  const destination = phoneReview?.matches ? document.querySelector(".review-header-actions") : document.querySelector(".review-section-head");
  if (action && destination?.insertBefore && action.parentElement !== destination) {
    if (phoneReview?.matches) destination.insertBefore(action, destination.firstChild); else destination.append(action);
  }
  setReviewTab(activeReviewTab);
  updateSelectionAction();
}
desktopComposer?.addEventListener?.("change", () => { closeAnnotation(); placeComposer(); placeSelectionAction(); });
placeComposer();
placeSelectionAction();
el("review-toggle").addEventListener("change", (event) => {
  annotateByDefault = event.target.checked;
  update();
});
restoreDraft();
setReviewTab(selected ? "annotation" : "conversation");
loadConfig();
el("review-panel-toggle").addEventListener("click", () => { if (!el("review-panel").hidden) closeReview(); else { endPicking(); panel(true); } void loadConfig(); });
function closeReview() {
  endPicking();
  selected = null; selectedNode = null; returnToArmed = false;
  closeAnnotation();
  update();
  panel(false);
  el("review-panel-toggle").focus();
}
el("review-close").addEventListener("click", () => {
  if (phoneReview?.matches && (pickingRegion || selected)) {
    selected = null; selectedNode = null; returnToArmed = false;
    endPicking(); positionHighlight(); update();
    el("review-close").focus();
  } else closeReview();
});
el("review-form-close").addEventListener("click", closeReview);
el("review-conversation-tab")?.addEventListener("click", () => {
  endPicking();
  returnToArmed = false;
  selected = null;
  selectedNode = null;
  setReviewTab("conversation");
  positionHighlight();
  update();
});
el("review-annotation-tab")?.addEventListener("click", () => { if (phoneReview?.matches) document.activeElement?.blur?.(); setReviewTab("annotation"); update(); });
el("review-history-tab")?.addEventListener("click", () => { setReviewTab("review"); update(); void refreshStatuses(); });
const reviewTabIds = ["review-conversation-tab", "review-annotation-tab", "review-history-tab"];
for (const id of reviewTabIds) {
  el(id)?.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = reviewTabIds.filter((tabId) => tabId !== "review-annotation-tab");
    const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)
      : tabs[(tabs.indexOf(id) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    el(next).click(); el(next).focus();
  });
}
el("review-sent")?.addEventListener("toggle", () => {
  sentOpen = el("review-sent").open;
  setReviewTab(activeReviewTab);
  if (sentOpen) void refreshStatuses();
});
function updateSelectionAction() {
  const action = el("review-select-location");
  if (!action) return;
  const name = selected ? "Selection ready ✓" : pickingRegion ? "Select on page" : "Annotate";
  action.textContent = name;
  action.setAttribute("aria-label", name);
  el("review-clear-location").hidden = !selected || Boolean(phoneReview?.matches);
  const close = el("review-close");
  const cancelling = Boolean(phoneReview?.matches && (pickingRegion || selected));
  close.textContent = cancelling ? "Cancel annotation" : "Close ×";
  close.setAttribute("aria-label", cancelling ? "Cancel annotation (keep draft)" : "Close review conversation (keep draft)");
  if (pickingRegion) el("review-panel").setAttribute("data-picking", "");
  else el("review-panel").removeAttribute?.("data-picking");
}
el("review-select-location")?.addEventListener("click", () => {
  if (phoneReview?.matches && activeReviewTab !== "annotation") {
    document.activeElement?.blur?.();
    // Switching the phone pane must not consume the activation that arms selection.
    setReviewTab("annotation");
  }
  if (selected) { selected = null; selectedNode = null; positionHighlight(); }
  else if (pickingRegion) { endPicking(); update(); return; }
  pickingRegion = true;
  pickNotice.hidden = true;
  document.activeElement?.blur?.();
  update();
});
el("review-clear-location")?.addEventListener("click", () => {
  selected = null; selectedNode = null;
  pickingRegion = returnToArmed;
  returnToArmed = false;
  positionHighlight(); update();
});
pickNotice.querySelector?.("button")?.addEventListener("click", () => { endPicking(); panel(true); });
window.addEventListener("hashchange", () => {
  if (!selected && !pickingRegion) return;
  selected = null; selectedNode = null; returnToArmed = false; endPicking(); positionHighlight(); update();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && el("review-gesture-popover")?.matches(":popover-open")) {
    event.preventDefault();
    event.stopImmediatePropagation();
    el("review-gesture-popover").hidePopover();
    return;
  }
  if (event.key !== "Tab" || !phoneReview?.matches || el("review-panel").hidden || activeReviewTab !== "annotation") return;
  const panelNode = el("review-panel");
  const controlsInSheet = [...(panelNode.querySelectorAll?.('button:not([hidden]):not([disabled]), textarea:not([hidden])') || [])]
    .filter((node) => node.getClientRects().length);
  if (!controlsInSheet.length) return;
  const first = controlsInSheet[0], last = controlsInSheet.at(-1);
  if (!panelNode.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  if (pickingRegion) { event.preventDefault(); endPicking(); update(); return; }
  if (!el("review-annotation").hidden) {
    event.preventDefault();
    el("review-form-close").click();
    return;
  }
  if (el("review-panel").hidden || !(el("review-panel").contains(event.target) || el("desktop-review-footer")?.contains(event.target))) return;
  if (!window.matchMedia("(min-width: 721px)").matches && activeReviewTab === "review") return;
  event.preventDefault();
  closeReview();
});
document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch" || event.target.closest("#review-panel, #review-panel-toggle, #review-pick")) return;
  hoveredNode = targetFor(event.target);
  hovered = regionFor(hoveredNode);
  // Hover never changes the review conversation: preserve focus and expanded notes.
  el("review-pick").hidden = !hovered || Boolean(desktopComposer?.matches);
});
el("review-pick").addEventListener("click", () => { if (hovered && hoveredNode) selectRegion(hoveredNode); });
document.addEventListener("pointerdown", (event) => {
  pointerTextRange = null;
  if (event.button === 0 && (pickingRegion || annotateByDefault !== event.altKey) && targetFor(event.target)) {
    pointerTextRange = capture?.textRangeTarget(window.getSelection?.());
    if (pointerTextRange) event.preventDefault(); // Capture before a click collapses native selection.
  }
  if (pickingRegion) touchStart = { x: event.clientX, y: event.clientY, moved: false };
}, true);
document.addEventListener("pointermove", (event) => {
  if (touchStart && Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10) touchStart.moved = true;
}, true);
document.addEventListener("scroll", () => { if (pickingRegion) scrollUntil = Date.now() + 450; }, true);
document.addEventListener("click", (event) => {
  if (event.button !== 0 || event.detail === 0 || event.target.closest("#review-panel, #review-panel-toggle, #review-pick, .app-update-notice")) return;
  if (phoneReview?.matches && !el("review-panel").hidden && activeReviewTab === "annotation") {
    if (!pickingRegion || touchStart?.moved || Date.now() < scrollUntil || !regionFor(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); touchStart = null; return;
    }
    touchStart = null;
  }
  // Review chrome stays operable so annotation mode can always be turned off.
  if (event.target.closest(".review-pick-notice, .review-gesture-controls, #review-gesture-popover, #desktop-review-footer")) return;
  // While annotating (picking, mode on, or Alt-click with mode off) the tool owns
  // every click, including non-interactive areas; none reaches the page beneath.
  if (!pickingRegion && annotateByDefault === event.altKey) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!regionFor(event.target)) return;
  selectRegion(event.target, pickingRegion ? undefined : { x: event.clientX, y: event.clientY });
}, true);
el("review-message").addEventListener("input", () => { composeQueuedText = ""; resizeMessage(); update(); });
el("review-message").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    void send(false);
  } else if (!event.shiftKey && !event.altKey && !window.matchMedia?.("(pointer: coarse)")?.matches) {
    event.preventDefault();
    el("review-form").requestSubmit();
  }
});
function enqueue() {
  const text = el("review-message").value.trim();
  if (!text || queue.length >= 30) { el("review-state").textContent = !text ? "Write a note first." : "Send this batch before adding more."; return false; }
  if (selected?.target?.type === "quote") { el("review-state").textContent = "This old target must be selected again before queuing."; return false; }
  if (selected?.record && !selected.record.recordId && !selected.record.sha256) { el("review-state").textContent = "Capturing message identity; try Queue again shortly."; return false; }
  const note = { prompt: text, tag: selected?.tag || (selected ? "element" : "message"), selector: selected?.selector || "", text: selected?.text || "", route: selected?.route || route(), version: selected?.version || config.version };
  if (selected?.target?.type === "record") note.record = { recordId: selected.target.recordId };
  else if (selected?.record) note.record = selected.record;
  if (["text-range", "table-cell"].includes(selected?.target?.type)) note.target = selected.target;
  const targetLabel = selected?.wireLabel || (selected?.selector === undefined ? selected?.label : "");
  if (targetLabel && targetLabel !== note.text) note.label = targetLabel;
  queue.push(note);
  queueIds.push(crypto.randomUUID());
  batchId ||= crypto.randomUUID();
  composeQueuedText = text;
  el("review-message").value = "";
  closeAnnotation();
  resizeMessage();
  selected = null;
  selectedNode = null;
  returnToArmed = false;
  el("review-form").classList?.remove("review-form-anchored");
  if (el("review-form").style) el("review-form").style.left = el("review-form").style.top = "";
  positionHighlight();
  el("review-state").textContent = "Queued. Add another or send the batch.";
  update();
  return true;
}
el("review-form").addEventListener("submit", (event) => { event.preventDefault(); enqueue(); });
let sendingCalls = false;
async function sendCallAnswers() {
  const ready = callQueue().filter((entry) => entry.phase !== "sending");
  if (!ready.length || sendingCalls) return false;
  sendingCalls = true;
  el("review-state").textContent = `Sending ${ready.length} Captain's Call ${ready.length === 1 ? "answer" : "answers"}…`;
  let ok = false;
  try { ok = await window.quarterdeckCallQueue.send(); } catch {}
  finally { sendingCalls = false; }
  el("review-state").textContent = ok ? `Sent ${ready.length} Captain's Call ${ready.length === 1 ? "answer" : "answers"}; receipts show on each card.` : "Some Captain's Call answers were not confirmed; their cards say why and keep them for retry.";
  update();
  try { window.quarterdeckCallQueue?.refresh?.(); } catch {}
  return ok;
}
async function send(end) {
  // Await only when answers are queued, so an ordinary batch posts in the same tick.
  if (callQueue().some((entry) => entry.phase !== "sending")) await sendCallAnswers();
  if (pending || !config.ready) return;
  // Send batch and Send & End both take a non-empty compose draft with the queued notes.
  // Text Queue already took stays in that queue once; a full board still sends and keeps the extra draft.
  if (!reviewHistoryTab()) {
    const draft = el("review-message").value.trim();
    const alreadyQueued = Boolean(draft) && draft === composeQueuedText && queue.some((entry) => entry.prompt === draft);
    if (alreadyQueued) {
      el("review-message").value = "";
      resizeMessage();
      update();
    } else if (draft && (end || queue.length < 30) && !enqueue()) return;
  }
  if (!queue.length && retryBatches.length && !end) { await submitBatch(retryBatches[0]); return; }
  if (!queue.length && (!end || !retryBatches.length)) return;
  // Capture the entire persisted board at the action cutoff, before any await.
  // Earlier unconfirmed identities are retried separately, never joined to it.
  const previous = end ? [...retryBatches] : [];
  let captured = null;
  if (queue.length) {
    if (queue.some((entry) => entry.record && !entry.record.recordId && !entry.record.sha256)) { el("review-state").textContent = "Message identity is still being captured. Check targets before sending."; return; }
    const id = batchId || crypto.randomUUID();
    captured = { id, payload: { schema: "fm-agentos-review.v2", batchId: id, sessionId: config.sessionId, version: config.version, route: route(), end,
      entries: queue.map((entry) => {
        const { version, route: entryRoute, ...wire } = capture ? capture.migrateEntry(entry) : entry;
        if (entryRoute && entryRoute !== route()) wire.route = entryRoute;
        return JSON.parse(JSON.stringify(wire));
      }) } };
    queue = [];
    queueIds = [];
    batchId = null;
    // If earlier delivery must finish first, retain this snapshot durably too.
    if (previous.length) retryBatches.push(captured);
    saveDraft();
  }
  for (const prior of previous) if (!await submitBatch(prior)) return;
  if (captured && !await submitBatch(captured)) return;
  if (end && !captured && !queue.length && !retryBatches.length && !el("review-message").value.trim()) {
    selected = null; hovered = null; panel(false);
    el("review-state").textContent += " · review ended";
  }
}
async function submitBatch(captured) {
  if (pending || !config.ready || !captured) return;
  const retryIndex = retryBatches.findIndex((batch) => batch.id === captured.id);
  retryBatches = retryBatches.filter((batch) => batch.id !== captured.id);
  pending = true;
  delete captured.rejected; // Only this attempt's definitive rejection permits conversion.
  inFlight = captured;
  inFlightIndex = retryIndex < 0 ? retryBatches.length : retryIndex;
  saveDraft(); // Preserve uncertain delivery's exact identity across reloads.
  update();
  try {
    const payload = captured.payload;
    const response = await fetch("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 400 && result.error === "Invalid review payload or version") {
        // The current server checked durable local receipts before rejecting.
        // A new identity is an explicit target-review action, never automatic.
        if (config.delivery === "local" && !captured.payload.sessionId) captured.rejected = true;
        try {
          const current = await fetch("/api/review", { cache: "no-store" });
          if (current.ok) {
            retryBatches.splice(retryIndex < 0 ? retryBatches.length : retryIndex, 0, captured);
            if (useCurrentVersion(await current.json())) return false;
          }
        } catch { /* Keep the original failure and retry ID when configuration is unavailable. */ }
      }
      throw new Error(result.error || "Delivery failed");
    }
    if (typeof result.receiptId !== "string" || !result.receiptId) throw new Error("Delivery receipt missing");
    // Only a confirmed receipt closes a review; keep later queued notes and
    // independent unconfirmed identities available for their own delivery.
    if (captured.payload.end) { sent = []; openBatches.clear(); openNotes.clear(); }
    else sent.push({ id: captured.id, receiptId: result.receiptId, state: result.delivery === "local" ? "accepted" : null, sentAt: new Date().toISOString(), entries: captured.payload.entries, route: payload.route, version: payload.version, end: false });
    void loadConfig();
    retryBatches = retryBatches.filter((batch) => batch.id !== captured.id);
    openBatches.delete(captured.id);
    el("review-state").textContent = `${result.delivery === "local" ? statusLabels.accepted : "Delivery confirmed; downstream status unavailable"} · receipt ${result.receiptId}`;
    window.dispatchEvent?.(new Event("quarterdeck-sent"));
    if (result.delivery === "local") void refreshStatuses();
    if (captured.payload.end && !queue.length && !retryBatches.length && !el("review-message").value.trim()) {
      selected = null; hovered = null; panel(false);
      el("review-state").textContent += " · review ended";
    } else if (captured.payload.end) el("review-state").textContent += " · later notes remain on the board; send them separately before ending";
    return true;
  } catch (error) {
    if (!retryBatches.some((batch) => batch.id === captured.id)) retryBatches.splice(retryIndex < 0 ? retryBatches.length : retryIndex, 0, captured);
    el("review-state").textContent = `${error.message}. Captured batch retained; retry with the same batch ID. Later notes stay separate.`;
    return false;
  } finally { inFlight = null; inFlightIndex = null; pending = false; update(); }
}
el("review-send").addEventListener("click", () => send(false));
window.quarterdeckReviewQueue = { refresh: () => update(), sendCallAnswers, sending: () => sendingCalls };
el("review-end").addEventListener("click", () => send(true));
update();
