// Shared presentation sync for filter bulk actions.
// One Select all ↔ Clear smart toggle for desktop and mobile.
window.bulkControls = (() => {
  function sync({ all, none, disabled = false, toggle, noun }) {
    if (toggle) {
      toggle.disabled = disabled;
      toggle.setAttribute("aria-pressed", String(all));
      toggle.dataset.mode = all ? "clear" : "select";
      toggle.textContent = all ? "Clear" : "Select all";
      toggle.setAttribute("aria-label", all ? `Clear all ${noun}` : `Select all ${noun}`);
    }
  }
  function bindToggle(element, onSelectAll) {
    element?.addEventListener("click", () => {
      if (!element || element.disabled) return;
      onSelectAll(element.dataset.mode !== "clear");
    });
  }
  return { sync, bindToggle };
})();
