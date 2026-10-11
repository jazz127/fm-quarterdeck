// Phone Overview tabs (BEARINGS.md). Desktop keeps both columns and hides this control.
window.overviewTabs = (() => {
  const KEY = "fm-quarterdeck-overview-tab.v1";
  const ORDER = ["calls", "landed", "underway", "charted"];
  const LABELS = { calls: "Captain's Call", landed: "Just landed", underway: "Underway", charted: "Charted Next" };

  function createController({ root, tabs, panels, secondary = null, counts = {}, storage = null, media = null, doc = document } = {}) {
    if (!tabs || !panels?.calls || !panels?.landed) return { paint() {}, select() {}, destroy() {} };
    const order = ORDER.filter(name => panels[name]);
    let selected = "calls";
    try {
      const saved = storage?.getItem(KEY);
      if (order.includes(saved)) selected = saved;
    } catch { /* a blocked storage read keeps Captain's Call */ }
    const phone = () => Boolean(media?.matches);
    const buttonFor = (name) => tabs.querySelector(`[data-overview-tab="${name}"]`);
    const remember = (name) => {
      selected = name;
      try { storage?.setItem(KEY, name); } catch { /* the choice still applies for this view */ }
    };
    const focusSelected = () => buttonFor(selected)?.focus();
    function apply() {
      const narrow = phone();
      if (narrow) tabs.setAttribute("role", "tablist");
      else tabs.removeAttribute("role");
      if (root) {
        if (narrow) root.setAttribute("data-overview-tab", selected);
        else root.removeAttribute("data-overview-tab");
      }
      if (secondary) secondary.hidden = narrow && selected === "calls";
      for (const name of order) {
        const button = buttonFor(name);
        const panel = panels[name];
        const on = !narrow || name === selected;
        const count = Number(counts[name]?.());
        const n = Number.isSafeInteger(count) && count >= 0 ? count : 0;
        if (button) {
          button.textContent = `${LABELS[name]} (${n})`;
          if (narrow) {
            button.setAttribute("role", "tab");
            button.setAttribute("aria-selected", String(name === selected));
            button.setAttribute("tabindex", name === selected ? "0" : "-1");
          } else {
            button.removeAttribute("role");
            button.removeAttribute("aria-selected");
            button.removeAttribute("tabindex");
          }
        }
        if (!panel) continue;
        const focused = panel.contains(doc.activeElement);
        panel.hidden = !on;
        if (narrow) {
          panel.setAttribute("role", "tabpanel");
          panel.setAttribute("aria-labelledby", button?.getAttribute("id") || "");
        } else {
          panel.removeAttribute("role");
          panel.removeAttribute("aria-labelledby");
        }
        if (!on && focused) focusSelected();
      }
    }
    function select(name, focus = false) {
      if (!order.includes(name) || name === selected) {
        if (focus) focusSelected();
        return;
      }
      remember(name);
      apply();
      if (focus) focusSelected();
    }
    const onClick = (event) => {
      const button = event.target?.closest?.("[data-overview-tab]");
      if (!button || !tabs.contains(button)) return;
      select(button.getAttribute("data-overview-tab"));
    };
    const onKey = (event) => {
      if (!phone() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const button = event.target?.closest?.("[data-overview-tab]");
      if (!button || !tabs.contains(button)) return;
      event.preventDefault();
      const list = order.map(buttonFor).filter(Boolean);
      const index = list.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
      select(list[next].getAttribute("data-overview-tab"), true);
    };
    tabs.addEventListener("click", onClick);
    tabs.addEventListener("keydown", onKey);
    const onMedia = () => apply();
    media?.addEventListener?.("change", onMedia);
    apply();
    return {
      paint: apply,
      select,
      destroy() {
        tabs.removeEventListener("click", onClick);
        tabs.removeEventListener("keydown", onKey);
        media?.removeEventListener?.("change", onMedia);
      },
    };
  }

  return { createController, KEY };
})();
