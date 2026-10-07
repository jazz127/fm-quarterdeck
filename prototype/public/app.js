const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const stateLabel = (state) => state.replaceAll("-", " ");
const money = ({ currency, amount }) => `${currency} ${amount}`;
const { KEY: MESSAGE_TYPES_KEY, TYPES: MESSAGE_TYPES, LEGACY_KEY: MESSAGE_TYPES_LEGACY_KEY, stored: storedMessageTypes, typeId: messageTypeId, label: messageTypeLabel, icon: messageTypeIcon, svg: messageTypeSvg } = window.messageKinds;
const MESSAGE_FORMAT_KEY = "fm-agentos-message-format-v1";
const { normalize: normalizeMessageFontSize, stored: storedMessageFontSize, rem: messageFontSizeRem, step: stepMessageFontSizeValue, bounds: messageFontSizeBounds, persist: persistMessageFontSize } = window.messageFontSizePrefs;
let messageFontSize = storedMessageFontSize();
function applyMessageFontSize(size = messageFontSize) {
  messageFontSize = normalizeMessageFontSize(size);
  document.documentElement?.style?.setProperty?.("--message-font-size", messageFontSizeRem(messageFontSize));
  const { atMin, atMax } = messageFontSizeBounds(messageFontSize);
  const decrease = $("#font-size-decrease");
  const increase = $("#font-size-increase");
  if (decrease) {
    decrease.disabled = atMin;
    decrease.setAttribute("aria-disabled", String(atMin));
    decrease.classList.toggle("is-disabled", atMin);
  }
  if (increase) {
    increase.disabled = atMax;
    increase.setAttribute("aria-disabled", String(atMax));
    increase.classList.toggle("is-disabled", atMax);
  }
  persistMessageFontSize(messageFontSize);
}
function stepMessageFontSize(delta) {
  applyMessageFontSize(stepMessageFontSizeValue(messageFontSize, delta));
}
let lanes = [];
let selectedLaneIds = new Set();
let selectedMessageTypes = storedMessageTypes();
let messageFormat = storedMessageFormat();
let selectedSessionId = null;
let taskOlderPages = 0;
let diskOlderPages = 0;
const retainedSessions = new Set();
const retainedDisk = new Set();
let pendingLanesRefresh = false;
let lastFeedFingerprint = "";
let lastPageAnchor = "";
let preservePageAnchor = false;
let feedLaneOverrideId = null;
let allLanesSelected = true;
let laneStatusFilter = "all";
let hasLoadedLanes = false;
let hasRenderedFeed = false;
let refreshTimer = null;
let preferenceEntries = [];
let preferenceDensity = "details";
let preferenceSort = "source";
const preferenceOpen = new Map();
const { statusLabels, statusConciseLabels, statusAbbreviations, groupHierarchy, statusCounts } = window.workHierarchy || {};
const hierarchyOpen = new Map();
try { for (const [key, value] of JSON.parse(localStorage.getItem("fm-agentos-hierarchy-open.v1") || "[]")) hierarchyOpen.set(key, value); } catch {}
let workSplitData = null;
let workGroupBy = "repository";
let workRepository = "all";
let workPhase = "all";
let overviewProjects = [];
let overviewSort = "name";
let overviewStatus = "all";
const ACTIVE_AGENT_STATES = new Set(["active", "working", "in-progress"]);
const agentStatusGroup = (state) => ACTIVE_AGENT_STATES.has(state) ? "active" : state;
const overviewOpen = new Map();
let transcriptCoverage = { sessions: [], warnings: [], note: "" };
let selectedTranscriptSession = "";
let transcriptPage = null;
let previousPageCount = null;
let transcriptSelection = "";
let transcriptQuery = "";
let expenseEntries = [];
let expenseSort = { key: "date", direction: "desc" };
const TRANSCRIPT_PAGE_SIZE = 200;
const reviewId = (value) => {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  return (hash >>> 0).toString(36);
};

function storedMessageFormat() {
  try {
    return localStorage.getItem(MESSAGE_FORMAT_KEY) === "raw" ? "raw" : "markdown";
  } catch {
    return "markdown";
  }
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightSearchMatches(html, query) {
  const trimmed = (query || "").trim();
  if (!trimmed) return html;
  const escapedQuery = escapeRegExp(escapeHtml(trimmed));
  const regex = new RegExp(escapedQuery, "gi");
  return html.replace(/(<[^>]+>)|([^<]+)/g, (_match, tag, text) => {
    if (tag) return tag;
    return text.replace(regex, "<mark>$&</mark>");
  });
}

function renderMarkdown(value) {
  const output = [];
  let list = null;
  let code = false;
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };
  for (const line of String(value).split(/\r?\n/)) {
    if (/^```/.test(line)) {
      closeList();
      output.push(code ? "</code></pre>" : "<pre><code>");
      code = !code;
      continue;
    }
    if (code) {
      output.push(`${escapeHtml(line)}\n`);
      continue;
    }
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (item) {
      const nextList = /\d/.test(item[1]) ? "ol" : "ul";
      if (list !== nextList) {
        closeList();
        output.push(`<${nextList}>`);
        list = nextList;
      }
      output.push(`<li>${inlineMarkdown(item[2])}</li>`);
      continue;
    }
    closeList();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
    else if (line.trim()) output.push(`<p>${inlineMarkdown(line)}</p>`);
    else output.push("<br>");
  }
  closeList();
  if (code) output.push("</code></pre>");
  return output.join("");
}

function orderedProjectLanes() {
  return lanes.filter((lane) => lane.id !== "general");
}

function orderedFilterLanes() {
  const general = lanes.find((lane) => lane.id === "general");
  return [...(general ? [general] : []), ...orderedProjectLanes().filter((lane) => !lane.closed)];
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Filtering still works when storage is unavailable.
  }
}

function decodeRoutePart(value) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

function parseRoute(hash = window.location.hash) {
  const parts = String(hash || "#overview").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "lanes") {
    return { view: "conversations", laneId: decodeRoutePart(parts[1] || ""), sessionId: parts[2] === "session" ? decodeRoutePart(parts[3] || "") : "" };
  }
  if (["overview", "work", "expenses", "quota", "preferences", "closed"].includes(parts[0])) return { view: parts[0], laneId: "", sessionId: "" };
  return { view: "overview", laneId: "", sessionId: "" };
}

function conversationRoute(laneId = "", sessionId = "") {
  const lane = laneId ? `/${encodeURIComponent(laneId)}` : "";
  const session = laneId && sessionId ? `/session/${encodeURIComponent(sessionId)}` : "";
  return `#lanes${lane}${session}`;
}

const ownRouteChanges = [];
function setRoute(hash) {
  if (window.location.hash !== hash) {
    // Hashchange is asynchronous. The UI already applied this navigation; replaying
    // it would silently reset an empty/multi-lane filter to the default All view.
    ownRouteChanges.push(hash);
    window.location.hash = hash;
  }
}

if (!window.location.hash) window.location.hash = "#overview";

function liveLanes() {
  return lanes.filter((lane) => !lane.closed);
}

// Lane-selection owner: checked IDs and reported status are independent facets.
// The hash can represent a single checked ID, never a status-derived singleton.
// Closed history is an explicit route override, not a mutation of live filters.
function laneSelection() {
  const live = liveLanes();
  const checked = live.filter((lane) => allLanesSelected || selectedLaneIds.has(lane.id));
  const effective = feedLaneOverrideId
    ? lanes.filter((lane) => lane.id === feedLaneOverrideId && lane.closed)
    : checked.filter((lane) => laneStatusFilter === "all" || lane.status === laneStatusFilter);
  return { checked, effective, all: live.length > 0 && checked.length === live.length,
    routeId: !feedLaneOverrideId && checked.length === 1 ? checked[0].id : "" };
}
function selectedLanes() { return laneSelection().effective; }

// Called synchronously by Chat Firstmate's submit handler, never from a background
// refresh. Only the actually rendered, viewport-visible record anchors are sent.
window.fmChatViewContext = function (served) {
  const route = window.location.hash || "#overview";
  const inFeed = /^#lanes(?:\/|$)/.test(route) && $("#conversations-view").classList.contains("active");
  const feed = $("#messages");
  const bounds = feed.getBoundingClientRect();
  const visible = inFeed ? [...feed.querySelectorAll("article.message[data-record-index]")].filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0 && bounds.height > 0;
  }) : [];
  const records = messagesForSelection();
  const anchor = (node) => {
    const item = records[Number(node.dataset.recordIndex)];
    return item ? { id: String(item.recordId || `record:${reviewId([item.source, item.occurredAt, item.text].join(":"))}`).slice(0, 300), at: item.occurredAt } : null;
  };
  const scoped = inFeed ? selectedLanes() : [];
  return {
    schema: "fm-agentos-chat-view.v1", capturedAt: new Date().toISOString(), route,
    served: { branch: served.branch, commit: served.commit },
    lanes: scoped.map(({ id, name }) => ({ id, name })),
    filters: { kinds: inFeed ? MESSAGE_TYPES.filter(({ id }) => selectedMessageTypes.has(id)).map(({ id }) => id) : [],
      search: inFeed ? transcriptQuery.slice(0, 160) : "", searchTruncated: inFeed && transcriptQuery.length > 160,
      session: inFeed ? selectedSessionId || "" : "", diskSession: inFeed ? selectedTranscriptSession : "",
      page: inFeed ? transcriptPage : null },
    visible: { first: visible.length ? anchor(visible[0]) : null, last: visible.length ? anchor(visible.at(-1)) : null,
      focused: visible.includes(document.activeElement?.closest?.("article.message")) ? anchor(document.activeElement.closest("article.message")) : null },
  };
};

function messagesForSelection() {
  const visibleLanes = selectedLanes();
  const merged = new Map();
  for (const lane of visibleLanes) {
    const occurrences = new Map();
    for (const message of lane.messages) {
      if (!selectedMessageTypes.has(messageTypeId(message))) continue;
      if (selectedSessionId && message.taskId !== selectedSessionId) continue;
      if (selectedTranscriptSession && message.transcriptSessionId !== selectedTranscriptSession) continue;
      // Without a source record ID, preserve repeated identical events within one lane.
      // An ordinal is only a rendering/deduplication key, never a claimed record ID.
      const fingerprint = [message.occurredAt, message.source, message.author, message.text].join("\n");
      const ordinal = occurrences.get(fingerprint) || 0;
      occurrences.set(fingerprint, ordinal + 1);
      const key = message.recordId ? `record:${message.recordId}` : `quoted:${fingerprint}:${ordinal}`;
      const existing = merged.get(key);
      if (existing) existing.laneNames.push(lane.name);
      else merged.set(key, { ...message, laneNames: [lane.name] });
    }
  }
  const query = transcriptQuery.trim().toLocaleLowerCase();
  const matchesQuery = (message) => !query || [message.text, message.author, message.source, ...message.laneNames]
    .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  const order = (message) => message.role === "captain" ? 0 : message.kind === "thinking" ? 1 : message.kind === "crew" ? 3 : 2;
  return [...merged.values()].filter(matchesQuery).sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || order(a) - order(b));
}

const { sync: syncBulkControls, bindToggle: bindBulkToggle } = window.bulkControls;
const filterView = window.filterView;
const laneBulkNodes = () => ({ toggle: $("#lane-bulk-toggle") });
const kindBulkNodes = () => ({ toggle: $("#kinds-bulk-toggle") });
function renderMessageTypeFilters() {
  filterView.renderKindFilters({
    types: MESSAGE_TYPES,
    selectedIds: selectedMessageTypes,
    escapeHtml,
    syncBulk: syncBulkControls,
    root: $("#message-type-filters"),
    nodes: kindBulkNodes(),
  });
}
function syncLaneBulkControls() {
  const selection = laneSelection();
  const live = liveLanes();
  filterView.syncLanesBulk({
    all: selection.all,
    none: live.length === 0 || selection.checked.length === 0,
    disabled: live.length === 0,
    syncBulk: syncBulkControls,
    nodes: laneBulkNodes(),
  });
}
function renderLaneFilters() {
  const filterLanes = orderedFilterLanes();
  const live = liveLanes();
  const selection = laneSelection();
  const statuses = [...new Set(live.map((lane) => lane.status).filter(Boolean))].sort();
  const checkedIds = new Set(selection.checked.map((lane) => lane.id));
  const { statusFilter } = filterView.renderLaneFilters({
    filterLanes,
    liveStatuses: statuses,
    statusFilter: laneStatusFilter,
    checkedIds,
    selectionAll: selection.all,
    checkedCount: selection.checked.length,
    liveCount: live.length,
    escapeHtml,
    stateLabel,
    syncBulk: syncBulkControls,
    statusSelect: $("#lane-status"),
    rowsRoot: $("#lane-filter-rows"),
    railRoot: $("#lane-collapsed-rail"),
    nodes: laneBulkNodes(),
  });
  laneStatusFilter = statusFilter;
}

function renderClosedLanes(query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const closedLanes = orderedProjectLanes().filter((lane) => {
    if (!lane.closed) return false;
    const searchText = [lane.name, lane.mission, ...(lane.sessions || []).flatMap((session) => [session.id, session.state])].join(" ").toLowerCase();
    return !normalizedQuery || searchText.includes(normalizedQuery);
  });
  $("#closed-lane-list").innerHTML = closedLanes.length ? closedLanes.map((lane) => `
    <article data-review-id="closed:${reviewId(lane.id)}" class="closed-lane-card">
      <header><div><span class="project-dot closed"></span><strong>${escapeHtml(lane.name)}</strong></div><span class="state-chip">Closed</span></header>
      <p>${escapeHtml(lane.mission)}</p>
      <div class="closed-lane-sessions">
        ${(lane.sessions || []).length ? lane.sessions.map((session) => `<button type="button" data-closed-lane="${escapeHtml(lane.id)}" data-closed-session="${escapeHtml(session.id)}"><span><strong>${escapeHtml(session.id)}</strong><small>${session.updatedAt ? escapeHtml(new Date(session.updatedAt).toLocaleDateString()) : "No events"}</small></span><b>${escapeHtml(session.classification && statusLabels ? statusLabels[session.classification.status] : stateLabel(session.state))}</b></button>`).join("") : '<p class="empty compact">No task sessions recorded.</p>'}
      </div>
      <button class="open-closed-lane" type="button" data-closed-lane="${escapeHtml(lane.id)}">Open fleet history</button>
    </article>`).join("") : `<div class="empty panel">${normalizedQuery ? "No closed fleets match this filter." : "No closed fleets yet."}</div>`;
}

function statusIcon(state) {
  return ({ working: "●", done: "✓", blocked: "!", failed: "×", paused: "Ⅱ", "needs-decision": "?", resolved: "↗" })[state] || "·";
}

