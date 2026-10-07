// Stock Firstmate/Pi message-kind catalog and preference storage. No DOM.
window.messageKinds = (() => {
  const KEY = "fm-agentos-message-types-v2";
  const LEGACY_KEY = "fm-agentos-message-types-v1";
  // Lucide-like stroke SVGs (16px in a 22px well). currentColor; no emoji.
  const svgAttrs = 'class="message-kind-svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const wrap = (paths) => `<svg ${svgAttrs}>${paths}</svg>`;
  const ICONS = {
    captain: wrap('<path d="M2 18h20"/><path d="M4 18 6 8l4 3 2-5 2 5 4-3 2 10"/><path d="M8 18v2"/><path d="M16 18v2"/>'), // crown
    conversation: wrap('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>'), // message-square
    supervision: wrap('<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>'), // badge-check
    thinking: wrap('<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3.5"/>'), // circle-dashed
    steer: wrap('<path d="M4 4v7a4 4 0 0 0 4 4h12"/><path d="m15 11 5 4-5 4"/>'), // corner-down-right
    crew: wrap('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'), // users
    branch: wrap('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7"/><path d="M8.5 6h5a4 4 0 0 1 4 4"/>'), // git-branch
    tools: wrap('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'), // wrench
    harness: wrap('<path d="M12 2l8.5 5v10L12 22 3.5 17V7L12 2z"/>'), // hexagon
    help: wrap('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4"/><path d="M12 17h.01"/>'), // circle-help
  };
  // Ordered from high-signal conversation to progressively noisier operational records.
  const TYPES = [
    { id: "captain", label: "captain", icon: "captain", filterGlyph: "captain", svg: ICONS.captain },
    { id: "conversation", label: "Firstmate replies", icon: "conversation", filterGlyph: "conversation", svg: ICONS.conversation },
    { id: "supervision", label: "supervision outcomes", icon: "supervision", filterGlyph: "supervision", svg: ICONS.supervision },
    { id: "thinking", label: "thinking", icon: "thinking", filterGlyph: "thinking", svg: ICONS.thinking },
    { id: "steer", label: "steers", icon: "steer", filterGlyph: "steer", svg: ICONS.steer },
    { id: "crew", label: "crew status", icon: "crew", filterGlyph: "crew", svg: ICONS.crew },
    { id: "branch", label: "crew replies", icon: "branch", filterGlyph: "branch", svg: ICONS.branch },
    { id: "tools", label: "tools", icon: "tools", filterGlyph: "tools", svg: ICONS.tools },
    { id: "harness", label: "harness", icon: "harness", filterGlyph: "harness", svg: ICONS.harness },
  ];
  const DEFAULT_IDS = ["captain", "conversation", "supervision"];
  const known = (id) => TYPES.some((type) => type.id === id);
  const typeId = (message) => message.role === "captain" ? "captain" : (message.kind || "conversation");
  const label = (id) => TYPES.find((type) => type.id === id)?.label || id;
  const icon = (id) => TYPES.find((type) => type.id === id)?.icon;
  const svg = (id) => TYPES.find((type) => type.id === id)?.svg || ICONS.help;
  const stored = () => {
    try {
      const current = localStorage.getItem(KEY);
      const legacy = current === null ? JSON.parse(localStorage.getItem(LEGACY_KEY)) : null;
      const raw = current === null && Array.isArray(legacy)
        ? [...legacy, "supervision", ...(legacy.includes("conversation") ? ["captain"] : [])]
        : JSON.parse(current);
      if (Array.isArray(raw)) return new Set(raw.filter(known));
    } catch {
      // Use readable defaults when storage is unavailable.
    }
    return new Set(DEFAULT_IDS);
  };
  return { KEY, LEGACY_KEY, TYPES, DEFAULT_IDS, ICONS, known, typeId, label, icon, svg, stored };
})();
