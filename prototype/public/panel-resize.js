// Independent, bounded desktop panel dimensions. Keys and reset never touch another panel.
export function clampSize(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function attachPanelResize({ panel, handle, property, key, initial, min, maximum, direction, automatic, storage = localStorage, desktop = matchMedia("(min-width: 721px)") }) {
  const bound = () => Math.max(min(), maximum());
  const updateRange = (size) => {
    handle.setAttribute("aria-valuemin", String(Math.round(min())));
    handle.setAttribute("aria-valuemax", String(Math.round(bound())));
    handle.setAttribute("aria-valuenow", String(Math.round(size)));
  };
  const apply = (value) => {
    const size = clampSize(value, min(), bound());
    panel.style.setProperty(property, `${size}px`);
    updateRange(size);
    return size;
  };
  updateRange(clampSize(initial, min(), bound()));
  let saved;
  try { saved = Number(storage.getItem(key)); } catch { /* Storage may be unavailable. */ }
  let manual = Number.isFinite(saved) && saved > 0;
  let preferred = saved;
  if (manual) apply(saved);
  else if (automatic) apply(automatic());
  const persist = (value) => {
    manual = true;
    const size = apply(value);
    preferred = size;
    try { storage.setItem(key, String(size)); } catch { /* In-memory size still works. */ }
  };
  const current = () => parseFloat(getComputedStyle(panel).getPropertyValue(property)) || initial;
  let drag;
  handle.addEventListener("pointerdown", (event) => {
    if (!desktop.matches || event.button !== 0) return;
    drag = { id: event.pointerId, start: direction === "vertical" ? event.clientY : event.clientX, size: current() };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const coordinate = direction === "vertical" ? event.clientY : event.clientX;
    // Both panels grow toward the top/left from their bottom/right edges.
    apply(drag.size + drag.start - coordinate);
  });
  handle.addEventListener("pointerup", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    persist(current());
    drag = null;
  });
  handle.addEventListener("pointercancel", () => { drag = null; });
  const resetSize = () => {
    manual = false;
    panel.style.removeProperty(property);
    if (automatic) apply(automatic());
    else updateRange(clampSize(initial, min(), bound()));
    try { storage.removeItem(key); } catch { /* Storage may be unavailable. */ }
  };
  handle.addEventListener("dblclick", () => { if (desktop.matches) resetSize(); });
  handle.addEventListener("keydown", (event) => {
    if (!desktop.matches) return;
    const delta = direction === "vertical"
      ? { ArrowUp: 20, ArrowDown: -20 }[event.key]
      : { ArrowLeft: 20, ArrowRight: -20 }[event.key];
    if (event.key === "Home") {
      event.preventDefault();
      resetSize();
    } else if (delta !== undefined) {
      event.preventDefault();
      persist(current() + delta);
    }
  });
  const refresh = () => {
    if (!drag && desktop.matches && panel.style.getPropertyValue(property)) apply(!manual && automatic ? automatic() : manual ? preferred : current());
  };
  window.addEventListener("resize", refresh);
  return refresh;
}

// Reserve each non-quota control's full content height, not its flex-shrunk box.
export function quotaAvailableHeight(parentHeight, padding, siblingHeights) {
  return Math.max(0, parentHeight - padding - siblingHeights.reduce((sum, height) => sum + height, 0));
}

if (typeof document !== "undefined") {
  const byId = (id) => document.getElementById(id);
  const quota = byId("sidebar-quota"), strip = byId("quota-strip"), head = quota.querySelector(".sidebar-quota-head");
  const maximum = () => {
    const parent = quota.parentElement, style = getComputedStyle(parent);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const siblings = [...parent.children].filter((node) => node !== quota && !node.hidden);
    const height = quotaAvailableHeight(parent.clientHeight, padding, siblings.map((node) => {
      const css = getComputedStyle(node);
      return Math.max(node.scrollHeight, node.getBoundingClientRect().height) + (parseFloat(css.marginTop) || 0) + (parseFloat(css.marginBottom) || 0);
    }));
    quota.style.setProperty("--quota-maximum", `${height}px`);
    return height;
  };
  const refreshQuota = attachPanelResize({
    panel: quota, handle: byId("quota-resize"),
    property: "--quota-height", key: "fm-agentos-quota-panel-height.v1", initial: 220,
    min: () => Math.min(64, maximum()), maximum,
    automatic: () => {
      const css = getComputedStyle(quota);
      const rows = [...strip.children];
      const content = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)
        + Math.max(0, rows.length - 1) * (parseFloat(getComputedStyle(strip).gap) || 0);
      return content + head.getBoundingClientRect().height + (parseFloat(getComputedStyle(head).marginBottom) || 0)
        + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom) + 1;
    },
    direction: "vertical",
  });
  new MutationObserver(refreshQuota).observe(strip, { childList: true, subtree: true, characterData: true });
  const quotaObserver = new ResizeObserver(refreshQuota);
  quotaObserver.observe(quota.parentElement);
  quotaObserver.observe(head);
  const toggle = byId("sidebar-quota-toggle");
  let collapsed = false;
  try { collapsed = localStorage.getItem("fm-agentos-sidebar-quota-collapsed.v1") === "true"; } catch { /* Optional storage. */ }
  const applyCollapsed = () => {
    quota.dataset.collapsed = String(collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} quota`);
    refreshQuota();
  };
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem("fm-agentos-sidebar-quota-collapsed.v1", String(collapsed)); } catch { /* In-memory still works. */ }
    applyCollapsed();
  });
  applyCollapsed();
  attachPanelResize({
    panel: byId("review-panel"), handle: byId("review-resize"),
    property: "--review-width", key: "fm-agentos-review-panel-width.v1", initial: 600,
    min: () => 320, maximum: () => Math.min(900, window.innerWidth - 32),
    direction: "horizontal",
  });
}