function renderSessionHistory(visibleLanes) {
  const sessions = visibleLanes.flatMap((lane) => (lane.sessions || []).map((session) => ({ ...session, laneId: lane.id, laneName: lane.name })));
  // Open the task index on entering a lane, but leave user toggles alone on refresh.
  const history = document.querySelector(".session-history");
  const laneScope = visibleLanes.length === 1 ? visibleLanes[0].id : "";
  if (history && history.dataset.laneScope !== laneScope) {
    history.open = Boolean(laneScope);
    history.dataset.laneScope = laneScope;
  }
  // A direct route may name an older session; keep its filter until that exact
  // session is fetched (or the source confirms it does not exist).
  $("#session-count").textContent = `${sessions.filter((session) => session.loaded).length} / ${sessions.length}`;
  $("#sessions-load-older").hidden = !sessions.some((session) => !session.loaded) || taskOlderPages >= 20;
  $("#session-history-list").innerHTML = sessions.length ? `
    ${selectedSessionId ? '<button class="session-clear" type="button">Show all tasks</button>' : ""}
    ${sessions.map((session) => `<button class="session-row${session.id === selectedSessionId ? " active" : ""}" type="button" data-session-id="${escapeHtml(session.id)}" data-lane-id="${escapeHtml(session.laneId)}" data-loaded="${session.loaded !== false}">
      <span><strong>${escapeHtml(session.id)}</strong><small>${escapeHtml(session.laneName)}</small>${session.classification ? `<small>${escapeHtml(session.classification.lane.name)} → ${escapeHtml(session.classification.theme.name)}</small>` : ""}</span>
      <span><b>${escapeHtml(session.classification && statusLabels ? statusLabels[session.classification.status] : stateLabel(session.state))}</b><small>${session.updatedAt ? escapeHtml(new Date(session.updatedAt).toLocaleDateString()) : "No events"}${session.loaded === false ? " · load on selection" : ""}</small></span>
    </button>`).join("")}` : '<p class="empty compact">No crew tasks recorded for these fleets.</p>';
}

function renderFeed() {
  const visibleLanes = selectedLanes();
  const selection = laneSelection();
  const showingAllLive = selection.all && laneStatusFilter === "all" && !feedLaneOverrideId;
  const onlyLane = (!selection.all || feedLaneOverrideId) && visibleLanes.length === 1 ? visibleLanes[0] : null;
  renderSessionHistory(visibleLanes);
  $("#conversation-title").textContent = showingAllLive ? "All conversations" : onlyLane?.name || `${visibleLanes.length} fleets selected`;
  const statusText = onlyLane ? stateLabel(onlyLane.status) : `${visibleLanes.length} fleet${visibleLanes.length === 1 ? "" : "s"}`;
  $("#conversation-status").textContent = statusText;
  $("#conversation-dot").className = `project-dot ${onlyLane?.status || (visibleLanes.length ? "active" : "idle")}`;
  // H3 — one muted subtext line under the title (never a 2nd header bar / chip stack)
  const crumb = selectedSessionId
    ? String(selectedSessionId).slice(0, 24)
    : selectedTranscriptSession
      ? String(selectedTranscriptSession).slice(0, 24)
      : (onlyLane?.id ? String(onlyLane.id).slice(0, 24) : "live");
  const subtext = $("#conversation-subtext");
  if (subtext) subtext.textContent = ["Fleet Chats", statusText, crumb].filter(Boolean).join(" · ");

  const taskChip = $("#task-filter-chip");
  if (taskChip) {
    // Task filter lives in subtext on desktop; keep chip for mobile/compact only.
    const showChip = Boolean(selectedSessionId) && Boolean(window.matchMedia?.("(max-width: 720px)")?.matches);
    if (selectedSessionId) {
      const taskIdEl = $("#task-filter-id");
      if (taskIdEl) taskIdEl.textContent = selectedSessionId;
    }
    taskChip.hidden = !showChip;
  }

  const messages = messagesForSelection();
  const feedSelection = JSON.stringify([visibleLanes.map((lane) => lane.id), [...selectedMessageTypes], selectedSessionId, selectedTranscriptSession]);
  const selectionChanged = feedSelection !== transcriptSelection;
  if (selectionChanged) transcriptPage = null;
  transcriptSelection = feedSelection;
  const recordKey = (message) => message.recordId || reviewId([message.source, message.occurredAt, message.text].join("\n"));
  const pageCount = Math.max(1, Math.ceil(messages.length / TRANSCRIPT_PAGE_SIZE));
  const feedBefore = $("#messages");
  const followingLatest = transcriptPage === null || (previousPageCount !== null && transcriptPage === previousPageCount - 1 &&
    feedBefore.scrollHeight - feedBefore.scrollTop - feedBefore.clientHeight < 60);
  transcriptPage = followingLatest ? pageCount - 1 : Math.min(transcriptPage, pageCount - 1);
  if (preservePageAnchor && !selectionChanged && !followingLatest && lastPageAnchor) {
    const index = messages.findIndex((message) => recordKey(message) === lastPageAnchor);
    if (index >= 0) transcriptPage = Math.floor(index / TRANSCRIPT_PAGE_SIZE);
  }
  previousPageCount = pageCount;
  preservePageAnchor = false;
  const start = transcriptPage * TRANSCRIPT_PAGE_SIZE;
  const pageStart = messages.length ? start + 1 : 0;
  const pageEnd = Math.min(start + TRANSCRIPT_PAGE_SIZE, messages.length);
  const pageShort = `${pageStart}–${pageEnd} / ${messages.length}`;
  const pageSummary = `${pageStart}–${pageEnd} of ${messages.length} matching records${transcriptQuery.trim() ? ` for “${transcriptQuery.trim()}”` : ""}`;
  const pageEl = $("#transcript-page");
  pageEl.textContent = pageSummary;
  pageEl.title = pageSummary;
  pageEl.dataset.short = pageShort;
  $("#transcript-older").disabled = transcriptPage === 0;
  $("#transcript-newer").disabled = transcriptPage === pageCount - 1;

  const messagesEl = $("#messages");
  const jumpBtn = $("#jump-to-latest");
  const clientHeight = Number(messagesEl.clientHeight || 0);
  const scrollHeight = Number(messagesEl.scrollHeight || 0);
  const scrollTop = Number(messagesEl.scrollTop || 0);
  const distanceFromBottom = clientHeight > 0 ? (scrollHeight - scrollTop - clientHeight) : 0;
  const wasAtBottom = !hasRenderedFeed || selectionChanged || (followingLatest && distanceFromBottom < 60);

  const trimmedQuery = transcriptQuery.trim();
  const noLaneMessage = !selection.checked.length && !feedLaneOverrideId
    ? "Choose at least one fleet to show its records."
    : laneStatusFilter !== "all" && !feedLaneOverrideId
      ? "No checked fleets match this reported status. Change the status or checked fleets."
      : "Choose at least one fleet to show its records.";
  const emptyMessage = trimmedQuery
    ? `No records match “${escapeHtml(trimmedQuery)}”. <button id="search-empty-clear" class="empty-action" type="button">Clear search</button>`
    : (!visibleLanes.length ? noLaneMessage : !selectedMessageTypes.size ? "Choose a message kind below to populate the feed." : selectedSessionId ? "No matching records for this task and message-kind selection." : "No matching records for the selected fleets and message kinds.");

  const pageMessages = messages.slice(start, start + TRANSCRIPT_PAGE_SIZE);
  lastPageAnchor = pageMessages.length ? recordKey(pageMessages[0]) : "";
  // The overlay reads this exact rendered-page snapshot, not a hashed DOM address.
  window.quarterdeckMessageTargets = pageMessages.map((message) => message.recordId
    ? { type: "record", recordId: message.recordId }
    : { type: "quote", time: message.time, text: message.text, lanes: message.laneNames });
  // Fingerprint the bounded page before Markdown rendering or DOM work.
  const fingerprint = JSON.stringify([pageMessages, messageFormat, transcriptQuery, emptyMessage, start, showingAllLive]);
  if (fingerprint !== lastFeedFingerprint) {
  const feedHtml = messages.length ? pageMessages.map((message, index, page) => {
    const kind = message.kind || "conversation";
    const laneLabel = showingAllLive && message.laneNames.length === visibleLanes.length && visibleLanes.length > 1
      ? "All fleets"
      : message.laneNames.join(", ");
    const typeId = messageTypeId(message);
    const avatarMark = kind === "crew"
      ? `<span class="avatar-status">${escapeHtml(statusIcon(message.state))}</span>`
      : (messageTypeSvg(typeId) || `<span class="avatar-mono">${escapeHtml(message.author.slice(0, 1).toUpperCase())}</span>`);
    const rawOrRendered = kind !== "tools" && messageFormat === "markdown" ? renderMarkdown(message.text) : escapeHtml(message.text);
    const content = highlightSearchMatches(rawOrRendered, transcriptQuery);
    const compact = kind === "thinking" || kind === "tools";
    const preview = highlightSearchMatches(escapeHtml(String(message.text).replace(/\s+/g, " ").trim().slice(0, 120)), transcriptQuery);
    const metadata = `<strong>${escapeHtml(message.author)}</strong><span class="message-origin origin-${escapeHtml(typeId)}">${escapeHtml(messageTypeLabel(typeId))}</span>${kind === "crew" ? `<span class="message-state">${escapeHtml(stateLabel(message.state))}</span>` : ""}<span class="message-lane">${escapeHtml(laneLabel)}</span><time datetime="${escapeHtml(message.occurredAt)}">${escapeHtml(message.time)}</time>`;
    const body = `<div class="message-content ${kind === "tools" ? "raw" : messageFormat}">${content}</div><small class="message-source">${escapeHtml(message.source)}${message.transcriptOrigin ? ` · ${escapeHtml(message.transcriptOrigin)}` : ""}</small>`;
    return `
      ${message.transcriptSessionId && message.transcriptSessionId !== page[index - 1]?.transcriptSessionId ? `<div class="transcript-boundary">Session · ${escapeHtml(message.transcriptSessionId)}</div>` : ""}
      <article data-record-index="${start + index}" data-record-key="${escapeHtml(recordKey(message))}" data-lane-message-index="${index}" class="message ${compact ? "compact-record " : ""}${escapeHtml(message.role)} kind-${escapeHtml(kind)} state-${escapeHtml(message.state || "update")}">
        <div class="avatar" aria-hidden="true">${avatarMark}</div>
        <div class="message-body">
          ${compact ? `<details><summary><span class="compact-metadata">${metadata}</span><span class="compact-preview">${preview || "No record text"}</span></summary>${body}</details>` : `<header>${metadata}</header>${body}`}
        </div>
      </article>`;
  }).join("") : `<div class="empty compact">${emptyMessage}</div>`;
  // Don't discard disclosure/annotation DOM or reset scroll for identical pages.
    const open = new Set([...messagesEl.querySelectorAll("article.message details[open]")].map((node) => node.closest("article.message").dataset.recordKey));
    const visibleAnchor = [...messagesEl.querySelectorAll("article.message")].find((node) => node.getBoundingClientRect().bottom > messagesEl.getBoundingClientRect().top);
    const anchorKey = visibleAnchor?.dataset.recordKey;
    const anchorOffset = visibleAnchor ? visibleAnchor.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top : 0;
    messagesEl.innerHTML = feedHtml;
    for (const node of messagesEl.querySelectorAll("article.message details")) {
      if (open.has(node.closest("article.message").dataset.recordKey)) node.open = true;
    }
    if (!wasAtBottom && anchorKey) {
      const moved = [...messagesEl.querySelectorAll("article.message")].find((node) => node.dataset.recordKey === anchorKey);
      if (moved) messagesEl.scrollTop += moved.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top - anchorOffset;
    }
    lastFeedFingerprint = fingerprint;
  }

  if (wasAtBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (jumpBtn) jumpBtn.classList.add("hidden");
  } else {
    if (jumpBtn) jumpBtn.classList.remove("hidden");
  }
  hasRenderedFeed = true;

  const announcer = $("#sr-announcer");
  if (announcer) {
    announcer.textContent = messages.length
      ? pageSummary
      : (trimmedQuery ? `No records match “${trimmedQuery}”.` : (!visibleLanes.length ? noLaneMessage : !selectedMessageTypes.size ? "Choose a message kind below to populate the feed." : selectedSessionId ? "No matching records for this task and message-kind selection." : "No matching records for the selected fleets and message kinds."));
  }

  $("#message-format-toggle").textContent = messageFormat === "markdown" ? "View raw text" : "View formatted markdown";
  $("#message-format-toggle").setAttribute("aria-pressed", String(messageFormat === "raw"));

  const contextItems = visibleLanes.flatMap((lane) => lane.items.map((item) => ({ ...item, laneName: onlyLane ? "" : lane.name })));
  const totalCrew = visibleLanes.reduce((sum, lane) => sum + lane.crew, 0);
  $("#context-eyebrow").textContent = onlyLane ? "FLEET CONTEXT" : "STREAM CONTEXT";
  $("#context-title").textContent = showingAllLive ? "Everything" : onlyLane?.name || (visibleLanes.length ? "Selected fleets" : "No fleets selected");
  $("#context-mission").textContent = onlyLane?.mission || "Live events from the selected project fleets, merged into one chronological stream.";
  $("#context-crew").textContent = `${totalCrew} active`;
  $("#context-progress-label").textContent = onlyLane ? "Progress" : "Fleets";
  $("#context-progress").textContent = onlyLane ? `${onlyLane.progress}%` : String(visibleLanes.length);
  $("#context-items").innerHTML = contextItems.length
    ? contextItems.map((item) => `<li data-review-id="context:${reviewId(`${item.laneName}:${item.title}`)}">
      <span>${item.laneName ? `<b>${escapeHtml(item.laneName)}</b> · ` : ""}${escapeHtml(item.title)}</span>
      <small>${escapeHtml(item.classification ? statusLabels[item.classification.status] : stateLabel(item.state))}</small>
      ${item.classification ? `<p class="context-taxonomy">${escapeHtml(item.classification.repository)} → ${escapeHtml(item.classification.lane.name)} → ${escapeHtml(item.classification.theme.name)}</p>` : ""}
      <p class="context-task-intent">${escapeHtml(item.taskIntent || "Task intent not recorded.")}</p>
    </li>`).join("")
    : "<li>No in-flight work</li>";
}

