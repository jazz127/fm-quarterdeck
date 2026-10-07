// Message text size preference ladder. Storage and rem values only — no DOM.
window.messageFontSizePrefs = (() => {
  const KEY = "fm-agentos-message-font-size-v1";
  const STEPS = ["S", "M", "L", "XL"];
  const SIZES = { S: "0.875rem", M: "1rem", L: "1.125rem", XL: "1.3125rem" };
  const normalize = (size) => SIZES[size] ? size : "M";
  const stored = () => {
    try {
      return normalize(localStorage.getItem(KEY));
    } catch {
      return "M";
    }
  };
  const rem = (size) => SIZES[normalize(size)];
  const step = (current, delta) => {
    const index = STEPS.indexOf(normalize(current));
    const nextIndex = Math.max(0, Math.min(STEPS.length - 1, (index < 0 ? 1 : index) + delta));
    return STEPS[nextIndex];
  };
  const bounds = (size) => {
    const index = STEPS.indexOf(normalize(size));
    return { atMin: index <= 0, atMax: index >= STEPS.length - 1 };
  };
  const persist = (size) => {
    try { localStorage.setItem(KEY, normalize(size)); } catch { /* optional */ }
  };
  return { KEY, STEPS, SIZES, normalize, stored, rem, step, bounds, persist };
})();
