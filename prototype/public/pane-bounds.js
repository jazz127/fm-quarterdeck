// Viewport-space bounds for floating annotation and native mobile dialog panes.
window.paneBounds = (() => {
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  function bounds(viewport, safe = {}, margin = 8) {
    const left = finite(viewport.left) + finite(safe.left) + margin;
    const top = finite(viewport.top) + finite(safe.top) + margin;
    const right = Math.max(left, finite(viewport.left) + finite(viewport.width) - finite(safe.right) - margin);
    const bottom = Math.max(top, finite(viewport.top) + finite(viewport.height) - finite(safe.bottom) - margin);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  function fit(rect, available, point = rect) {
    const width = Math.min(Math.max(0, finite(rect.width)), available.width);
    const height = Math.min(Math.max(0, finite(rect.height)), available.height);
    return { left: Math.max(available.left, Math.min(finite(point.left), available.right - width)),
      top: Math.max(available.top, Math.min(finite(point.top), available.bottom - height)), width, height };
  }
  function install(win, doc) {
    const panes = new Map();
    let scheduled = false;
    const write = (style, key, value) => { if (style[key] !== value) style[key] = value; };
    const property = (style, key, value) => { if (style.getPropertyValue(key) !== value) style.setProperty(key, value); };
    function available() {
      const vv = win.visualViewport;
      const root = win.getComputedStyle(doc.documentElement);
      const safe = Object.fromEntries(["left", "top", "right", "bottom"].map((edge) => [edge, parseFloat(root.getPropertyValue(`--pane-safe-${edge}`)) || 0]));
      return bounds({ left: vv?.offsetLeft || 0, top: vv?.offsetTop || 0, width: vv?.width || win.innerWidth, height: vv?.height || win.innerHeight }, safe);
    }
    function reset(node, original) {
      for (const [key, value] of Object.entries(original)) write(node.style, key, value);
      for (const key of ["--pane-max-height", "--pane-max-width"]) node.style.removeProperty(key);
    }
    function reconcile(node, point) {
      const original = panes.get(node);
      if (!original) return;
      if (node.hidden || !node.getClientRects().length || win.getComputedStyle(node).position !== "fixed") { reset(node, original); return; }
      const area = available();
      property(node.style, "--pane-max-width", `${area.width}px`);
      property(node.style, "--pane-max-height", `${area.height}px`);
      // Read after applying the caps: oversized content now scrolls inside its pane.
      const next = fit(node.getBoundingClientRect(), area, point);
      write(node.style, "margin", "0px");
      write(node.style, "right", "auto"); write(node.style, "bottom", "auto");
      write(node.style, "left", `${next.left}px`); write(node.style, "top", `${next.top}px`);
    }
    function scan() {
      scheduled = false;
      for (const node of doc.querySelectorAll("#review-annotation, dialog.mobile-sheet")) {
        if (!panes.has(node)) {
          panes.set(node, Object.fromEntries(["margin", "left", "top", "right", "bottom"].map((key) => [key, node.style[key]])));
          resize?.observe(node);
          node.addEventListener("close", () => { const saved = panes.get(node); if (saved) reset(node, saved); });
        }
      }
      for (const node of panes.keys()) {
        if (!node.isConnected) { resize?.unobserve(node); panes.delete(node); }
        else reconcile(node);
      }
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      win.requestAnimationFrame(scan);
    }
    const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    const mutations = win.MutationObserver ? new win.MutationObserver(schedule) : null;
    mutations?.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden", "open"] });
    win.addEventListener("resize", schedule);
    doc.addEventListener("scroll", schedule, true);
    win.visualViewport?.addEventListener("resize", schedule);
    win.visualViewport?.addEventListener("scroll", schedule);
    scan();
    return { place(node, point) { if (!panes.has(node)) scan(); reconcile(node, point); }, reconcile: scan };
  }
  const api = { bounds, fit, install };
  if (window.document?.body && window.requestAnimationFrame && window.getComputedStyle) api.controller = install(window, window.document);
  return api;
})();