function renderLanes(data) {
  lanes = data.lanes || [];
  try {
    if (localStorage.getItem(MESSAGE_TYPES_KEY) === null && localStorage.getItem(MESSAGE_TYPES_LEGACY_KEY) === null) {
      if (lanes.some((lane) => lane.messages.some((message) => message.kind === "thinking"))) selectedMessageTypes.add("thinking");
      else selectedMessageTypes.delete("thinking");
      renderMessageTypeFilters();
    }
  } catch { /* Preferences are optional. */ }
  transcriptCoverage = data.transcript || { sessions: [], warnings: [], note: "Transcript coverage unavailable." };
  const sources = transcriptCoverage.sessions;
  if (!sources.some((session) => session.id === selectedTranscriptSession)) selectedTranscriptSession = "";
  const summaryText = sources.length ? `Loaded ${sources.filter((session) => session.loaded).length} of ${sources.length} disk sessions · older history on demand` : "No disk transcript found · source details / gaps";
  $("#disk-load-older").hidden = !sources.some((session) => !session.loaded) || diskOlderPages >= 20;
  $("#transcript-summary").textContent = summaryText;
  const infoTrigger = $("#transcript-details summary");
  if (infoTrigger) {
    infoTrigger.title = summaryText;
    infoTrigger.setAttribute("aria-label", `Transcript coverage: ${summaryText}`);
  }
  $("#transcript-note").textContent = [transcriptCoverage.note, ...transcriptCoverage.warnings].join(" ");
  $("#transcript-sources").innerHTML = [...sources, ...(transcriptCoverage.outcomeSources || [])].map((session) => `<li>${escapeHtml(session.source)} · ${session.loaded ? `${session.messageCount} messages` : "not loaded"}${session.omittedBytes ? " · newest records only; older history not loaded" : ""}${session.skippedRecords ? ` · ${session.skippedRecords} malformed/undated records skipped` : ""}</li>`).join("");
  $("#transcript-session").innerHTML = '<option value="">Loaded transcript files</option>' + sources.map((session) => `<option value="${escapeHtml(session.id)}" ${session.id === selectedTranscriptSession ? "selected" : ""}>${escapeHtml(session.source)}${session.loaded ? "" : " · load on selection"}</option>`).join("");
  if (!lanes.length) {
    renderLanesError("No projects are registered in FM_HOME/data/projects.md.");
    return;
  }
  const availableIds = new Set(liveLanes().map((lane) => lane.id));
  if (allLanesSelected || !hasLoadedLanes) selectedLaneIds = new Set(availableIds);
  else selectedLaneIds = new Set([...selectedLaneIds].filter((id) => availableIds.has(id)));
  hasLoadedLanes = true;
  renderLaneFilters();
  renderClosedLanes($("#closed-search").value);
  preservePageAnchor = hasRenderedFeed;
  applyRoute({ isRefresh: true });
  if (selectedSessionId && lanes.some((lane) => lane.sessions.some((session) => session.id === selectedSessionId && !session.loaded))) requestLanes(true);
}

function renderLanesError(message) {
  lanes = [];
  $("#transcript-summary").textContent = "Transcript unavailable";
  const infoTrigger = $("#transcript-details summary");
  if (infoTrigger) {
    infoTrigger.title = "Transcript unavailable";
    infoTrigger.setAttribute("aria-label", "Transcript unavailable");
  }
  $("#transcript-note").textContent = message;
  $("#transcript-sources").innerHTML = "";
  $("#transcript-session").innerHTML = '<option value="">No transcript files available</option>';
  $("#transcript-page").textContent = "No history loaded";
  $("#transcript-page").title = "No history loaded";
  $("#transcript-page").dataset.short = "—";
  $("#sessions-load-older").hidden = true;
  $("#disk-load-older").hidden = true;
  $("#transcript-older").disabled = true;
  $("#transcript-newer").disabled = true;
  $("#lane-filter-rows").innerHTML = '<div class="empty compact">Live fleets unavailable</div>';
  const rail = $("#lane-collapsed-rail");
  if (rail) rail.innerHTML = "";
  syncLaneBulkControls();
  $("#closed-lane-list").innerHTML = '<div class="empty panel">Closed fleets are unavailable.</div>';
  $("#conversation-title").textContent = "Live fleets unavailable";
  $("#conversation-status").textContent = "offline";
  $("#conversation-dot").className = "project-dot blocked";
  const offlineSub = $("#conversation-subtext");
  if (offlineSub) offlineSub.textContent = "Fleet Chats · offline";
  $("#messages").innerHTML = `<div class="notice">${escapeHtml(message)}</div>`;
  $("#context-eyebrow").textContent = "STREAM CONTEXT";
  $("#context-title").textContent = "FM_HOME required";
  $("#context-mission").textContent = "Set FM_HOME to a readable Firstmate home and restart npm start.";
  $("#context-crew").textContent = "—";
  $("#context-progress-label").textContent = "Fleets";
  $("#context-progress").textContent = "—";
  $("#context-items").innerHTML = "";
}

function renderSummary(summary = {}) {
  if (summary.workCounts && statusLabels) {
    const kpis = [["Active", summary.activeAgents ?? summary.workCounts.active, "Verified workers"], ["Captain action", summary.workCounts["captain-action"], "Needs your input"], ["Newly done", summary.workCounts["newly-done"], `${summary.workCounts["previously-done"]} previously done`]];
    $("#summary").innerHTML = kpis.map(([label, value, detail]) => `<article class="metric-card panel"><strong>${escapeHtml(value)}</strong><h3>${escapeHtml(label)}</h3><p>${escapeHtml(detail)}</p></article>`).join("");
    return;
  }
  const cards = [
    ["Active agents", summary.activeAgents ?? 0, "Agents currently assigned", "↗"],
    ["Open decisions", summary.openDecisions ?? 0, "Awaiting command input", "!"],
    ["Completed today", summary.completedToday ?? 0, "Work items landed", "✓"],
  ];
  $("#summary").innerHTML = cards.map(([label, value, detail, icon]) => `
    <article class="metric-card panel">
      <span class="metric-icon">${icon}</span>
      <strong>${escapeHtml(value)}</strong>
      <h3>${label}</h3>
      <p>${detail}</p>
    </article>`).join("");
}

function workRepositoryKey(item) { return item.repository == null ? "unassigned" : `repo:${item.repository}`; }

