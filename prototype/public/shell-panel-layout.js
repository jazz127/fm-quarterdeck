// The app-shell preference is presentation-only. Keep the conversation pane usable.
export const SHELL_WIDTH_KEY = "fm-agentos-shell-panel-width.v1";
export const SHELL_DEFAULT_WIDTH = 252;
export const SHELL_MIN_WIDTH = 220;
export const SHELL_RESIZE_STEP = 20; // Arrow keys move the divider by 20 CSS pixels.

export const CONVERSATION_MIN_WIDTH = 480;
// Above 1200px Fleet Chats also shows the 288px context rail and both filter rails collapsed to 52px + 44px.
const WIDE_CONVERSATION_RESERVE = 288 + 52 + 44;

export function shellWidthBounds(viewportWidth) {
  const reserved = CONVERSATION_MIN_WIDTH + (viewportWidth > 1200 ? WIDE_CONVERSATION_RESERVE : 0);
  return { min: SHELL_MIN_WIDTH, max: Math.max(SHELL_MIN_WIDTH, Math.min(440, viewportWidth - reserved)) };
}

export function shellWidth(value, viewportWidth) {
  const { min, max } = shellWidthBounds(viewportWidth);
  return Math.min(max, Math.max(min, value));
}

export function savedShellWidth(value) {
  if (value === null || !/^(?:\d+)(?:\.\d+)?$/.test(value)) return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

// Apply the saved width to the workspace grid. app.js scrolls the feed to its newest record as soon as
// lanes load, so this must run before app.js; a later width change re-wraps the feed and leaves it
// short of the bottom.
export function restoreShellWidth(workspace, viewportWidth, storage) {
  let saved = null;
  try { saved = savedShellWidth(storage.getItem(SHELL_WIDTH_KEY)); } catch { /* Storage is optional. */ }
  if (saved !== null) workspace.style.setProperty("--shell-nav-width", `${shellWidth(saved, viewportWidth)}px`);
  return saved;
}
