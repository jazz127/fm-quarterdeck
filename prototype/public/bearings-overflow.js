// Retained clamp controller (BEARINGS.md "Long text"). Cards no longer render
// [data-call-more], so apply() returns immediately. If a control is present it still
// expands that card in place. Expansion is per card key, survives patches, and never
// selects or holds the card.
window.bearingsOverflow = (() => {
  const keyOf = (node) => node?.getAttribute?.("data-call-key") || null;

  function createOverflowController({ list, win = window, onToggle = () => {} } = {}) {
    const expanded = new Set();
    const cards = () => [...list.querySelectorAll("[data-call-key]")];
    const clampedNow = (node) => [...node.querySelectorAll("[data-call-clamp]")].some((el) => el.scrollHeight - el.clientHeight > 1);

    function apply(node) {
      const key = keyOf(node);
      const button = node.querySelector("[data-call-more]");
      if (!key || !button) return;
      const open = expanded.has(key);
      const truncated = node.querySelector("[data-call-truncated]") !== null;
      node.toggleAttribute("data-call-expanded", open);
      for (const detail of node.querySelectorAll("[data-call-more-detail]")) detail.hidden = !open;
      // Measure only while collapsed: expanded text is never clamped.
      const cut = open || truncated || clampedNow(node);
      button.hidden = !cut;
      button.setAttribute("aria-expanded", String(open));
      const label = open ? "Fewer details" : "More details";
      if (button.textContent !== label) button.textContent = label;
    }
    const measureAll = () => { for (const node of cards()) apply(node); };

    // Width changes (rotation, panel resize, the view becoming visible) can clamp or
    // unclamp text, so re-measure on list resize.
    let frame = null;
    const schedule = () => {
      if (frame !== null) return;
      const run = () => { frame = null; measureAll(); };
      frame = win.requestAnimationFrame ? win.requestAnimationFrame(run) : win.setTimeout(run, 0);
    };
    const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
    resize?.observe(list);
    win.addEventListener?.("resize", schedule);

    const onClick = (event) => {
      const button = event.target?.closest?.("[data-call-more]");
      const node = button?.closest?.("[data-call-key]");
      if (!button || !node) return;
      const key = keyOf(node);
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      apply(node);
      onToggle(key, expanded.has(key));
    };
    list.addEventListener("click", onClick);

    return {
      // Called by the patcher after each fill; layout may not be final yet, so measure
      // now and again on the next frame.
      render(node) { apply(node); schedule(); },
      measureAll,
      isExpanded: (key) => expanded.has(key),
      prune(openKeys) { const open = new Set(openKeys); for (const key of [...expanded]) if (!open.has(key)) expanded.delete(key); },
      destroy() {
        resize?.disconnect();
        win.removeEventListener?.("resize", schedule);
        list.removeEventListener("click", onClick);
      },
    };
  }

  return { createOverflowController };
})();