function workGroups(items) {
  const groups = new Map();
  for (const item of items) {
    const key = workGroupBy === "repository" ? workRepositoryKey(item)
      : item.workGroup ? `${item.workGroup.kind}:${item.workGroup.name}` : "unassigned";
    const label = workGroupBy === "repository" ? item.repository || "Repository unassigned"
      : item.workGroup ? `${item.workGroup.kind === "epic" ? "Epic" : "Voyage"}: ${item.workGroup.name}` : "Voyage / epic unassigned";
    if (!groups.has(key)) groups.set(key, { key, label, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
    .map((group) => ({ ...group, items: group.items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) }));
}

function countBadges(items) {
  return Object.entries(statusCounts(items)).filter(([status, count]) => count || status === "active").map(([status, count]) => {
    const full = statusLabels?.[status] || status;
    const abbr = (statusAbbreviations && statusAbbreviations[status]) || status.charAt(0).toUpperCase();
    return `<span class="state-chip" data-count-status="${status}" title="${escapeHtml(full)}: ${count}" aria-label="${escapeHtml(full)}: ${count}"><span class="badge-label-full">${escapeHtml(full)} ${count}</span><span class="badge-label-abbr" aria-hidden="true">${escapeHtml(abbr)} ${count}</span></span>`;
  }).join(" ");
}

function workRow(item, scope) {
  const direct = item.chatLaneId ? conversationRoute(item.chatLaneId, item.id) : null;
  const options = item.taxonomyOptions.flatMap((lane) => lane.themes.map((theme) => `<option value="${escapeHtml(JSON.stringify([lane.id, theme.id]))}" ${item.lane.id === lane.id && item.theme.id === theme.id ? "selected" : ""}>${escapeHtml(lane.name)} → ${escapeHtml(theme.name)}</option>`)).join("");
  return `<li class="work-slice" data-review-id="${scope}:task:${item.taskFingerprint}" data-task-fingerprint="${item.taskFingerprint}" data-status="${item.status}">
    <div class="work-slice-head">${direct ? `<a href="${escapeHtml(direct)}" class="crew-task">${escapeHtml(item.name)}</a>` : `<strong>${escapeHtml(item.name)}</strong>`}<span class="state-chip">${escapeHtml(statusLabels[item.status])}</span></div>
    <small>${escapeHtml(item.id)}${item.large ? " · Large project" : " · Implementation slice"}</small>
    <p>${escapeHtml(item.taskIntent || "Task intent not recorded.")}</p>
    ${item.completionFingerprint ? `<p class="delivery-badge">${escapeHtml(item.delivery)}</p>` : ""}
    <div class="completion-badges">${item.completionAttention && item.completionAttention !== item.status ? `<span class="state-chip">${escapeHtml(statusLabels[item.completionAttention])}</span>` : ""}${item.evidence.map((entry) => `<span class="state-chip">${escapeHtml(entry.badge)}</span>`).join(" ")}${item.retained ? '<span class="state-chip">Preserved / cleanup pending</span>' : ""}</div>
    ${(item.completionAttention || item.status) === "newly-done" ? `<button type="button" data-ack-task="${item.taskFingerprint}" data-ack-completion="${item.completionFingerprint}">Mark understood</button>` : ""}
    <details class="work-inspection" data-tree-key="inspect:${item.taskFingerprint}" ${hierarchyOpen.get(`inspect:${item.taskFingerprint}`) === true ? "open" : ""}><summary>Evidence &amp; classification</summary>
      <p>Recorded state: ${escapeHtml(item.sourceState)} · ${escapeHtml(item.endpointEvidence)}</p>
      ${item.pendingIssues?.length ? `<p>Unresolved keys: ${escapeHtml(item.pendingIssues.map((issue) => `${issue.key} (${issue.state})`).join(", "))}</p>` : ""}
      ${item.waitingOn ? `<p>Waiting on: ${escapeHtml(item.waitingOn)}</p>` : ""}
      <p>Delivery and attention are independent. Understood changes presentation only; it does not merge, publish, deploy, close a task or resolve a decision.</p>
      ${item.evidence.length ? `<pre>${escapeHtml(JSON.stringify(item.evidence, null, 2))}</pre>` : '<p>No authoritative durability / deployment evidence.</p>'}
      <small>Task identity: ${item.taskFingerprint}${item.completionFingerprint ? `<br>Completion identity: ${item.completionFingerprint}<br>Completion source: ${item.completionSourceFingerprint}` : ""}</small>
      ${item.unboundCommit ? '<p>A task-level commit was withheld: it is not bound to this exact completion.</p>' : ""}
      ${options ? `<form data-classify-task="${item.taskFingerprint}"><label>Fleet → voyage <select name="classification"><option value='["unclassified","unclassified"]'>Leave unclassified</option>${options}</select></label><button type="submit">Save classification</button></form>` : ""}
      ${item.repositoryId !== "unknown" ? `<form data-create-taxonomy="${item.taskFingerprint}"><label>Fleet <input name="laneName" maxlength="120" required placeholder="Fleet name"></label><label>Voyage <input name="themeName" maxlength="120" required placeholder="Voyage name"></label><label>Voyage type <select name="kind"><option value="theme">Thematic</option><option value="iteration">Iterative</option></select></label><button type="submit">Create / assign taxonomy</button></form>` : '<p>Repository unknown; classification needs authoritative repository identity first.</p>'}
    </details></li>`;
}
function hierarchyHtml(items, scope) {
  const ordered = groupHierarchy(items).sort((a, b) => overviewSort === "activity" ? statusCounts(b.items).active - statusCounts(a.items).active || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  const disclosure = (key, title, rows, body, level) => `<details class="taxonomy-node taxonomy-${level} panel" data-tree-key="${key}" data-review-id="taxonomy:${reviewId(key)}" ${hierarchyOpen.get(key) === false ? "" : "open"}><summary><strong>${escapeHtml(title)}</strong><span class="taxonomy-counts">${countBadges(rows)}</span></summary>${body}</details>`;
  return ordered.map((repo) => {
    const lanes = [...repo.lanes.values()];
    const body = lanes.map((lane) => {
      const themes = [...lane.themes.values()];
      const contents = themes.map((theme) => {
        const rows = `<ul class="taxonomy-items">${theme.items.map((item) => workRow(item, scope)).join("")}</ul>`;
        // Groups contain only filtered records. Omitted wrappers never change saved open state.
        return themes.length === 1 ? rows : disclosure(`${scope}:${repo.id}:${lane.id}:${theme.id}`, `Voyage: ${theme.name}${theme.legacy ? " · legacy explicit grouping" : ""}`, theme.items, rows, "theme");
      }).join("");
      return lanes.length === 1 ? contents : disclosure(`${scope}:${repo.id}:${lane.id}`, lane.name, lane.items, contents, "lane");
    }).join("");
    return disclosure(`${scope}:${repo.id}`, repo.name, repo.items, body, "repository");
  }).join("") || '<p class="empty panel">No work matches these filters.</p>';
}
function renderStatusFilterButtons(container, options, selectedValue) {
  if (!container) return;
  container.innerHTML = options.map((opt) => {
    const isSelected = opt.value === selectedValue;
    const countHtml = opt.count !== undefined ? ` <span class="filter-count">${opt.count}</span>` : "";
    const accessibleName = opt.fullLabel ? (opt.count !== undefined ? `${opt.fullLabel}: ${opt.count}` : opt.fullLabel) : (opt.count !== undefined ? `${opt.label}: ${opt.count}` : opt.label);
    return `<button type="button" class="status-filter-btn${isSelected ? " active" : ""}" data-status-value="${escapeHtml(opt.value)}" aria-pressed="${isSelected ? "true" : "false"}" title="${escapeHtml(accessibleName)}" aria-label="${escapeHtml(accessibleName)}"><span class="status-btn-label">${escapeHtml(opt.label)}</span>${countHtml}</button>`;
  }).join("");
}

function renderWorkSplit(split = workSplitData) {
  workSplitData = split;
  const warning = split?.warning || (split?.activeReviewRequired ? "More than eight genuinely active workers: review concurrent implementation slices." : "");
  for (const node of [$("#overview-state"), $("#work-state")]) {
    if (!node) continue;
    node.textContent = warning;
    node.classList.toggle("hidden", !warning);
  }
  const state = $("#work-state");
  if (!split) {
    state.classList.remove("hidden");
    state.textContent = "Work split unavailable: connect a readable Firstmate home.";
    $("#tight-work").innerHTML = "";
    $("#large-work").innerHTML = "";
    $("#large-count").textContent = "";
    const phaseBtns = $("#work-phase-buttons");
    if (phaseBtns) phaseBtns.innerHTML = "";
    return;
  }
  if (split.items) {
    const repositories = new Map(split.items.map((item) => [item.repositoryId, item.repository]));
    if (workRepository !== "all" && !repositories.has(workRepository)) workRepository = "all";
    $("#work-repository").innerHTML = '<option value="all">All repositories</option>' + [...repositories].map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
    $("#work-repository").value = workRepository;
    const choices = Object.keys(statusLabels);
    $("#work-phase").innerHTML = '<option value="all">All phases</option>' + choices.map((status) => `<option value="${status}">${escapeHtml(statusLabels[status])}</option>`).join("");
    $("#work-phase").value = workPhase;
    const counts = statusCounts(split.items);
    renderStatusFilterButtons($("#work-phase-buttons"), [
      { value: "all", label: "All", fullLabel: "All phases", count: split.items.length },
      ...choices.map((status) => ({
        value: status,
        label: (statusConciseLabels && statusConciseLabels[status]) || statusLabels[status],
        fullLabel: statusLabels[status],
        count: counts[status]
      }))
    ], workPhase);
    const items = split.items.filter((item) => (workRepository === "all" || item.repositoryId === workRepository) && (workPhase === "all" || item.status === workPhase || item.completionAttention === workPhase));
    $("#tight-work").innerHTML = hierarchyHtml(items, "work");
    $("#large-work").innerHTML = "";
    $("#large-count").textContent = "· included as slices above";
    const largeHeading = $("#large-work").previousElementSibling;
    if (largeHeading) largeHeading.hidden = true;
    return;
  }
  const buckets = [["backlog", "Backlog"], ["inProgress", "In progress"], ["justLanded", "Just landed"]];
  const all = [...buckets.flatMap(([key]) => split.tight[key].items), ...split.large.projects];
  const repositories = new Map(all.map((item) => [workRepositoryKey(item), item.repository || "Repository unassigned"]));
  const choices = [...repositories].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  if (workRepository !== "all" && !repositories.has(workRepository)) workRepository = "all";
  $("#work-repository").innerHTML = '<option value="all">All repositories</option>' + choices.map(([key, name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`).join("");
  $("#work-repository").value = workRepository;
  $("#work-group-by").value = workGroupBy;
  $("#work-phase").innerHTML = '<option value="all">All phases</option>' + buckets.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join("");
  $("#work-phase").value = workPhase;
  renderStatusFilterButtons($("#work-phase-buttons"), [
    { value: "all", label: "All", fullLabel: "All phases" },
    ...buckets.map(([key, label]) => ({
      value: key,
      label,
      fullLabel: label,
      count: split.tight[key]?.items?.length
    }))
  ], workPhase);
  const visible = (item, phase) => (workRepository === "all" || workRepositoryKey(item) === workRepository)
    && (workPhase === "all" || phase === workPhase);
  const groupHeading = (group) => `<h4>${escapeHtml(group.label)} <span>${group.items.length}</span></h4>`;
  $("#tight-work").innerHTML = buckets.filter(([key]) => workPhase === "all" || workPhase === key).map(([key, label]) => {
    const items = split.tight[key].items.filter((item) => visible(item, key));
    return `<article class="panel work-card"><h3>${label} <strong>${items.length}</strong></h3>${items.length
      ? workGroups(items).map((group) => `<section class="work-group" aria-label="${escapeHtml(group.label)}">${groupHeading(group)}<ul>${group.items.map((item) => `<li><span>${escapeHtml(item.name)}</span><small>${escapeHtml(item.id)}</small></li>`).join("")}</ul></section>`).join("")
      : '<p class="muted">None recorded.</p>'}</article>`;
  }).join("");
  const large = split.large.projects.filter((item) => visible(item, item.phase));
  $("#large-count").textContent = `· ${large.length}`;
  $("#large-work").innerHTML = large.length ? workGroups(large).map((group) => `
    <section class="work-group panel" aria-label="${escapeHtml(group.label)}">${groupHeading(group)}<div class="work-grid">${group.items.map((project) => `
      <article class="work-card"><h3>${escapeHtml(project.name)}</h3><small>${escapeHtml(project.id)}</small>
        <p><b>Stage:</b> ${escapeHtml(project.stage)}</p><p><b>Waiting on:</b> ${escapeHtml(project.waitingOn)}</p></article>`).join("")}</div></section>`).join("")
    : '<p class="empty panel">No large projects match these filters.</p>';
}

function renderProjects(projects = overviewProjects) {
  overviewProjects = projects;
  if (workSplitData?.items) {
    const choices = Object.keys(statusLabels);
    $("#overview-status").innerHTML = '<option value="all">All statuses</option>' + choices.map((status) => `<option value="${status}">${escapeHtml(statusLabels[status])}</option>`).join("");
    $("#overview-status").value = overviewStatus;
    const counts = statusCounts(workSplitData.items);
    renderStatusFilterButtons($("#overview-status-buttons"), [
      { value: "all", label: "All", fullLabel: "All statuses", count: workSplitData.items.length },
      ...choices.map((status) => ({
        value: status,
        label: (statusConciseLabels && statusConciseLabels[status]) || statusLabels[status],
        fullLabel: statusLabels[status],
        count: counts[status]
      }))
    ], overviewStatus);
    const rows = workSplitData.items.filter((item) => overviewStatus === "all" || item.status === overviewStatus || item.completionAttention === overviewStatus);
    $("#projects").innerHTML = hierarchyHtml(rows, "overview");
    return;
  }
  const statuses = new Set(projects.flatMap((project) => (project.items || []).map((item) => agentStatusGroup(item.state))));
  const choices = [...statuses].sort((a, b) => a === "active" ? -1 : b === "active" ? 1 : a.localeCompare(b));
  // Keep an in-use filter visible across refreshes even if its last agent disappears.
  if (overviewStatus !== "all" && !statuses.has(overviewStatus)) choices.push(overviewStatus);
  $("#overview-status").innerHTML = '<option value="all">All statuses</option>' + choices.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(stateLabel(status))}</option>`).join("");
  $("#overview-status").value = overviewStatus;
  renderStatusFilterButtons($("#overview-status-buttons"), [
    { value: "all", label: "All", fullLabel: "All statuses" },
    ...choices.map((status) => ({
      value: status,
      label: (statusConciseLabels && statusConciseLabels[status]) || stateLabel(status),
      fullLabel: stateLabel(status)
    }))
  ], overviewStatus);

  const visible = projects.map((project) => ({
    ...project,
    items: overviewStatus === "all" ? project.items || [] : (project.items || []).filter((item) => agentStatusGroup(item.state) === overviewStatus),
  })).filter((project) => overviewStatus === "all" || project.items.length);
  const ordered = visible.sort((a, b) => overviewSort === "activity"
    ? (overviewStatus === "all" ? b.agents - a.agents : b.items.length - a.items.length) || a.name.localeCompare(b.name)
    : a.name.localeCompare(b.name));
  if (!projects.length || !ordered.length) {
    $("#projects").innerHTML = `<div class="empty panel">${projects.length ? "No agents match this status." : "No project fleets are reporting yet."}</div>`;
    return;
  }
  $("#projects").innerHTML = ordered.map((project) => `
    <article data-review-id="project:${reviewId(project.id)}" class="project-card panel">
      <div class="project-head">
        <div><span class="project-dot ${escapeHtml(project.status)}"></span><strong>${escapeHtml(project.name)}</strong></div>
        <span class="state-chip">${escapeHtml(stateLabel(project.status))}</span>
      </div>
      <p class="lane-intent">${escapeHtml(project.intent || project.mission || "Fleet intent not recorded.")}</p>
      <div class="progress-label"><span>${overviewStatus === "all" ? `${escapeHtml(project.agents)} active` : `${project.items.length} matching agent${project.items.length === 1 ? "" : "s"}`}</span><span>${escapeHtml(project.progress)}%</span></div>
      <span class="progress"><i style="width:${Math.max(0, Math.min(100, Number(project.progress)))}%"></i></span>
      <div class="project-open-row">
        <button class="project-disclosure" type="button" data-toggle-project="${escapeHtml(project.id)}" aria-expanded="${overviewOpen.get(project.id) !== false}" aria-label="${overviewOpen.get(project.id) === false ? "Show" : "Hide"} tasks for ${escapeHtml(project.name)}">${overviewOpen.get(project.id) === false ? "Show tasks" : "Hide tasks"} · ${(project.items || []).length}</button>
        <button class="project-open" type="button" data-open-lane="${escapeHtml(project.id)}" aria-label="Open ${escapeHtml(project.name)} fleet">Open Fleet Chat →</button>
      </div>
      <ul ${overviewOpen.get(project.id) === false ? "hidden" : ""}>${(project.items || []).map((item) => `
        <li><button class="crew-task" type="button" data-open-lane="${escapeHtml(project.id)}" data-open-session="${escapeHtml(item.title)}" title="${escapeHtml(item.taskIntent || "Task intent not recorded.")}">
          <span><i class="task-state ${escapeHtml(item.state)}"></i><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(stateLabel(item.state))}</small></span>
          <span>${escapeHtml(item.taskIntent || "Task intent not recorded.")}</span>
        </button></li>
      `).join("")}</ul>
    </article>`).join("");
}

function renderExpenseRows() {
  const direction = expenseSort.direction === "asc" ? 1 : -1;
  const sorted = [...expenseEntries].sort((a, b) => {
    if (expenseSort.key === "amount") {
      const amountOrder = BigInt(a.amount.replace(".", "")) < BigInt(b.amount.replace(".", "")) ? -1
        : BigInt(a.amount.replace(".", "")) > BigInt(b.amount.replace(".", "")) ? 1 : 0;
      return amountOrder * direction || a.currency.localeCompare(b.currency);
    }
    return String(a[expenseSort.key] || "").localeCompare(String(b[expenseSort.key] || ""), undefined, { numeric: true }) * direction;
  });
  document.querySelectorAll("[data-expense-column]").forEach((heading) => {
    const active = heading.dataset.expenseColumn === expenseSort.key;
    heading.setAttribute("aria-sort", active ? (expenseSort.direction === "asc" ? "ascending" : "descending") : "none");
  });
  const sortLabel = ({ projectName: "project", description: "description / note", confidence: "confidence / basis" })[expenseSort.key] || expenseSort.key;
  $("#expense-sort-status").textContent = `Sorted by ${sortLabel} ${expenseSort.direction === "asc" ? "ascending" : "descending"}`;
  $("#expense-entries").innerHTML = sorted.length ? sorted.map((entry) => `
    <tr data-review-id="expense:${reviewId(entry.id || [entry.date, entry.projectId, entry.description].join(':'))}">
      <td><time datetime="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</time></td>
      <td><strong>${escapeHtml(entry.projectName)}</strong></td>
      <td><span class="category-chip">${escapeHtml(entry.category)}</span></td>
      <td class="numeric amount${entry.amount.startsWith("-") ? " credit" : ""}">${escapeHtml(entry.amount)}</td>
      <td>${escapeHtml(entry.currency)}</td>
      <td class="expense-description">${escapeHtml(entry.description)}</td>
      <td>${entry.confidence ? `<span class="confidence-label">${escapeHtml(entry.confidence)}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`).join("") : '<tr><td colspan="7" class="empty compact">No expenses recorded. Add entries to your selected private expense ledger.</td></tr>';
}

function renderExpenseBreakdown(selector, groups, emptyMessage) {
  $(selector).innerHTML = groups.length ? groups.map((group) => `
    <div class="expense-row" data-review-id="breakdown:${reviewId(`${selector}:${group.name}`)}">
      <span>${escapeHtml(group.name)}</span>
      <strong>${group.totals.map(money).map(escapeHtml).join(" · ")}</strong>
    </div>`).join("") : `<div class="empty compact">${emptyMessage}</div>`;
}

function renderExpenses(expenses) {
  $("#expense-source").textContent = expenses.source;
  $("#expense-source").classList.toggle("demo", expenses.demo);
  $("#entry-count").textContent = `${expenses.entryCount} ledger ${expenses.entryCount === 1 ? "entry" : "entries"}; currencies are not converted`;
  $("#overall-total").innerHTML = expenses.overall.length
    ? expenses.overall.map((total) => `<strong>${escapeHtml(money(total))}</strong>`).join("")
    : '<strong class="zero">—</strong>';
  renderExpenseBreakdown("#category-expenses", expenses.categories || [], "No category totals available.");
  renderExpenseBreakdown("#project-expenses", expenses.projects || [], "No project totals available.");
  expenseEntries = expenses.entries || [];
  renderExpenseRows();

  const notice = $("#expense-notice");
  notice.classList.toggle("hidden", !expenses.error && !expenses.demo);
  notice.textContent = expenses.error || (expenses.demo
    ? "Showing sample costs because the canonical expenses/ledger.json is not present. It will be used automatically when available."
    : "");
}

function renderCosts(data) {
  const cards = window.costViewModel.project(data);
  $("#cost-panels").innerHTML = cards.map((card) => `<article class="cost-card" data-review-id="cost:${card.id}">
    <h3>${escapeHtml(card.title)}</h3>
    <p class="cost-status" data-state="${escapeHtml(card.status)}">${escapeHtml(card.status)}${card.partial ? " · partial" : ""}${card.stale ? " · last-known snapshot" : ""}</p>
    ${card.reason ? `<p class="notice">${escapeHtml(card.reason)}</p>` : ""}
    <p>Captured at: ${card.capturedAt ? escapeHtml(new Date(card.capturedAt).toLocaleString()) : "Unknown"}${card.stale ? " · stale" : ""}</p>
    <p>Covered period: ${card.period ? `${escapeHtml(card.period.start)} – ${escapeHtml(card.period.end)} · ${escapeHtml(card.period.basis)}` : "Unknown"}</p>
    <dl>${card.rows.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
    ${card.breakdowns.map((group) => Array.isArray(group.items) ? `<details><summary>${escapeHtml(group.kind)} breakdown</summary><ul>${group.items.map((item) => `<li>${escapeHtml(item.name)} · ${escapeHtml(String(item.amount))} ${escapeHtml(item.currency)}</li>`).join("")}</ul></details>` : "").join("")}
    ${card.id === "github" && card.breakdowns.length ? `<details><summary>Reported repository / operating system usage</summary><ul>${card.breakdowns.map((item) => `<li>${escapeHtml(item.repository)} · ${escapeHtml(item.sku)} · ${escapeHtml(String(item.minutes))} minutes</li>`).join("")}</ul></details>` : ""}
  </article>`).join("");
}
let costsRefreshing = false;
async function refreshCosts() {
  if (costsRefreshing) return;
  costsRefreshing = true;
  try { renderCosts(await fetchJson("/api/costs")); }
  catch { renderCosts({}); }
  finally { costsRefreshing = false; }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function quotaName(value) {
  return String(value || "Unknown").replaceAll(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function quotaDuration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ${minutes % 60} min` : `${Math.floor(hours / 24)} days ${hours % 24} hr`;
}
function quotaPercent(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value}% remaining` : "Remaining unknown";
}
function formatQuotaReserve(value) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}% reserve`;
}

let lastRenderedQuotaJson = "";
let quotaReading = null;
let quotaAgeTimer = null;
let quotaHideInactive = false;
let quotaLowestFirst = false;
const quotaOpen = new Map();

function renderQuotaHtml(container, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const active = document.activeElement;
  const selection = window.getSelection?.();
  const selected = selection && (container.contains(selection.anchorNode) || container.contains(selection.focusNode))
    ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
  const key = (node) => node.nodeType === 1
    ? `${node.tagName}:${node.hasAttribute("data-quota-key") ? `key:${node.getAttribute("data-quota-key")}` : node.getAttribute("class")?.split(/\s+/)[0] || ""}` : node.nodeType;
  const sync = (parent, nextParent) => {
    const previous = [...parent.childNodes];
    [...nextParent.childNodes].forEach((next, index) => {
      const current = previous.find((node) => key(node) === key(next));
      if (!current) {
        parent.insertBefore(next, parent.childNodes[index] || null);
        return;
      }
      previous.splice(previous.indexOf(current), 1);
      if (current !== parent.childNodes[index]) parent.insertBefore(current, parent.childNodes[index] || null);
      if (current.nodeType === 3) {
        if (current.data !== next.data) current.data = next.data;
      } else {
        if (current.tagName === "DETAILS") next.open = current.open;
        for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
        for (const attribute of next.attributes) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
        sync(current, next);
      }
    });
    for (const node of previous) node.remove();
  };
  sync(container, template.content);
  if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  if (selected && selected[0]?.isConnected && selected[2]?.isConnected) {
    const length = (node) => node.nodeType === 3 ? node.length : node.childNodes.length;
    selection.setBaseAndExtent(selected[0], Math.min(selected[1], length(selected[0])), selected[2], Math.min(selected[3], length(selected[2])));
  }
}

function formatRelativeTime(isoString, now = Date.now()) {
  if (!isoString) return null;
  const target = Date.parse(isoString);
  if (!Number.isFinite(target)) return null;
  const diffMs = target - now;
  if (diffMs <= 0) return "reported reset time passed";
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  if (diffSec < 60) return `in ${diffSec}s`;
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffHours < 24) {
    return remMin > 0 ? `in ${diffHours}h ${remMin}m` : `in ${diffHours}h`;
  }
  const diffDays = Math.floor(diffHours / 24);
  const remHours = diffHours % 24;
  return remHours > 0 ? `in ${diffDays}d ${remHours}h` : `in ${diffDays}d`;
}

// Only reported effective scopes determine ordering. Unknown remains unknown and sorts last.
const { project: projectQuota, groups: quotaGroups, marker: quotaMarker, remaining: quotaRemaining, active: quotaActive, windowLabels: quotaWindowLabels, valid: validQuotaPercent } = window.quotaViewModel;

// Reuse the Quota page's sanitized reading; the strip never reads quota itself.
const quotaMarks = { ahead: "↗", on_pace: "→", behind: "↘", mixed: "◇", through_reset: "∞", projected_exhaustion: "⌛", exhausted_now: "×", unknown: "?" };
const quotaPaceLabels = { ahead: "ahead", on_pace: "on pace", behind: "behind", mixed: "mixed", unknown: "pace ?" };
const quotaRunwayLabels = { through_reset: "through reset", projected_exhaustion: "projected exhaustion", exhausted_now: "exhausted now", unknown: "runway ?" };

function quotaSignal(status, name, type) {
  const safe = Object.hasOwn(quotaMarks, status) ? status : "unknown";
  const labelMap = type === "pace" ? quotaPaceLabels : quotaRunwayLabels;
  const labelText = labelMap[safe] || safe;
  return `<span class="quota-signal" data-status="${safe}" aria-label="${name}: ${escapeHtml(labelText)}" title="${name}: ${escapeHtml(labelText)}"><i class="quota-icon" aria-hidden="true">${quotaMarks[safe]}</i><span class="quota-signal-label">${escapeHtml(labelText)}</span></span>`;
}
// Neutral text monograms, not provider artwork or an endorsement claim.
function providerLogoHtml(provider, { mono = false, size = 20 } = {}) {
  const label = String(provider || "Subscription");
  const letter = escapeHtml((label.trim()[0] || "?").toUpperCase());
  return `<span class="provider-monogram${mono ? " provider-logo--mono" : ""}" style="--logo-size:${size}px" aria-hidden="true">${letter}</span>`;
}
function compactQuotaReset(iso, now = Date.now(), shortened = false) {
  const remaining = Date.parse(iso) - now;
  if (!Number.isFinite(remaining)) return "reset unknown";
  if (remaining <= 0) return "reset passed";
  const minutes = Math.max(1, Math.round(remaining / 60000));
  if (shortened) { const unit = minutes >= 1440 ? "d" : minutes >= 60 ? "h" : "m"; const divisor = unit === "d" ? 1440 : unit === "h" ? 60 : 1; return `${Math.round(minutes / divisor * 10) / 10}${unit}`; }
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60) ? ` ${Math.floor(minutes % 1440 / 60)}h` : ""}`;
}
function quotaFamilyBox(family, readAt, { compact = false } = {}) {
  const windows = family.windows || [];
  const heading = escapeHtml(family.name);
  const labels = quotaWindowLabels(family);
  const mark = providerLogoHtml(family.provider, { mono: compact, size: compact ? 16 : 20 });
  return `<div data-quota-key="${escapeHtml(JSON.stringify([family.provider, family.scope]))}" class="quota-family${compact ? " quota-family-side" : ""}${windows.some(w => w.isLimiting) ? " quota-summary-window-limiting" : ""}" aria-label="${heading} quota windows">
    <div class="quota-family-title"><span class="quota-family-identity">${mark}<span class="provider-name">${escapeHtml(family.provider)}</span></span><b>${heading}</b>${family.stale ? `<span data-quota-key="freshness" class="quota-staleness"><i class="quota-stale-marker" aria-hidden="true">!</i>${escapeHtml(family.staleLabel || "stale · age unknown")}</span>` : family.reusedLabel ? `<span data-quota-key="freshness" class="quota-reused">${escapeHtml(family.reusedLabel)}</span>` : family.status && family.status !== "fresh" ? `<span data-quota-key="freshness" class="quota-status-pill" data-status="${escapeHtml(family.status)}">${escapeHtml(quotaName(family.status))}</span>` : ""}</div>
    ${windows.map((w, index) => {
      const name = escapeHtml(labels[index]);
      const known = validQuotaPercent(w.percentRemaining);
      const position = quotaMarker(w, readAt);
      const reset = w.resetsAt && Number.isFinite(Date.parse(w.resetsAt)) ? new Date(w.resetsAt).toLocaleString([], { dateStyle: "full", timeStyle: "long" }) : "unknown";
      const resetNow = Date.now();
      const inlineReset = compact ? ` · <span class="quota-reset-full">${escapeHtml(compactQuotaReset(w.resetsAt, resetNow, labels[index].length > 14))}</span><span class="quota-reset-short">${escapeHtml(compactQuotaReset(w.resetsAt, resetNow, true))}</span>` : "";
      const detail = `${w.label || quotaName(w.scope)}: ${quotaPercent(w.percentRemaining)}. Reset: ${reset}. ${position === null ? "Reset-window position unknown (source window boundaries unavailable or inconsistent)" : `${position.toFixed(1)}% of reset window remaining at source capture`}. Pace: ${w.pace?.status || "unknown"}. Runway: ${w.runway?.status || "unknown"}${w.isLimiting ? ". Source-reported limiting window" : ""}`;
      return `<div data-quota-key="${escapeHtml(w.id ?? w.scope)}" class="quota-family-row${!known ? " quota-family-unknown" : w.percentRemaining === 0 ? " quota-family-exhausted" : ""}" title="${escapeHtml(detail)}">
        <span class="quota-family-label" title="${escapeHtml(w.label || quotaName(w.scope))}" aria-label="${escapeHtml(w.label || quotaName(w.scope))}${compact ? `; reset ${escapeHtml(compactQuotaReset(w.resetsAt, resetNow))}` : ""}">${name}${inlineReset}${position === null ? '<span class="sr-only"> Reset-window position unknown.</span>' : ""}</span>
        <span class="quota-family-meter"><span class="quota-family-track${known ? "" : " quota-bar-unknown"}" role="${known ? "progressbar" : "img"}" aria-label="${escapeHtml(`${w.label || quotaName(w.scope)} percent remaining${known ? "" : " unknown"}`)}"${known ? ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w.percentRemaining}"` : ""}><span class="quota-family-fill" style="width:${known ? w.percentRemaining : 0}%"></span></span>${position === null ? "" : `<i class="quota-family-notch" style="--remaining:${position}%" role="img" aria-label="${position.toFixed(1)}% of reset window remaining at source capture"></i>`}</span>
        <strong class="quota-family-value" aria-label="${escapeHtml(detail)}">${known ? `${w.percentRemaining}%` : "?"}</strong>${w.resetsAt && reset !== "unknown" ? `<time class="sr-only" datetime="${escapeHtml(w.resetsAt)}">Reset ${escapeHtml(reset)}</time>` : '<span class="sr-only">Reset unknown</span>'}
      </div>`;
    }).join("")}</div>`;
}
function renderQuotaStrip(data, projection = projectQuota(data)) {
  const freshnessEl = $("#sidebar-quota-freshness");
  if (freshnessEl) {
    if (data.readAt) {
      const timeStr = new Date(data.readAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      renderQuotaHtml(freshnessEl, escapeHtml(`${data.stale ? "Stale · " : ""}${timeStr}`));
    } else {
      // H2 — single Unavailable treatment lives on the quota card, not the eyebrow
      renderQuotaHtml(freshnessEl, "");
    }
  }

  const items = projection.sidebar.map((family) => `<a data-quota-key="${escapeHtml(JSON.stringify([family.provider, family.scope]))}" href="#quota" class="quota-badge">${quotaFamilyBox(family, data.capturedAt === undefined ? data.readAt : data.capturedAt, { compact: true })}<span class="sr-only">Open Quota page</span></a>`);
  const empty = `<a href="#quota" class="quota-badge quota-badge-empty" title="${escapeHtml(data.error || "No linked subscription with known limits")}"><b>Quota</b><span class="quota-badge-percent">${data.error && !data.readAt ? "Unavailable" : "Unknown"}</span></a>`;
  const html = items.join("") || empty;
  const strip = $("#quota-strip");
  if (strip) renderQuotaHtml(strip, html);
  const sheet = $("#mobile-quota-sheet-content");
  const dockQuota = document.querySelector(".mobile-dock-quota");
  const families = projection.sidebar.slice(0, 4);
  const rows = families.map((family) => `<div data-quota-key="${escapeHtml(JSON.stringify([family.provider, family.scope]))}" class="mobile-quota-sheet-row">${quotaFamilyBox(family, data.capturedAt === undefined ? data.readAt : data.capturedAt, { compact: true })}</div>`).join("");
  if (sheet) {
    if (rows) {
      renderQuotaHtml(sheet, `<p class="quota-sheet-heading">Subscription usage</p>${rows}`);
    } else {
      const reason = data.error || "No linked subscription with known limits";
      renderQuotaHtml(sheet, `<p class="mobile-quota-sheet-empty" title="${escapeHtml(reason)}">Quota · n/a</p>`);
    }
  }
  if (dockQuota) {
    dockQuota.setAttribute("aria-label", rows ? "Quota snapshot" : "Quota · n/a");
  }
}

window.addEventListener("quota-sheet-ready", () => { if (quotaReading) renderQuotaStrip(quotaReading); });

function pacingExplanation(pace) {
  if (!pace || pace.status === "unknown") {
    return '<p class="quota-pacing-note"><span class="quota-signal" data-status="unknown"><i class="quota-icon">?</i> <span class="quota-signal-label">pace ?</span></span> Pace unknown: cycle or elapsed baseline unmeasured.</p>';
  }
  const descriptions = {
    ahead: "Consuming faster than elapsed-time pacing",
    on_pace: "Consuming in step with elapsed-time pacing",
    behind: "Consuming slower than elapsed-time pacing (reserve retained)",
    mixed: "Pacing varies across sub-metrics"
  };
  const desc = descriptions[pace.status] || pace.status;
  const reserve = typeof pace.reservePercentPoints === "number"
    ? ` (${formatQuotaReserve(pace.reservePercentPoints)})`
    : "";
  return `<p class="quota-pacing-note"><span class="quota-signal" data-status="${escapeHtml(pace.status)}"><i class="quota-icon">${quotaMarks[pace.status] || ""}</i> <span class="quota-signal-label">${escapeHtml(quotaName(pace.status))}</span></span> ${escapeHtml(desc)}${escapeHtml(reserve)}.</p>`;
}

// A small percentage alone does not establish a binding relationship. Only
// source-reported limiting IDs can name a limiting window.
function getCriticalConstraint(provider) {
  const critical = provider.critical;
  if (provider.stale) return { label: "Effective availability unknown", text: "Stale quota reading" };
  if (critical.kind === "source-limiting") return { label: "Source-reported limit", text: critical.windows.map((window) => window.label).join(", ") };
  if (critical.kind === "lowest-scope-binding-unknown") return { label: "Binding window unknown · Lowest effective scope", text: quotaName(critical.scope.scope) };
  return { label: "Binding limit unknown", text: "No source-reported limiting window" };
}

function renderQuota(data) {
  const state = $("#quota-state");
  const reading = data.readAt ? `Quota source last read ${new Date(data.readAt).toLocaleString()}.` : "No quota source reading available.";
  renderQuotaHtml(state, escapeHtml(`${data.stale ? "Stale last successful reading. " : ""}${reading}${data.error ? ` ${data.error}.` : ""}`));
  quotaReading = data;
  if (!quotaAgeTimer && typeof window !== "undefined" && window.setInterval) {
    quotaAgeTimer = window.setInterval(() => { if (quotaReading) renderQuota(quotaReading); }, 15000);
  }
  const providers = data.providers || [];
  const projection = projectQuota(data, { hideInactive: quotaHideInactive, lowestFirst: quotaLowestFirst, now: Date.now() });
  renderQuotaStrip(data, projection);

  const container = $("#quota-providers");
  const currentJson = JSON.stringify([projection.detail.map(({ ageMs, ...provider }) => provider), projection.inactive, data.readAt, data.stale, data.error, quotaHideInactive, quotaLowestFirst, [...quotaOpen.entries()]]);
  if (lastRenderedQuotaJson === currentJson && container && (container.innerHTML || container.children?.length)) {
    return;
  }

  lastRenderedQuotaJson = currentJson;

  const date = (value) => value ? `<time datetime="${escapeHtml(value)}" title="${escapeHtml(value)}">${escapeHtml(new Date(value).toLocaleString([], { dateStyle: "full", timeStyle: "long" }))}</time>` : "Reset unknown";
  const bar = (value, label = "Remaining") => validQuotaPercent(value)
    ? `<div class="quota-bar" role="progressbar" aria-label="${escapeHtml(label)}: percent remaining (filled bar)" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span style="width:${value}%"></span></div>` : '<div class="quota-bar quota-bar-unknown" aria-label="Remaining unknown"></div>';
  const pace = (value) => value && value.status !== "unknown" ? ` · Pace: ${escapeHtml(quotaName(value.status))}${typeof value.reservePercentPoints === "number" ? ` (${formatQuotaReserve(value.reservePercentPoints)})` : ""}` : " · Pace unknown";

  if (!providers.length) {
    renderQuotaHtml(container, '<p class="notice">Quota unavailable. No limits are known.</p>');
    return;
  }

  const { detail: activeProviders, inactive: unconfiguredProviders } = projection;

  const renderActiveCard = (provider) => {
    const isOpen = quotaOpen.has(provider.provider) ? quotaOpen.get(provider.provider) : true;
    const critical = getCriticalConstraint(provider);
    const limitingSet = new Set(provider.windows.filter((window) => window.isLimiting).map((window) => window.id));

    return `
      <details data-quota-key="${escapeHtml(provider.provider)}" class="quota-card quota-accordion${provider.stale ? " quota-card-stale" : ""}" data-review-id="quota:${reviewId(provider.provider)}" data-provider="${escapeHtml(provider.provider)}"${isOpen ? " open" : ""}>
        <summary class="quota-accordion-summary">
          <div class="quota-summary-heading">
            ${providerLogoHtml(provider.provider, { mono: false, size: 22 })}
            <h2>${escapeHtml(provider.provider)}</h2>
            ${provider.stale ? `<span data-quota-key="freshness" class="quota-staleness"><i class="quota-stale-marker" aria-hidden="true">!</i>${escapeHtml(provider.staleLabel || "stale · age unknown")}</span>` : provider.reusedLabel ? `<span data-quota-key="freshness" class="quota-reused">${escapeHtml(provider.reusedLabel)}</span>` : provider.status !== "fresh" ? `<span data-quota-key="freshness" class="quota-status-pill" data-status="${escapeHtml(provider.status)}">${escapeHtml(quotaName(provider.status))}</span>` : ""}
          </div>
          <div class="quota-summary-constraint"><span class="quota-critical-label">${escapeHtml(critical.label)}</span> ${escapeHtml(critical.text)}</div>
          <div class="quota-summary-windows" aria-label="Reported quota windows; filled bars show percent remaining, not percent used or elapsed time">
            ${provider.windows.length ? quotaGroups(provider).map((family) => quotaFamilyBox({ ...family, status: provider.status, stale: provider.stale, staleLabel: provider.staleLabel, reusedLabel: provider.reusedLabel, windows: family.windows.map((w) => ({ ...w, stale: provider.stale })) }, data.capturedAt === undefined ? data.readAt : data.capturedAt)).join("") : '<span class="quota-meta">No subscription windows reported.</span>'}
          </div>
        </summary>
        <div class="quota-accordion-content">
          ${provider.stale || provider.quotaStatus !== "known" ? `<p class="quota-meta">Quota: ${escapeHtml(quotaName(provider.quotaStatus))}${provider.stale ? ` · ${escapeHtml(provider.staleLabel || "stale · age unknown")} · effective unknown` : ""}</p>` : ""}
          ${provider.unresolvedWindowIds?.length ? `<p class="quota-unresolved">Unresolved windows: ${escapeHtml(provider.unresolvedWindowIds.join(", "))}</p>` : ""}

          ${provider.scopes?.length ? `
            <div data-quota-key="scopes" class="quota-group">
              <h3 class="quota-group-heading">Effective Scopes</h3>
              ${provider.scopes.map((scope) => `
                <section data-quota-key="${escapeHtml(scope.scope)}" class="quota-scope">
                  <div class="quota-row-head">
                    <h3>${escapeHtml(quotaName(scope.scope))}</h3>
                    <span class="quota-head-percent">${quotaPercent(scope.percentRemaining)}</span>
                  </div>
                  <p>${provider.stale ? "Effective availability unknown" : escapeHtml(quotaName(scope.status))}${pace(scope.pace)}</p>
                  ${bar(scope.percentRemaining, scope.scope)}
                  <p>Reported bounds: ${scope.boundedBy?.length ? escapeHtml(scope.boundedBy.map(quotaName).join(", ")) : "Unknown"} · Source-reported limits: ${scope.limitingWindowIds?.length ? escapeHtml(scope.limitingWindowIds.map(quotaName).join(", ")) : "Unknown"}</p>
                  <p>Runway: ${escapeHtml(quotaName(scope.runway?.status))}${quotaDuration(scope.runway?.seconds) ? ` · ${quotaDuration(scope.runway.seconds)}` : ""}${scope.runway?.exhaustedAt ? ` · Projected exhaustion: ${date(scope.runway.exhaustedAt)}` : ""}</p>
                </section>
              `).join("")}
            </div>` : "<p>Effective scope unavailable or unknown.</p>"}

          ${provider.windows?.length ? `
            <div data-quota-key="windows" class="quota-group">
              <h3 class="quota-group-heading">Quota Windows</h3>
              ${provider.windows.map((window) => {
                const isLimiting = limitingSet.has(window.id);
                const relReset = window.resetsAt ? formatRelativeTime(window.resetsAt) : null;
                return `
                  <section data-quota-key="${escapeHtml(window.id)}" class="quota-window${isLimiting ? " quota-window-limiting" : ""}">
                    <div class="quota-row-head">
                      <h3>${escapeHtml(window.label)} <small>(${escapeHtml(window.kind)})</small></h3>
                      <span class="quota-head-percent">${quotaPercent(window.percentRemaining)}</span>
                    </div>
                    <p>${provider.scopes.some((scope) => scope.boundedBy?.includes(window.id)) ? "Effective scope bound" : "Not established as an effective scope bound"}</p>
                    <p>Reset: ${date(window.resetsAt)}${relReset ? ` (${relReset})` : ""}${window.annotation ? ` · Note: ${escapeHtml(quotaName(window.annotation.category))} — ${escapeHtml(window.annotation.meaning)}` : ""}${pace(window.pace)}</p>
                    ${bar(window.percentRemaining, window.label)}
                    ${pacingExplanation(window.pace)}
                  </section>`;
              }).join("")}
            </div>` : "<p>No subscription windows reported.</p>"}
        </div>
      </details>`;
  };

  const activeHtml = activeProviders.map(renderActiveCard).join("");
  const unconfiguredHtml = unconfiguredProviders.length ? `
    <div class="quota-unconfigured-tray">
      <h3 class="quota-unconfigured-title">Unconfigured / Setup Required (${unconfiguredProviders.length})</h3>
      <div class="quota-unconfigured-grid">
        ${unconfiguredProviders.map((provider) => `
          <div data-quota-key="${escapeHtml(provider.provider)}" class="quota-card quota-card-compact" data-review-id="quota:${reviewId(provider.provider)}">
            <h2 class="quota-card-heading">${providerLogoHtml(provider.provider, { mono: false, size: 20 })}<span>${escapeHtml(provider.provider)}</span></h2>
            <p>${escapeHtml(provider.status)}${provider.quotaStatus && provider.quotaStatus !== provider.status ? ` · ${escapeHtml(provider.quotaStatus)}` : ""}</p>
          </div>
        `).join("")}
      </div>
    </div>` : "";

  renderQuotaHtml(container, activeHtml + unconfiguredHtml || '<p class="notice">No active subscriptions reported. Remaining capacity is unknown.</p>');
}

function renderPreferences(data) {
  const state = $("#preferences-state");
  const list = $("#preferences-list");
  if (data.error) {
    state.textContent = data.error;
    if (!preferenceEntries.length) list.innerHTML = "";
    return;
  }
  preferenceEntries = data.entries;
  $("#preferences-source").textContent = data.source;
  state.textContent = `${data.entries.length} recorded behaviors${data.withheld ? ` · ${data.withheld} withheld for safety` : ""}. Evidence and date added are independent; unknown is not inferred.`;
  renderPreferenceList();
}

function renderPreferenceList() {
  const entries = [...preferenceEntries];
  if (preferenceSort !== "source") entries.sort((a, b) => {
    // Missing dates remain last in either direction; ties retain source order.
    if (!a.date) return b.date ? 1 : 0;
    if (!b.date) return -1;
    return preferenceSort === "newest" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  });
  $("#preferences-list").className = `preferences-list density-${preferenceDensity}`;
  $("#preferences-list").innerHTML = entries.map((entry) => `
    <details class="preference-card" data-review-id="preference:${reviewId(entry.source)}" data-preference="${escapeHtml(entry.source)}" ${preferenceOpen.get(entry.source) ?? (preferenceDensity !== "titles") ? "open" : ""}>
      <summary><h2>${escapeHtml(entry.title)}</h2><span class="preference-date">Evidence: ${entry.date ? `${escapeHtml(entry.date)} · ${escapeHtml(entry.dateBasis)}` : "Unknown"}<br>Date added: ${entry.addedAt ? escapeHtml(entry.addedAt) : "Unknown"}</span></summary>
      <div class="preference-meta"><strong>Reason / use case</strong><p>${entry.rationale ? escapeHtml(entry.rationale) : "Not separately stated in this record."}</p>${entry.rationaleBasis ? `<small>${escapeHtml(entry.rationaleBasis)}</small>` : ""}</div>
      <div class="preference-content" aria-label="Full recorded behavior and boundaries">${escapeHtml(entry.content)}</div>
      <small class="preference-provenance"><a class="preference-source-link" href="#preferences" title="Firstmate home record in ${escapeHtml(entry.source)}">Source: ${escapeHtml(entry.source)}</a></small>
    </details>`).join("") || '<p class="notice">No recorded preference sections found.</p>';
}

const freshness = Object.fromEntries(["dashboard", "quota", "lanes"].map((key) => [key, {
  lastSuccess: null, refreshing: false, duration: null, error: null, stale: false, started: null,
}]));
const freshLabels = { dashboard: "Overview", quota: "Quota", lanes: "Fleet Chats" };
let refreshMs = 0;
function activeFreshnessKey() {
  const view = $(".workspace").dataset.view;
  return view === "conversations" || view === "closed" ? "lanes" : view === "quota" ? "quota" : "dashboard";
}
function renderFreshness() {
  const key = activeFreshnessKey();
  const item = freshness[key];
  const expired = item.lastSuccess && Date.now() - item.lastSuccess > Math.max(60000, 2 * refreshMs);
  const condition = item.error ? "disconnected" : item.stale || expired ? "stale" : item.refreshing ? "refreshing" : item.lastSuccess ? "fresh" : "waiting";
  const last = item.lastSuccess ? `Last success ${new Date(item.lastSuccess).toLocaleString()}` : "No successful reading yet";
  const duration = item.refreshing ? ` · running ${((Date.now() - item.started) / 1000).toFixed(1)}s` : item.duration === null ? "" : ` · ${item.duration}ms`;
  const el = $("#view-freshness");
  el.dataset.state = condition;
  el.textContent = `${freshLabels[key]} · ${condition} · ${last}${duration}${item.error ? ` · ${item.error}` : ""}`;
  el.title = el.textContent;
  const pill = $("#fleet-state");
  pill.classList.toggle("offline", condition === "disconnected" || condition === "stale");
  $("#fleet-state b").textContent = `${freshLabels[key]} ${condition}`;
}

function lanesQuery() {
  const params = new URL("http://localhost/api/lanes").searchParams;
  if (taskOlderPages) params.set("older", taskOlderPages);
  if (diskOlderPages) params.set("diskOlder", diskOlderPages);
  for (const id of [...new Set([selectedSessionId, ...retainedSessions].filter(Boolean))].slice(0, 60)) params.append("session", id);
  for (const id of [...new Set([selectedTranscriptSession, ...retainedDisk].filter(Boolean))].slice(0, 60)) params.append("disk", id);
  return params.size ? `?${params}` : "";
}
let automaticHistoryKey = "", automaticHistoryAttempts = 0;
function requestLanes(automatic = false) {
  const key = `${selectedSessionId || ""}\n${selectedTranscriptSession || ""}`;
  if (!automatic || key !== automaticHistoryKey) { automaticHistoryKey = key; automaticHistoryAttempts = 0; }
  if (automatic && ++automaticHistoryAttempts > 2) {
    $("#transcript-note").textContent += " Selected history could not be loaded. Use Refresh to retry; automatic retries stopped.";
    return;
  }
  if (freshness.lanes.refreshing) pendingLanesRefresh = true;
  else void refreshEndpoint("lanes");
}

// Each endpoint owns its own in-flight guard and clock. A slow history response
// must not hold the fleet or quota render, nor launch duplicate history reads.
async function refreshEndpoint(key) {
  const item = freshness[key];
  if (item.refreshing) return;
  item.refreshing = true;
  item.started = Date.now();
  renderFreshness();
  try {
    const laneQuery = key === "lanes" ? lanesQuery() : "";
    const data = await fetchJson(`/api/${key === "dashboard" ? "dashboard" : key}${laneQuery}`);
    if (key === "lanes" && laneQuery !== lanesQuery()) { pendingLanesRefresh = true; return; }
    if (key === "dashboard") {
      renderSummary(data.fleet.summary);
      renderWorkSplit(data.fleet.workSplit);
      renderProjects(data.fleet.projects);
      renderExpenses(data.expenses);
      $("#fleet-source").textContent = data.fleet.source;
      if (data.refreshMs && !refreshTimer) {
        refreshMs = data.refreshMs;
        refreshTimer = window.setInterval(loadDashboard, refreshMs);
      }
    } else if (key === "quota") {
      renderQuota(data);
      item.stale = Boolean(data.stale || data.error);
      item.error = data.error || null;
    } else {
      if (taskOlderPages) for (const lane of data.lanes) for (const session of lane.sessions) if (session.loaded && retainedSessions.size < 60) retainedSessions.add(session.id);
      if (diskOlderPages) for (const session of data.transcript.sessions) if (session.loaded && retainedDisk.size < 60) retainedDisk.add(session.id);
      renderLanes(data);
    }
    if (key !== "quota" || !data.error) item.error = null;
    if (key !== "quota" || !data.error) item.stale = false;
    if (key !== "quota" || data.readAt) item.lastSuccess = key === "quota" ? new Date(data.readAt).getTime() : Date.now();
  } catch (error) {
    item.error = error.message;
    if (key === "dashboard") {
      if (!item.lastSuccess) {
        $("#projects").innerHTML = `<div class="notice">Could not load fleet: ${escapeHtml(error.message)}</div>`;
        renderWorkSplit(null);
      }
    } else if (key === "quota" && !item.lastSuccess) renderQuota({ providers: [], readAt: null, stale: false, error: "Quota unavailable" });
    else if (key === "lanes" && !item.lastSuccess) renderLanesError(error.message);
  } finally {
    item.duration = Date.now() - item.started;
    item.refreshing = false;
    renderFreshness();
    if (key === "lanes" && pendingLanesRefresh) {
      pendingLanesRefresh = false;
      void refreshEndpoint("lanes");
    }
  }
}

let preferencesRefreshing = false;
async function refreshPreferences() {
  if (preferencesRefreshing) return;
  preferencesRefreshing = true;
  try { renderPreferences(await fetchJson("/api/preferences")); }
  catch (error) { renderPreferences({ error: error.message }); }
  finally { preferencesRefreshing = false; }
}
function loadDashboard() {
  // Manual and timer refreshes may coincide; the endpoint guards prevent overlap.
  const active = activeFreshnessKey();
  void refreshEndpoint("dashboard");
  void refreshEndpoint("quota");
  if ($(".workspace").dataset.view === "expenses") void refreshCosts();
  if (active === "lanes") void refreshEndpoint("lanes");
  if ($(".workspace").dataset.view === "preferences") void refreshPreferences();
}
function ensureViewData(view) {
  renderFreshness();
  if ((view === "conversations" || view === "closed") && !freshness.lanes.lastSuccess) void refreshEndpoint("lanes");
  if (view === "preferences" && !preferenceEntries.length) void refreshPreferences();
  if (view === "expenses") void refreshCosts();
}

function contextIsDrawer() {
  return window.matchMedia?.("(max-width: 1200px)").matches || false;
}

function setContextDrawer(open) {
  const workspace = document.querySelector(".workspace");
  const toggle = $("#context-toggle");
  const rail = $("#context-rail");
  workspace.classList.toggle("context-open", Boolean(open));
  toggle.setAttribute("aria-expanded", String(Boolean(open)));
  rail.setAttribute("aria-hidden", String(contextIsDrawer() && !open));
  if (open) rail.focus?.();
  else if (document.activeElement === $("#context-close")) toggle.focus?.();
}

function showView(view, closedLaneId = null, { updateRoute = true } = {}) {
  feedLaneOverrideId = closedLaneId;
  document.querySelector(".workspace").dataset.view = view;
  const pageTitles = { overview: "Fleet at a glance", work: "Work split", conversations: "Fleet Chats", closed: "Closed fleets", expenses: "Expenses", quota: "Quota", preferences: "Preferences" };
  $("#shell-page-title").textContent = pageTitles[view] || "";
  document.querySelectorAll(".product-view").forEach((surface) => surface.classList.toggle("active", surface.id === `${view}-view`));
  document.querySelectorAll(".primary-tab").forEach((tab) => {
    const selected = tab.dataset.view === view || (view === "closed" && tab.dataset.view === "conversations");
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-pressed", String(selected));
  });
  if (view !== "conversations") setContextDrawer(false);
  if (updateRoute) setRoute(view === "conversations" ? conversationRoute() : `#${view}`);
  ensureViewData(view);
}

function navigateToLane(laneId, sessionId = "", { updateRoute = true } = {}) {
  const lane = lanes.find((candidate) => candidate.id === laneId);
  if (!lane) {
    if (!hasLoadedLanes && updateRoute) {
      setRoute(conversationRoute(laneId, sessionId));
      showView("conversations", null, { updateRoute: false });
      return false;
    }
    if (updateRoute) setRoute("#overview");
    showView("overview", null, { updateRoute: false });
    return false;
  }
  selectedSessionId = sessionId || null;
  if (sessionId && !lane.sessions.some((session) => session.id === sessionId && session.loaded)) requestLanes(true);
  if (lane.closed) {
    // History overrides the feed only; returning to live lanes retains both facets.
    showView("conversations", lane.id, { updateRoute: false });
  } else {
    feedLaneOverrideId = null;
    allLanesSelected = false;
    selectedLaneIds = new Set([lane.id]);
    renderLaneFilters();
    showView("conversations", null, { updateRoute: false });
  }
  renderFeed();
  if (updateRoute) setRoute(conversationRoute(lane.id, sessionId));
  return true;
}

function applyRoute({ isRefresh = false } = {}) {
  const route = parseRoute();
  if (route.view !== "conversations") {
    showView(route.view, null, { updateRoute: false });
    return;
  }
  if (route.laneId && lanes.length) {
    navigateToLane(route.laneId, route.sessionId, { updateRoute: false });
    return;
  }
  if (!isRefresh) {
    selectedSessionId = null;
    allLanesSelected = true;
    selectedLaneIds = new Set(liveLanes().map((lane) => lane.id));
    renderLaneFilters();
  }
  showView("conversations", null, { updateRoute: false });
  renderFeed();
}

const compactChatFilters = window.matchMedia?.("(max-width: 1200px)");
const roomyChatHeader = window.matchMedia?.("(min-width: 721px)");
const phoneChatFilters = window.matchMedia?.("(max-width: 720px)");
let mobileFilterTab = "lanes";
function setMobileFilterTab(tab, focus = false) {
  mobileFilterTab = tab;
  for (const [name, id] of [["lanes", "#mobile-lanes-tab"], ["kinds", "#mobile-kinds-tab"]]) {
    const button = $(id);
    button.setAttribute("aria-selected", String(tab === name));
    button.tabIndex = tab === name ? 0 : -1;
    if (focus && tab === name) button.focus();
  }
  for (const [name, panelId, tabId] of [["lanes", "#lane-filter-controls", "mobile-lanes-tab"], ["kinds", "#kind-filter-menu", "mobile-kinds-tab"]]) {
    const panel = $(panelId);
    panel.hidden = Boolean(phoneChatFilters?.matches && tab !== name);
    if (phoneChatFilters?.matches) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tabId);
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-labelledby");
    }
  }
}
for (const [name, id] of [["lanes", "#mobile-lanes-tab"], ["kinds", "#mobile-kinds-tab"]]) {
  $(id).addEventListener("click", () => setMobileFilterTab(name));
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setMobileFilterTab(name === "lanes" ? "kinds" : "lanes", true);
    }
  });
}
const desktopPanels = { lane: true, kind: true };
let keptDesktopPanel = "lane";
// Panels the user wants open may still render collapsed when the feed would drop below its minimum width.
function fittedDesktopPanels() {
  const width = $(".conversation-body")?.clientWidth;
  return width ? filterView.fitDesktopPanels(width, desktopPanels, keptDesktopPanel) : { ...desktopPanels };
}
function applyDesktopPanels() {
  const fitted = fittedDesktopPanels();
  setDesktopPanelExpanded("lane", fitted.lane, false);
  setDesktopPanelExpanded("kind", fitted.kind, false);
}
function setDesktopPanelExpanded(which, expanded, remember = true) {
  if (remember) desktopPanels[which] = expanded;
  if (remember && expanded) keptDesktopPanel = which;
  const panel = $(which === "lane" ? "#lane-options" : "#conversation-kind-panel");
  const toggle = $(which === "lane" ? "#lane-panel-toggle" : "#kind-panel-toggle");
  const name = which === "lane" ? "Included fleets" : "Message kinds";
  panel.dataset.collapsed = String(!expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${name} panel`);
  toggle.title = `${expanded ? "Collapse" : "Expand"} ${name} panel`;
  toggle.textContent = which === "lane" ? (expanded ? "‹" : "›") : (expanded ? "›" : "‹");
  if (which === "lane") {
    const shortcut = $("#conversation-filter-shortcut");
    shortcut.setAttribute("aria-expanded", String(expanded));
    shortcut.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} Included fleets panel`);
    shortcut.title = `${expanded ? "Collapse" : "Expand"} Included fleets panel`;
    if (expanded) panel.dataset.shortcutPreview = "false";
    const rail = $("#lane-collapsed-rail");
    if (rail) rail.hidden = expanded || Boolean(phoneChatFilters?.matches) || Boolean(compactChatFilters?.matches);
  }
}
function syncConversationFilterLayout() {
  const compact = compactChatFilters?.matches ?? false;
  const menu = $("#kind-filter-menu");
  const destination = phoneChatFilters?.matches ? $("#lane-options") : compact ? $(".feed-actions") : $("#conversation-kind-panel");
  if (destination?.appendChild && menu?.parentElement !== destination) {
    if (phoneChatFilters?.matches) destination.appendChild(menu);
    else if (compact) destination.insertBefore(menu, $(".feed-pagination")?.parentElement === destination ? $(".feed-pagination") : null);
    else destination.appendChild(menu);
  }
  if (!compact) {
    setLaneFiltersExpanded(true);
    applyDesktopPanels();
    menu?.setAttribute("open", "");
  } else {
    setLaneFiltersExpanded(false);
    $("#lane-options").dataset.shortcutPreview = "false";
    const phone = phoneChatFilters?.matches;
    $("#conversation-filter-shortcut").setAttribute("aria-label", phone ? "Open Fleet Chat options" : "Open fleet filters");
    $("#conversation-filter-shortcut").setAttribute("aria-expanded", "false");
    $("#conversation-filter-shortcut").title = phone ? "Context, sources, and pagination" : "Open fleet filters";
    menu?.removeAttribute("open");
  }
  if (phoneChatFilters?.matches) menu?.setAttribute("open", "");
  setMobileFilterTab(mobileFilterTab);
  const actions = $(".feed-actions");
  const actionDestination = roomyChatHeader?.matches ? $(".conversation-head") : $(".conversation-feed");
  if (actionDestination?.insertBefore && actions?.parentElement !== actionDestination) {
    const before = $(roomyChatHeader?.matches ? ".conversation-head-actions" : "#sr-announcer");
    actionDestination.insertBefore(actions, before?.parentElement === actionDestination ? before : null);
  }
}

