// One app-shell interaction owner: disclosure on every viewport, width only on desktop.
import { SHELL_DEFAULT_WIDTH, SHELL_RESIZE_STEP, SHELL_WIDTH_KEY, savedShellWidth, shellWidth, shellWidthBounds } from "./shell-panel-layout.js";

const workspace = document.querySelector(".workspace");
const panel = document.querySelector("#review-sidebar-region");
const toggle = document.querySelector("#shell-panel-toggle");
const divider = document.querySelector("#shell-panel-resize");
const desktop = window.matchMedia("(min-width: 721px)");
const coarse = window.matchMedia("(pointer: coarse)");
let preferred = SHELL_DEFAULT_WIDTH;
try { preferred = savedShellWidth(localStorage.getItem(SHELL_WIDTH_KEY)) ?? preferred; } catch { /* Storage is optional. */ }
let drag = null;
let returnFocus = null;

function applyWidth(width = preferred) {
  const size = shellWidth(width, window.innerWidth);
  workspace.style.setProperty("--shell-nav-width", `${size}px`);
  const { min, max } = shellWidthBounds(window.innerWidth);
  const expanded = workspace.dataset.shellPanelCollapsed !== "true";
  divider.setAttribute("aria-valuemin", "0");
  divider.setAttribute("aria-valuemax", String(max));
  divider.setAttribute("aria-valuenow", expanded ? String(Math.round(size)) : "0");
  divider.setAttribute("aria-valuetext", expanded ? `Expanded, ${Math.round(size)} pixels; arrows resize, Enter or Space collapses` : `Collapsed; Enter or Space restores ${Math.round(size)} pixels`);
  return size;
}
function saveWidth(width) {
  preferred = shellWidth(width, window.innerWidth);
  applyWidth();
  try { localStorage.setItem(SHELL_WIDTH_KEY, String(preferred)); } catch { /* In-memory preference still works. */ }
}
function cancelDrag() {
  if (!drag) return;
  const { id, initial } = drag;
  drag = null;
  applyWidth(initial);
  if (divider.hasPointerCapture(id)) divider.releasePointerCapture(id);
}
function syncPanel() {
  const expanded = workspace.dataset.shellPanelCollapsed !== "true";
  const edgeHandle = desktop.matches && !coarse.matches;
  toggle.hidden = edgeHandle;
  toggle.setAttribute("aria-expanded", String(expanded));
  const label = `${expanded ? "Collapse" : "Expand"} navigation panel`;
  toggle.setAttribute("aria-label", label);
  toggle.querySelector(".sr-only").textContent = label;
  divider.dataset.expanded = String(expanded);
  divider.setAttribute("aria-label", `${label}; drag or arrow keys to resize when expanded`);
  divider.title = `${label} · click or Enter/Space · drag or arrows resize`;
  if (!expanded && desktop.matches && panel.contains(document.activeElement)) (edgeHandle ? divider : toggle).focus();
  // On phones the fixed review actions live in the same aside as the dock.
  // Hide the dock with CSS, but keep those accepted actions operable.
  panel.inert = !expanded && desktop.matches;
  divider.hidden = !edgeHandle;
  divider.tabIndex = edgeHandle ? 0 : -1;
  if (!edgeHandle) cancelDrag();
  applyWidth();
}

panel.addEventListener("focusin", (event) => { returnFocus = event.target; });
function togglePanel() {
  if (!desktop.matches) { openMobileTools(); return; }
  const collapsing = workspace.dataset.shellPanelCollapsed !== "true";
  if (collapsing && panel.contains(document.activeElement)) returnFocus = document.activeElement;
  workspace.dataset.shellPanelCollapsed = String(collapsing);
  syncPanel();
  if (!collapsing && returnFocus?.isConnected && panel.contains(returnFocus)) returnFocus.focus();
}
toggle.addEventListener("click", togglePanel);

