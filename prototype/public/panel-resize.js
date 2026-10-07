// Independent, bounded desktop panel dimensions. Keys and reset never touch another panel.
export function clampSize(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function attachPanelResize({ panel, handle, property, key, initial, min, maximum, direction, storage = localStorage, desktop = matchMedia("(min-width: 721px)") }) {
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
  if (Number.isFinite(saved) && saved > 0) apply(saved);
  const persist = (value) => {
    const size = apply(value);
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
    panel.style.removeProperty(property);
    updateRange(clampSize(initial, min(), bound()));
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
  window.addEventListener("resize", () => {
    if (desktop.matches && panel.style.getPropertyValue(property)) apply(current());
  });
}

if (typeof document !== "undefined") {
  const byId = (id) => document.getElementById(id);
  attachPanelResize({
    panel: byId("sidebar-quota"), handle: byId("quota-resize"),
    property: "--quota-height", key: "fm-agentos-quota-panel-height.v1", initial: 220,
    min: () => 120, maximum: () => byId("sidebar-quota").parentElement.clientHeight * 0.6,
    direction: "vertical",
  });
  attachPanelResize({
    panel: byId("review-panel"), handle: byId("review-resize"),
    property: "--review-width", key: "fm-agentos-review-panel-width.v1", initial: 600,
    min: () => 320, maximum: () => Math.min(900, window.innerWidth - 32),
    direction: "horizontal",
  });
}