function setLaneFiltersExpanded(expanded) {
  // Wide desktop lays the fleets panel out as a grid column (collapsed via data-collapsed), never hidden:
  // route changes elsewhere close the compact sheet, and a hidden column would squeeze the feed.
  if (!(compactChatFilters?.matches ?? true)) expanded = true;
  const toggle = $("#lane-filter-toggle");
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", phoneChatFilters?.matches ? (expanded ? "Close conversation filters" : "Open conversation filters") : (expanded ? "Collapse fleet filters" : "Expand fleet filters"));
  toggle.title = toggle.getAttribute("aria-label");
  $("#lane-options").hidden = !expanded;
}

function closeOpenPopovers() {
  document.querySelectorAll?.("details.transcript-coverage[open], details.kind-filter-menu[open]").forEach?.((details) => {
    if (!phoneChatFilters?.matches || !details.classList?.contains("kind-filter-menu")) {
      if (compactChatFilters?.matches || !details.classList?.contains("kind-filter-menu")) details.removeAttribute("open");
    }
  });
}

$("#lane-panel-toggle").addEventListener("click", () => { setDesktopPanelExpanded("lane", !fittedDesktopPanels().lane); applyDesktopPanels(); });
$("#kind-panel-toggle").addEventListener("click", () => { setDesktopPanelExpanded("kind", !fittedDesktopPanels().kind); applyDesktopPanels(); });
$("#lane-filter-toggle").addEventListener("click", () => {
  setLaneFiltersExpanded($("#lane-filter-toggle").getAttribute("aria-expanded") !== "true");
  if (phoneChatFilters?.matches && $("#lane-filter-toggle").getAttribute("aria-expanded") === "true") $(mobileFilterTab === "lanes" ? "#mobile-lanes-tab" : "#mobile-kinds-tab").focus();
});
const laneShortcut = $("#conversation-filter-shortcut");
let shortcutPreviewTimer;
function previewLaneShortcut() {
  if (compactChatFilters?.matches || fittedDesktopPanels().lane) return;
  clearTimeout(shortcutPreviewTimer);
  const rect = laneShortcut.getBoundingClientRect();
  const panel = $("#lane-options");
  panel.style?.setProperty("--lane-shortcut-left", `${Math.max(12, Math.min(rect.left, window.innerWidth - 292))}px`);
  panel.style?.setProperty("--lane-shortcut-bottom", `${rect.bottom + 4}px`);
  panel.dataset.shortcutPreview = "true";
}
function endLaneShortcutPreview() {
  clearTimeout(shortcutPreviewTimer);
  shortcutPreviewTimer = setTimeout(() => {
    const panel = $("#lane-options");
    if (!laneShortcut.matches?.(":hover, :focus-visible") && !panel.matches?.(":hover, :focus-within")) panel.dataset.shortcutPreview = "false";
  }, 150);
}
laneShortcut.addEventListener("pointerenter", previewLaneShortcut);
laneShortcut.addEventListener("pointerleave", endLaneShortcutPreview);
laneShortcut.addEventListener("focus", previewLaneShortcut);
laneShortcut.addEventListener("blur", endLaneShortcutPreview);
$("#lane-options").addEventListener("pointerleave", endLaneShortcutPreview);
$("#lane-options").addEventListener("focusout", endLaneShortcutPreview);
laneShortcut.addEventListener("click", () => {
  if (phoneChatFilters?.matches) {
    // S2: header identity owns Context / Sources / pagination (chat options).
    window.dispatchEvent(new CustomEvent("fm-open-chat-options"));
    return;
  }
  if (compactChatFilters?.matches) {
    setLaneFiltersExpanded(true);
    $("#lane-filter-toggle").focus();
  } else {
    setDesktopPanelExpanded("lane", !fittedDesktopPanels().lane);
    applyDesktopPanels();
    if (!fittedDesktopPanels().lane) previewLaneShortcut();
  }
});
$("#lane-filter-close").addEventListener("click", () => {
  setLaneFiltersExpanded(false);
  const lanesDock = document.querySelector('.mobile-dock [data-mobile-view="conversations"]');
  lanesDock?.setAttribute("aria-expanded", "false");
  (window.matchMedia?.("(max-width: 720px)")?.matches ? (lanesDock || laneShortcut) : $("#lane-filter-toggle")).focus();
});
window.addEventListener("fm-open-lane-filters", () => {
  setLaneFiltersExpanded(true);
  setMobileFilterTab(mobileFilterTab);
  $(mobileFilterTab === "lanes" ? "#mobile-lanes-tab" : "#mobile-kinds-tab")?.focus();
});
window.addEventListener("fm-close-lane-filters", () => setLaneFiltersExpanded(false));
$("#context-toggle").addEventListener("click", () => setContextDrawer($("#context-toggle").getAttribute("aria-expanded") !== "true"));
$("#context-close").addEventListener("click", () => setContextDrawer(false));
$("#context-backdrop").addEventListener("click", () => setContextDrawer(false));
document.addEventListener?.("click", (event) => {
  const openPopover = document.querySelector?.("details.transcript-coverage[open], details.kind-filter-menu[open]");
  if (!openPopover) return;
  if (!event.target?.closest?.("details.transcript-coverage") && !event.target?.closest?.("details.kind-filter-menu")) {
    closeOpenPopovers();
  }
});
document.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape") {
    if ($("#context-toggle")?.getAttribute("aria-expanded") === "true") setContextDrawer(false);
    if (compactChatFilters?.matches && $("#lane-filter-toggle").getAttribute("aria-expanded") === "true") {
      setLaneFiltersExpanded(false);
      (window.matchMedia?.("(max-width: 720px)")?.matches ? laneShortcut : $("#lane-filter-toggle")).focus();
    }
    closeOpenPopovers();
  }
});
$("#transcript-details")?.addEventListener?.("toggle", (event) => {
  if (event.target.open) {
    if (compactChatFilters?.matches) document.querySelector?.("details.kind-filter-menu[open]")?.removeAttribute("open");
  }
});
document.querySelector?.(".kind-filter-menu")?.addEventListener?.("toggle", (event) => {
  if (event.target.open) {
    document.querySelector?.("details.transcript-coverage[open]")?.removeAttribute("open");
  }
});
window.matchMedia?.("(max-width: 1200px)").addEventListener?.("change", () => setContextDrawer(false));
compactChatFilters?.addEventListener?.("change", syncConversationFilterLayout);
roomyChatHeader?.addEventListener?.("change", syncConversationFilterLayout);
syncConversationFilterLayout();
if (window.ResizeObserver && $(".conversation-body")) new ResizeObserver(() => { if (!compactChatFilters?.matches) applyDesktopPanels(); }).observe($(".conversation-body"));