divider.addEventListener("pointerdown", (event) => {
  if (divider.hidden || event.button !== 0 || drag) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, initial: applyWidth(), moved: false, expanded: workspace.dataset.shellPanelCollapsed !== "true" };
  divider.setPointerCapture(event.pointerId);
  event.preventDefault();
});
divider.addEventListener("pointermove", (event) => {
  if (drag?.id !== event.pointerId) return;
  if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6) drag.moved = true;
  if (drag.moved && drag.expanded) applyWidth(drag.initial + event.clientX - drag.x);
});
divider.addEventListener("pointerup", (event) => {
  if (drag?.id !== event.pointerId) return;
  const completed = drag;
  completed.moved ||= Math.hypot(event.clientX - completed.x, event.clientY - completed.y) >= 6;
  const width = completed.moved && completed.expanded ? applyWidth(completed.initial + event.clientX - completed.x) : Number(divider.getAttribute("aria-valuenow"));
  drag = null;
  if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  if (completed.moved) { if (completed.expanded) saveWidth(width); }
  else togglePanel();
});
// Assistive activation may issue a synthetic click without a pointer sequence.
divider.addEventListener("click", (event) => { if (event.detail === 0 && !divider.hidden) togglePanel(); });
divider.addEventListener("pointercancel", (event) => { if (drag?.id === event.pointerId) cancelDrag(); });
divider.addEventListener("lostpointercapture", () => cancelDrag());
divider.addEventListener("keydown", (event) => {
  if (divider.hidden) return;
  if (event.key === "Escape" && drag) { event.preventDefault(); cancelDrag(); return; }
  if (["Enter", " "].includes(event.key)) { event.preventDefault(); togglePanel(); return; }
  if (workspace.dataset.shellPanelCollapsed === "true") return;
  if (event.key === "Home") { event.preventDefault(); saveWidth(SHELL_DEFAULT_WIDTH); return; }
  const delta = { ArrowLeft: -SHELL_RESIZE_STEP, ArrowRight: SHELL_RESIZE_STEP }[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  saveWidth(Number(divider.getAttribute("aria-valuenow")) + delta);
});
window.addEventListener("resize", syncPanel);
desktop.addEventListener("change", syncPanel);
coarse.addEventListener("change", syncPanel);
syncPanel();

// Reuse the actual controls so drafts, selections and event handlers survive resizing.
const mobileDock = document.createElement("nav");
mobileDock.className = "mobile-dock";
mobileDock.setAttribute("aria-label", "Quick navigation");
const quotaGaugeSvg = '<svg class="mobile-quota-gauge" aria-hidden="true" viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5a8 8 0 0 1 15 0"/><path d="M12 16.5 17 10"/><circle cx="12" cy="16.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
mobileDock.innerHTML = `<button type="button" data-mobile-view="overview"><span aria-hidden="true">▦</span>Overview</button><button type="button" data-mobile-view="conversations" class="mobile-lanes" aria-haspopup="dialog" aria-controls="lane-options" aria-expanded="false" aria-label="Fleet; tap again for fleet and kind filters"><span aria-hidden="true">☷</span>Fleet</button><button type="button" class="mobile-dock-quota" aria-haspopup="dialog" aria-controls="mobile-quota-sheet" aria-expanded="false" aria-label="Quota · n/a"><span class="mobile-quota-mark" aria-hidden="true">${quotaGaugeSvg}</span><span class="mobile-dock-quota-label">Quota</span></button>`;
document.body.append(mobileDock);
const quotaSheet = document.createElement("dialog");
quotaSheet.className = "mobile-sheet mobile-quota-sheet";
quotaSheet.id = "mobile-quota-sheet";
quotaSheet.setAttribute("aria-labelledby", "mobile-quota-title");
quotaSheet.innerHTML = `<header class="mobile-sheet-head"><div><small>SUBSCRIPTION</small><h2 id="mobile-quota-title">Quota</h2></div><button type="button" class="mobile-sheet-close" aria-label="Close Quota">Close ×</button></header><div class="mobile-quota-sheet-body"><div id="mobile-quota-sheet-content" class="mobile-quota-sheet-content" aria-live="polite"><p class="mobile-quota-sheet-empty">Quota · n/a</p></div><a href="#quota" class="mobile-quota-full-link">View full Quota →</a></div>`;
document.body.append(quotaSheet);
window.dispatchEvent(new Event("quota-sheet-ready"));
const quotaDockButton = mobileDock.querySelector(".mobile-dock-quota");
// Non-modal so the quick-navigation dock remains interactive below the sheet.
const quotaBackdrop = document.createElement("div");
quotaBackdrop.className = "mobile-quota-backdrop";
quotaBackdrop.hidden = true;
document.body.append(quotaBackdrop);
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--mobile-dock-height", `${mobileDock.getBoundingClientRect().height}px`);
}).observe(mobileDock, { box: "border-box" });
quotaBackdrop.addEventListener("click", closeQuotaSheet);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && quotaSheet.open) {
    event.preventDefault();
    closeQuotaSheet();
  }
});
function openQuotaSheet() {
  if (desktop.matches) return;
  if (!quotaSheet.open) {
    quotaSheet.show();
    quotaBackdrop.hidden = false;
    quotaDockButton?.setAttribute("aria-expanded", "true");
  }
}
function closeQuotaSheet() {
  if (quotaSheet.open) quotaSheet.close();
  quotaBackdrop.hidden = true;
  quotaDockButton?.setAttribute("aria-expanded", "false");
}
quotaSheet.querySelector(".mobile-sheet-close").addEventListener("click", closeQuotaSheet);
quotaSheet.addEventListener("click", (event) => {
  if (event.target === quotaSheet || event.target.closest("a[href='#quota']")) closeQuotaSheet();
});
quotaSheet.addEventListener("close", () => {
  if (quotaSheet.open) return; // Ignore a queued close after a quick reopen.
  quotaBackdrop.hidden = true;
  quotaDockButton?.setAttribute("aria-expanded", "false");
  if (!desktop.matches && document.activeElement === document.body) quotaDockButton?.focus();
});
quotaDockButton?.addEventListener("click", () => {
  if (desktop.matches) return;
  if (quotaSheet.open) closeQuotaSheet();
  else {
    closeChatOptions();
    window.dispatchEvent(new CustomEvent("fm-close-lane-filters"));
    chatButton.setAttribute("aria-expanded", "false");
    openQuotaSheet();
  }
});
const toolsSheet = document.createElement("dialog");
toolsSheet.className = "mobile-sheet mobile-tools";
toolsSheet.id = "mobile-tools";
toolsSheet.setAttribute("aria-labelledby", "mobile-tools-title");
toolsSheet.innerHTML = `<header class="mobile-sheet-head"><div><small>YOUR WORKSPACE</small><h2 id="mobile-tools-title">Navigate & tools</h2></div><button type="button" class="mobile-sheet-close" aria-label="Close workspace tools">Close ×</button></header><div class="mobile-tools-body"></div>`;
document.body.append(toolsSheet);
const toolsBody = toolsSheet.querySelector(".mobile-tools-body");
const chatSheet = document.createElement("dialog");
chatSheet.className = "mobile-sheet mobile-chat-sheet";
chatSheet.id = "mobile-chat-options";
chatSheet.setAttribute("aria-labelledby", "mobile-chat-title");
chatSheet.innerHTML = '<header class="mobile-sheet-head"><h2 id="mobile-chat-title">Fleet Chat options</h2><button type="button" class="mobile-sheet-close" aria-label="Close Fleet Chat options">Close ×</button></header><div class="mobile-chat-body"></div>';
document.body.append(chatSheet);
const chatTools = chatSheet.querySelector(".mobile-chat-body");
chatTools.className = "mobile-chat-body mobile-chat-tools";
chatTools.addEventListener("click", (event) => {
  if (event.target.closest("#context-toggle, #jump-to-last-viewed, #jump-to-latest")) chatSheet.close();
}, true);
const chatButton = mobileDock.querySelector('[data-mobile-view="conversations"]');
const shortcutButton = () => document.querySelector("#conversation-filter-shortcut");
function openChatOptions() {
  if (desktop.matches) return;
  // The feed's responsive layout may relocate these controls after shell setup.
  // Rehome the same nodes immediately before opening, never duplicate their state.
  moveControl(document.querySelector(".conversation-head-actions"), chatTools);
  moveControl(document.querySelector(".feed-pagination"), chatTools);
  moveControl(document.querySelector(".feed-jump-controls"), chatTools);
  moveControl(document.querySelector("#transcript-window-status"), chatTools);
  if (!chatSheet.open) {
    chatSheet.showModal();
    shortcutButton()?.setAttribute("aria-expanded", "true");
  }
}
function closeChatOptions() {
  if (chatSheet.open) chatSheet.close();
}
chatSheet.querySelector(".mobile-sheet-close").addEventListener("click", () => chatSheet.close());
chatSheet.addEventListener("click", (event) => { if (event.target === chatSheet) chatSheet.close(); });
chatSheet.addEventListener("close", () => {
  if (chatSheet.open) return; // A quick reopen may precede the queued close event.
  chatButton.setAttribute("aria-expanded", "false");
  shortcutButton()?.setAttribute("aria-expanded", "false");
  if (!desktop.matches && document.activeElement === document.body) {
    chatButton?.focus();
  }
});
window.addEventListener("fm-open-chat-options", openChatOptions);
const placements = new Map();
function moveControl(node, destination, before = null) {
  if (!node || node.parentElement === destination) return;
  if (!placements.has(node)) {
    const anchor = document.createComment("mobile control home");
    node.before(anchor);
    placements.set(node, anchor);
  }
  destination.insertBefore(node, before);
}
// The shell owns both responsive placements: never duplicate reading state.
const readingToggle = document.querySelector('#header-reading-options-toggle');
const readingSheet = document.createElement('dialog');
readingSheet.id = 'header-reading-options';
readingSheet.className = 'header-reading-options';
readingSheet.setAttribute('aria-labelledby', 'header-reading-options-title');
readingSheet.innerHTML = '<header><h2 id="header-reading-options-title">Reading & paging</h2><button type="button" aria-label="Close reading options">Close ×</button></header><div class="reading-options-body"></div>';
document.body.append(readingSheet);
const readingBody = readingSheet.querySelector('.reading-options-body');
function syncReadingLayout() {
  const row = document.querySelector('.conversation-header-controls');
  const header = document.querySelector('.conversation-head');
  const overflow = desktop.matches && header.clientWidth > 0 && header.clientWidth < 950;
  row.dataset.readingOverflow = String(overflow);
  readingToggle.hidden = !overflow;
  if (!overflow && readingSheet.open) readingSheet.close();
  if (!desktop.matches) return; // Phone placements belong to chatTools below.
  for (const selector of ['.feed-jump-controls', '.feed-pagination']) {
    const node = document.querySelector(selector);
    if (overflow) moveControl(node, readingBody);
    else {
      const anchor = placements.get(node);
      if (anchor) { anchor.replaceWith(node); placements.delete(node); }
    }
  }
}
readingToggle.addEventListener('click', () => {
  syncReadingLayout();
  if (readingSheet.open) readingSheet.close();
  else { readingSheet.showModal(); readingToggle.setAttribute('aria-expanded', 'true'); }
});
readingSheet.querySelector('header button').addEventListener('click', () => readingSheet.close());
readingBody.addEventListener('click', event => {
  if (event.target.closest('#jump-to-last-viewed, #jump-to-latest, #transcript-older, #transcript-newer')) readingSheet.close();
}, true);
readingSheet.addEventListener('click', event => { if (event.target === readingSheet) readingSheet.close(); });
readingSheet.addEventListener('close', () => {
  readingToggle.setAttribute('aria-expanded', 'false');
  if (desktop.matches && !readingToggle.hidden && document.activeElement === document.body) readingToggle.focus();
});
function openMobileTools() {
  if (!toolsSheet.open) toolsSheet.showModal();
  toggle.setAttribute("aria-expanded", "true");
}
toolsSheet.querySelector(".mobile-sheet-close").addEventListener("click", () => toolsSheet.close());
toolsSheet.addEventListener("close", () => {
  if (!desktop.matches) toggle.setAttribute("aria-expanded", "false");
});
toolsSheet.addEventListener("click", (event) => {
  if (event.target === toolsSheet || event.target.closest(".primary-tab")) toolsSheet.close();
});
mobileDock.querySelectorAll("[data-mobile-view]").forEach((button) => {
  button.addEventListener("click", () => {
    closeQuotaSheet();
    // S2: bottom Lanes opens lane+kinds filters when already on conversations.
    if (button === chatButton && !desktop.matches && workspace.dataset.view === "conversations") {
      closeChatOptions();
      const open = document.querySelector("#lane-options")?.hidden === false;
      if (open) {
        window.dispatchEvent(new CustomEvent("fm-close-lane-filters"));
        chatButton.setAttribute("aria-expanded", "false");
      } else {
        closeQuotaSheet();
        window.dispatchEvent(new CustomEvent("fm-open-lane-filters"));
        chatButton.setAttribute("aria-expanded", "true");
      }
      return;
    }
    if (chatSheet.open) chatSheet.close();
    closeQuotaSheet();
    window.dispatchEvent(new CustomEvent("fm-close-lane-filters"));
    chatButton.setAttribute("aria-expanded", "false");
    document.querySelector(`.primary-tab[data-view="${button.dataset.mobileView}"]`)?.click();
  });
});
function syncMobileRoute() {
  const view = workspace.dataset.view === "closed" ? "conversations" : workspace.dataset.view;
  if (workspace.dataset.view !== "conversations" && chatSheet.open) chatSheet.close();
  if (workspace.dataset.view !== "conversations") {
    window.dispatchEvent(new CustomEvent("fm-close-lane-filters"));
    chatButton.setAttribute("aria-expanded", "false");
  }
  mobileDock.querySelectorAll("[data-mobile-view]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.mobileView === view ? "page" : "false");
  });
  const quota = mobileDock.querySelector(".mobile-dock-quota");
  if (quota) {
    // Quota opens a sheet on phone; mark expanded when open, not page-current.
    quota.setAttribute("aria-expanded", String(quotaSheet.open));
    if (view !== "conversations" && quotaSheet.open) quotaSheet.close();
  }
}
new MutationObserver(syncMobileRoute).observe(workspace, { attributes: true, attributeFilter: ["data-view"] });

