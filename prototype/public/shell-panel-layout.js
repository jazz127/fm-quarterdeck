// The app-shell preference is presentation-only. Keep the conversation pane usable.
export const SHELL_WIDTH_KEY = "fm-agentos-shell-panel-width.v1";
export const SHELL_DEFAULT_WIDTH = 252;
export const SHELL_MIN_WIDTH = 220;
export const SHELL_RESIZE_STEP = 20; // Arrow keys move the divider by 20 CSS pixels.

export function shellWidthBounds(viewportWidth) {
  return { min: SHELL_MIN_WIDTH, max: Math.max(SHELL_MIN_WIDTH, Math.min(440, viewportWidth - 480)) };
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