function soloLane(laneId) {
  navigateToLane(laneId);
}

function applyLaneFilter(input) {
  if (input.matches("[data-filter-all]")) {
    allLanesSelected = input.checked;
    if (input.checked) {
      selectedLaneIds = new Set(liveLanes().map((lane) => lane.id));
    } else {
      selectedLaneIds = new Set();
    }
  } else if (input.dataset.filterLane) {
    if (allLanesSelected) {
      selectedLaneIds = new Set(liveLanes().map((lane) => lane.id));
    }
    if (input.checked) selectedLaneIds.add(input.dataset.filterLane);
    else selectedLaneIds.delete(input.dataset.filterLane);
    const live = liveLanes();
    allLanesSelected = live.length > 0 && live.every((lane) => selectedLaneIds.has(lane.id));
  } else return;
  renderLaneFilters();
  showView("conversations", null, { updateRoute: false });
  renderFeed();
  setRoute(conversationRoute(laneSelection().routeId));
}

function applyLaneBulk(selectAll) {
  if (liveLanes().length === 0) return;
  applyLaneFilter({ matches: (selector) => selector === "[data-filter-all]", checked: selectAll });
}
bindBulkToggle($("#lane-bulk-toggle"), applyLaneBulk);
$("#lane-filter-info")?.addEventListener("click", () => {
  const tip = $("#lane-filter-info-tip");
  const button = $("#lane-filter-info");
  if (!tip || !button) return;
  const open = tip.hidden;
  tip.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
});
$("#lane-filter-rows").addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement) applyLaneFilter(event.target);
});
$("#lane-filter-rows").addEventListener("click", (event) => {
  if (event.target.closest("input") || event.target.closest(".toggle-check")) {
    return;
  }
  const row = event.target.closest(".lane-option");
  if (!row) return;
  event.preventDefault();
  const laneId = row.dataset.laneId;
  if (!laneId) return;
  soloLane(laneId);
});
$("#lane-collapsed-rail")?.addEventListener("click", (event) => {
  const item = event.target.closest(".lane-rail-item");
  if (item?.dataset.filterAll === "true") { applyLaneBulk(true); return; }
  if (!item?.dataset.laneId) return;
  soloLane(item.dataset.laneId);
});