// Only Review is modal; Message and Annotation leave the page interactive.
const reviewPanel = document.querySelector("#review-panel");
const reviewSheet = document.createElement("dialog");
reviewSheet.className = "mobile-sheet mobile-review-sheet";
reviewSheet.setAttribute("aria-label", "Review conversation");
document.body.append(reviewSheet);
reviewSheet.addEventListener("cancel", (event) => {
  event.preventDefault();
  document.querySelector("#review-close").click();
});
reviewSheet.addEventListener("click", (event) => {
  if (event.target === reviewSheet) document.querySelector("#review-close").click();
});
// Closing a native dialog restores its previous focus after review-client's synchronous
// close handler. Re-focus the visible dock opener only once that restoration has run.
reviewSheet.addEventListener("close", () => {
  if (desktop.matches || !reviewPanel.hidden) return;
  const pickNotice = document.querySelector(".review-pick-notice:not([hidden])");
  if (pickNotice) pickNotice.querySelector("button")?.focus();
  else document.querySelector("#review-panel-toggle").focus();
});
function syncReviewSheet() {
  if (!desktop.matches && !reviewPanel.hidden) {
    if (toolsSheet.open) toolsSheet.close();
    if (chatSheet.open) chatSheet.close();
    const reviewing = reviewPanel.dataset.reviewTab === "review";
    if (reviewSheet.open && (reviewSheet.matches(":modal") !== reviewing)) reviewSheet.close();
    if (!reviewSheet.open) {
      if (reviewing) reviewSheet.showModal(); else reviewSheet.show();
    }
  } else if (reviewSheet.open) reviewSheet.close();
}
new MutationObserver(syncReviewSheet).observe(reviewPanel, { attributes: true, attributeFilter: ["hidden", "data-review-tab"] });
const annotation = document.querySelector("#review-annotation");
const annotationSheet = document.createElement("dialog");
annotationSheet.className = "mobile-sheet mobile-annotation-sheet";
annotationSheet.setAttribute("aria-label", "Annotate selected content");
document.body.append(annotationSheet);
function syncAnnotationSheet() {
  if (!desktop.matches && !annotation.hidden) {
    if (!annotationSheet.open) annotationSheet.showModal();
  } else if (annotationSheet.open) annotationSheet.close();
}
annotationSheet.addEventListener("cancel", (event) => { event.preventDefault(); document.querySelector("#review-form-close").click(); });
annotationSheet.addEventListener("click", (event) => { if (event.target === annotationSheet) document.querySelector("#review-form-close").click(); });
new MutationObserver(syncAnnotationSheet).observe(annotation, { attributes: true, attributeFilter: ["hidden"] });
function syncMobileControls() {
  if (desktop.matches) {
    toolsSheet.close();
    chatSheet.close();
    reviewSheet.close();
    annotationSheet.close();
    workspace.dataset.searchOpen = "false";
    document.querySelector("#header-search-toggle")?.setAttribute("aria-expanded", "false");
    for (const [node, anchor] of placements) { anchor.replaceWith(node); }
    placements.clear();
    const footer = document.querySelector("#desktop-review-footer");
    const previewControl = document.querySelector(".preview-control");
    if (previewControl && previewControl.parentElement !== footer) footer.insertBefore(previewControl, footer.firstChild);
    footer.append(document.querySelector("#review-panel-toggle"));
    toggle.setAttribute("aria-controls", "review-sidebar-region");
    syncPanel();
    syncReadingLayout();
    return;
  }
  syncReadingLayout();
  moveControl(document.querySelector(".primary-nav"), toolsBody);
  moveControl(document.querySelector(".source-status"), toolsBody);
  moveControl(document.querySelector("#refresh"), document.querySelector(".product-identity"));
  ensureHeaderSearchToggle();
  moveControl(document.querySelector("#header-search-toggle"), document.querySelector(".product-identity"));
  moveControl(document.querySelector("#review-panel-toggle"), mobileDock, mobileDock.querySelector(".mobile-dock-quota"));
  moveControl(document.querySelector(".preview-control"), toolsBody);
  moveControl(document.querySelector(".uat-deployment-label"), toolsBody);
  moveControl(reviewPanel, reviewSheet);
  moveControl(annotation, annotationSheet);
  moveControl(document.querySelector("#conversation-filter-shortcut"), document.querySelector(".product-identity > div"), document.querySelector(".product-identity-subtext"));
  document.querySelector("#review-send").textContent = "Send batch";
  moveControl(document.querySelector(".conversation-head-actions"), chatTools);
  moveControl(document.querySelector(".feed-pagination"), chatTools);
  moveControl(document.querySelector(".feed-jump-controls"), chatTools);
  moveControl(document.querySelector("#transcript-window-status"), chatTools);
  moveControl(document.querySelector(".preview-chat-control"), chatTools);
  toggle.setAttribute("aria-controls", "mobile-tools");
  toggle.setAttribute("aria-label", "Open workspace tools");
  toggle.setAttribute("aria-expanded", String(toolsSheet.open));
  syncMobileRoute();
  syncReviewSheet();
  syncAnnotationSheet();
}
function closeHeaderSearch({ focusToggle = false } = {}) {
  if (workspace.dataset.searchOpen !== "true") return;
  workspace.dataset.searchOpen = "false";
  const toggle = document.querySelector("#header-search-toggle");
  toggle?.setAttribute("aria-expanded", "false");
  if (focusToggle) toggle?.focus();
}
function ensureHeaderSearchToggle() {
  if (document.querySelector("#header-search-toggle")) return;
  const button = document.createElement("button");
  button.id = "header-search-toggle";
  button.type = "button";
  button.className = "header-search-toggle";
  button.setAttribute("aria-controls", "transcript-search");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Search records");
  button.title = "Search records";
  button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  button.addEventListener("click", () => {
    const open = workspace.dataset.searchOpen === "true";
    if (open) {
      closeHeaderSearch({ focusToggle: true });
      return;
    }
    workspace.dataset.searchOpen = "true";
    button.setAttribute("aria-expanded", "true");
    const input = document.querySelector("#transcript-search");
    input?.focus();
    input?.select?.();
  });
  const input = document.querySelector("#transcript-search");
  if (input && !input.dataset.searchDismissBound) {
    input.dataset.searchDismissBound = "1";
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeHeaderSearch({ focusToggle: true });
    });
    input.addEventListener("blur", () => {
      // Defer so a click on the toggle can close without the blur/reopen race.
      setTimeout(() => {
        if (workspace.dataset.searchOpen !== "true") return;
        if ((input.value || "").trim()) return;
        const active = document.activeElement;
        if (active === document.querySelector("#header-search-toggle")) return;
        if (active && input.closest(".transcript-search")?.contains(active)) return;
        closeHeaderSearch();
      }, 0);
    });
  }
  document.querySelector(".product-identity")?.append(button);
}
// Registered version controls arrive asynchronously; retain their own handlers.
new MutationObserver(() => {
  if (!desktop.matches && workspace.querySelector(".preview-control, .uat-deployment-label, .feed-actions > .preview-chat-control")) syncMobileControls();
}).observe(workspace, { childList: true, subtree: true });
desktop.addEventListener("change", syncMobileControls);
window.addEventListener("resize", () => {
  if (!desktop.matches) {
    toggle.setAttribute("aria-label", "Open workspace tools");
    toggle.setAttribute("aria-expanded", String(toolsSheet.open));
  }
});
syncMobileControls();
if (window.ResizeObserver) new ResizeObserver(syncReadingLayout).observe(document.querySelector('.conversation-head'));

for (const selector of ["#transcript-details", "#kind-filter-menu"]) {
  const details = document.querySelector(selector);
  const popup = details.querySelector(".transcript-coverage-popover, .kind-filter-popover");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mobile-popover-close";
  close.textContent = "Done";
  close.addEventListener("click", () => {
    if (selector === "#kind-filter-menu" && !desktop.matches) {
      window.dispatchEvent(new CustomEvent("fm-close-lane-filters"));
      document.querySelector('.mobile-dock [data-mobile-view="conversations"]')?.setAttribute("aria-expanded", "false");
      document.querySelector('.mobile-dock [data-mobile-view="conversations"]')?.focus();
      return;
    }
    details.open = false;
    details.querySelector("summary").focus();
  });
  const kindsActions = selector === "#kind-filter-menu" ? popup.querySelector(".message-types-actions") : null;
  (kindsActions || popup).append(close);
}
