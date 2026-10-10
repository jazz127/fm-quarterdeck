// Phone Overview tabs (BEARINGS.md). Desktop keeps both columns and hides this control.
window.overviewTabs = (() => {
  const KEY = "fm-quarterdeck-overview-tab.v1";
  const ORDER = ["calls", "landed"];
  const LABELS = { calls: "Captain's Call", landed: "Just landed" };

  function createController({ root, tabs, panels, counts = {}, freshness = () => null, storage = null, media = null, doc = document } = {}) {
    if (!tabs || !panels?.calls || !panels?.landed) return { paint() {}, select() {}, destroy() {} };
    let selected = "calls";
    try {
      const saved = storage?.getItem(KEY);
      if (saved === "calls" || saved === "landed") selected = saved;
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
      for (const name of ORDER) {
        const button = buttonFor(name);
        const panel = panels[name];
        const on = !narrow || name === selected;
        const count = Number(counts[name]?.());
        const n = Number.isSafeInteger(count) && count >= 0 ? count : 0;
        const model = freshness();
        const state = model?.state;
        const label = state === "loading" || state === "unavailable" ? state : model?.stale || state === "stale" ? `${n} · stale` : String(n);
        if (button) {
          button.textContent = `${LABELS[name]} (${label})`;
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
      if (!ORDER.includes(name) || name === selected) {
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
      const list = ORDER.map(buttonFor).filter(Boolean);
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