$("#lane-status").addEventListener("change", (event) => {
  laneStatusFilter = event.target.value;
  selectedSessionId = null;
  renderFeed();
  // Status cannot turn a multi-ID selection into a single-ID deep link.
  setRoute(conversationRoute(laneSelection().routeId));
});
$("#closed-lanes-link").addEventListener("click", () => showView("closed"));
$("#closed-back").addEventListener("click", () => {
  selectedSessionId = null;
  showView("conversations");
  renderFeed();
});
$("#closed-search").addEventListener("input", (event) => renderClosedLanes(event.target.value));
$("#closed-lane-list").addEventListener("click", (event) => {
  const control = event.target.closest("[data-closed-lane]");
  if (!control) return;
  navigateToLane(control.dataset.closedLane, control.dataset.closedSession || "");
});

$("#message-type-filters").addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.checked) selectedMessageTypes.add(input.value);
  else selectedMessageTypes.delete(input.value);
  savePreference(MESSAGE_TYPES_KEY, [...selectedMessageTypes]);
  renderMessageTypeFilters();
  renderFeed();
});
$("#transcript-session").addEventListener("change", (event) => {
  selectedTranscriptSession = event.target.value;
  if (selectedTranscriptSession && !transcriptCoverage.sessions.some((session) => session.id === selectedTranscriptSession && session.loaded)) requestLanes();
  if (selectedSessionId) clearTaskFilter();
  else renderFeed();
});
let searchDebounceTimer = null;
applyMessageFontSize(messageFontSize);
$("#font-size-decrease")?.addEventListener("click", () => stepMessageFontSize(-1));
$("#font-size-increase")?.addEventListener("click", () => stepMessageFontSize(1));
$("#transcript-search").addEventListener("input", (event) => {
  transcriptQuery = event.target.value;
  $("#transcript-search-clear").hidden = !transcriptQuery;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    renderFeed();
  }, 200);
});
function clearSearch() {
  clearTimeout(searchDebounceTimer);
  transcriptQuery = "";
  const searchInput = $("#transcript-search");
  if (searchInput) searchInput.value = "";
  const clearBtn = $("#transcript-search-clear");
  if (clearBtn) clearBtn.hidden = true;
  renderFeed();
}
$("#transcript-search-clear").addEventListener("click", clearSearch);
$("#messages").addEventListener("click", (event) => {
  if (event.target?.id === "search-empty-clear" || event.target?.closest?.("#search-empty-clear")) {
    clearSearch();
  }
});
$("#messages").addEventListener("scroll", () => {
  const messagesEl = $("#messages");
  const clientHeight = Number(messagesEl.clientHeight || 0);
  const scrollHeight = Number(messagesEl.scrollHeight || 0);
  const scrollTop = Number(messagesEl.scrollTop || 0);
  const isAtBottom = clientHeight > 0 ? (scrollHeight - scrollTop - clientHeight < 60) : true;
  const jumpBtn = $("#jump-to-latest");
  if (jumpBtn) jumpBtn.classList.toggle("hidden", isAtBottom);
});
$("#jump-to-latest")?.addEventListener("click", () => {
  const messagesEl = $("#messages");
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const jumpBtn = $("#jump-to-latest");
  if (jumpBtn) jumpBtn.classList.add("hidden");
});
$("#sessions-load-older").addEventListener("click", () => {
  taskOlderPages = Math.min(20, taskOlderPages + 1);
  requestLanes();
});
$("#disk-load-older").addEventListener("click", () => {
  diskOlderPages = Math.min(20, diskOlderPages + 1);
  requestLanes();
});
$("#transcript-older").addEventListener("click", () => {
  lastPageAnchor = "";
  transcriptPage = Math.max(0, transcriptPage - 1);
  renderFeed();
});
$("#transcript-newer").addEventListener("click", () => {
  lastPageAnchor = "";
  transcriptPage += 1;
  renderFeed();
});

function setAllMessageTypes() {
  selectedMessageTypes = new Set(MESSAGE_TYPES.map((type) => type.id));
  savePreference(MESSAGE_TYPES_KEY, [...selectedMessageTypes]);
  renderMessageTypeFilters();
  renderFeed();
}
function clearMessageTypes() {
  selectedMessageTypes.clear();
  savePreference(MESSAGE_TYPES_KEY, []);
  renderMessageTypeFilters();
  renderFeed();
}
bindBulkToggle($("#kinds-bulk-toggle"), (selectAll) => {
  if (selectAll) setAllMessageTypes();
  else clearMessageTypes();
});
$("#message-format-toggle").addEventListener("click", () => {
  messageFormat = messageFormat === "markdown" ? "raw" : "markdown";
  try { localStorage.setItem(MESSAGE_FORMAT_KEY, messageFormat); } catch { /* Preference is optional. */ }
  renderFeed();
});

$(".expense-table thead").addEventListener("click", (event) => {
  const button = event.target.closest("[data-expense-sort]");
  if (!button) return;
  const key = button.dataset.expenseSort;
  expenseSort = expenseSort.key === key
    ? { key, direction: expenseSort.direction === "asc" ? "desc" : "asc" }
    : { key, direction: key === "date" || key === "amount" ? "desc" : "asc" };
  renderExpenseRows();
});

function clearTaskFilter() {
  selectedSessionId = null;
  const laneId = feedLaneOverrideId || (selectedLanes().length === 1 ? selectedLanes()[0].id : "");
  setRoute(conversationRoute(laneId));
  renderFeed();
}

$("#session-history-list").addEventListener("click", (event) => {
  const session = event.target.closest("[data-session-id]");
  if (session) {
    navigateToLane(session.dataset.laneId, session.dataset.sessionId);
    return;
  }
  if (!event.target.closest(".session-clear")) return;
  clearTaskFilter();
});

$("#projects").addEventListener("click", (event) => {
  const control = event.target.closest("[data-open-lane]");
  if (!control) return;
  navigateToLane(control.dataset.openLane, control.dataset.openSession || "");
});

$("#task-filter-clear")?.addEventListener("click", clearTaskFilter);

document.querySelector(".primary-nav").addEventListener("click", (event) => {
  const tab = event.target.closest(".primary-tab");
  if (!tab) return;
  if (tab.dataset.view === "conversations") {
    selectedSessionId = null;
    feedLaneOverrideId = null;
    const onlyLane = selectedLanes().length === 1 ? selectedLanes()[0].id : "";
    setRoute(conversationRoute(onlyLane));
  }
  showView(tab.dataset.view);
  if (tab.dataset.view === "conversations") renderFeed();
});
$("#refresh").addEventListener("click", loadDashboard);
$("#quota-providers").addEventListener("toggle", (event) => {
  if (event.target.dataset?.provider) quotaOpen.set(event.target.dataset.provider, event.target.open);
}, true);
$("#quota-hide-inactive").addEventListener("change", (event) => {
  quotaHideInactive = event.target.checked;
  if (quotaReading) renderQuota(quotaReading);
});
$("#quota-order").addEventListener("click", () => {
  quotaLowestFirst = !quotaLowestFirst;
  const button = $("#quota-order");
  button.textContent = quotaLowestFirst ? "Lowest remaining first ↑" : "Highest remaining first ↓";
  button.setAttribute("aria-label", quotaLowestFirst ? "Sort by highest remaining first" : "Sort by lowest remaining first");
  button.setAttribute("aria-pressed", String(quotaLowestFirst));
  if (quotaReading) renderQuota(quotaReading);
});
function setQuotaAccordionsOpen(open) {
  for (const provider of (quotaReading?.providers || [])) quotaOpen.set(provider.provider, open);
  // Change the existing native disclosures directly. Re-rendering can be
  // skipped by the snapshot cache if a just-tapped <details> has not yet
  // dispatched its asynchronous toggle event to update quotaOpen.
  const details = $("#quota-providers")?.querySelectorAll("details.quota-accordion");
  if (details?.length) details.forEach((item) => { item.open = open; });
  else if (quotaReading) renderQuota(quotaReading);
}
$("#quota-expand-all")?.addEventListener("click", () => setQuotaAccordionsOpen(true));
$("#quota-collapse-all")?.addEventListener("click", () => setQuotaAccordionsOpen(false));
$("#preferences-density").addEventListener("change", (event) => {
  preferenceDensity = event.target.value;
  preferenceOpen.clear();
  renderPreferenceList();
});
$("#preferences-sort").addEventListener("change", (event) => { preferenceSort = event.target.value; renderPreferenceList(); });
for (const [id, open] of [["#preferences-expand", true], ["#preferences-collapse", false]]) {
  $(id).addEventListener("click", () => {
    for (const entry of preferenceEntries) preferenceOpen.set(entry.source, open);
    renderPreferenceList();
  });
}
$("#preferences-list").addEventListener("toggle", (event) => {
  if (event.target?.dataset?.preference) preferenceOpen.set(event.target.dataset.preference, event.target.open);
}, true);
$("#overview-sort").addEventListener("change", (event) => { overviewSort = event.target.value; renderProjects(); });
$("#work-group-by").addEventListener("change", (event) => { workGroupBy = event.target.value; renderWorkSplit(); });
$("#work-repository").addEventListener("change", (event) => { workRepository = event.target.value; renderWorkSplit(); });
$("#work-phase").addEventListener("change", (event) => { workPhase = event.target.value; renderWorkSplit(); });
$("#overview-status-buttons")?.addEventListener("click", (event) => {
  const button = event.target.closest(".status-filter-btn");
  if (!button) return;
  const val = button.dataset.statusValue;
  if (!val) return;
  overviewStatus = val;
  const sel = $("#overview-status");
  if (sel) sel.value = overviewStatus;
  renderProjects();
});
$("#work-phase-buttons")?.addEventListener("click", (event) => {
  const button = event.target.closest(".status-filter-btn");
  if (!button) return;
  const val = button.dataset.statusValue;
  if (!val) return;
  workPhase = val;
  const sel = $("#work-phase");
  if (sel) sel.value = workPhase;
  renderWorkSplit();
});
$("#overview-status").addEventListener("change", (event) => { overviewStatus = event.target.value; renderProjects(); });
for (const [id, open] of [["#overview-expand", true], ["#overview-collapse", false]]) {
  $(id).addEventListener("click", () => {
    for (const project of overviewProjects) overviewOpen.set(project.id, open);
    if (workSplitData?.items) for (const node of $("#projects").querySelectorAll("details[data-tree-key]")) hierarchyOpen.set(node.dataset.treeKey, open);
    renderProjects();
  });
}
$("#projects").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-project]");
  if (!button) return;
  const id = button.dataset.toggleProject;
  overviewOpen.set(id, overviewOpen.get(id) === false);
  renderProjects();
});
async function saveWorkPresentation(body, control) {
  const view = control.closest(".feature-view");
  const scroll = view?.scrollTop || 0;
  control.disabled = true;
  try {
    const response = await fetch("/api/work-state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Presentation change not saved");
    await refreshEndpoint("dashboard");
    requestLanes();
    if (view) { view.scrollTop = scroll; view.querySelector(`[data-task-fingerprint="${body.taskFingerprint}"] .work-inspection summary`)?.focus(); }
    $("#sr-announcer").textContent = body.action === "acknowledge" ? "Completion understood. Task and delivery status unchanged." : "Quarterdeck classification saved.";
  } catch (error) {
    $("#sr-announcer").textContent = error.message;
    const row = control.closest(".work-slice");
    if (row) { let message = row.querySelector(".work-save-state"); if (!message) { message = document.createElement("p"); message.className = "work-save-state notice"; message.setAttribute("role", "status"); row.append(message); } message.textContent = error.message; }
    control.disabled = false;
  }
}
for (const selector of ["#projects", "#tight-work"]) {
  $(selector).addEventListener("toggle", (event) => {
    if (!event.target.dataset?.treeKey) return;
    hierarchyOpen.set(event.target.dataset.treeKey, event.target.open);
    try { localStorage.setItem("fm-agentos-hierarchy-open.v1", JSON.stringify([...hierarchyOpen].slice(-1000))); } catch {}
  }, true);
  $(selector).addEventListener("click", (event) => {
    const button = event.target.closest("[data-ack-task]");
    if (button) void saveWorkPresentation({ action: "acknowledge", taskFingerprint: button.dataset.ackTask, completionFingerprint: button.dataset.ackCompletion }, button);
  });
  $(selector).addEventListener("submit", (event) => {
    const form = event.target.closest("[data-classify-task], [data-create-taxonomy]");
    if (!form) return;
    event.preventDefault();
    const fields = new FormData(form);
    const body = form.dataset.classifyTask ? (() => { const [laneId, themeId] = JSON.parse(fields.get("classification")); return { action: "classify", taskFingerprint: form.dataset.classifyTask, laneId, themeId }; })()
      : { action: "create-taxonomy", taskFingerprint: form.dataset.createTaxonomy, laneName: fields.get("laneName").trim(), themeName: fields.get("themeName").trim(), kind: fields.get("kind") };
    void saveWorkPresentation(body, form.querySelector("button"));
  });
}
window.setInterval?.(renderFreshness, 1000);
window.addEventListener("hashchange", (event) => {
  const next = event?.newURL ? new URL(event.newURL).hash : window.location.hash;
  const own = ownRouteChanges.indexOf(next);
  if (own !== -1) { ownRouteChanges.splice(own, 1); return; }
  applyRoute();
});
renderMessageTypeFilters();
applyRoute();
loadDashboard();
