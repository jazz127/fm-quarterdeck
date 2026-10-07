import test from "node:test";
import assert from "node:assert/strict";
import { SHELL_DEFAULT_WIDTH, SHELL_RESIZE_STEP, SHELL_WIDTH_KEY, savedShellWidth, shellWidth, shellWidthBounds } from "../public/shell-panel-layout.js";

test("shell width reserves 480px for the conversation and caps navigation at 440px", () => {
  assert.deepEqual(shellWidthBounds(1600), { min: 220, max: 440 });
  assert.deepEqual(shellWidthBounds(800), { min: 220, max: 320 });
  assert.deepEqual(shellWidthBounds(721), { min: 220, max: 241 });
  assert.equal(shellWidth(900, 1600), 440);
  assert.equal(shellWidth(5, 800), 220);
  assert.equal(shellWidth(400, 800), 320);
  assert.equal(shellWidth(400, 1600), 400);
  assert.equal(SHELL_DEFAULT_WIDTH, 252);
  assert.equal(SHELL_RESIZE_STEP, 20);
  assert.equal(SHELL_WIDTH_KEY, "fm-agentos-shell-panel-width.v1");
});

test("missing, old, corrupt, negative and nonfinite preferences cannot set layout", () => {
  for (const raw of [null, "", "NaN", "Infinity", "-120", "0", "320px", "null", "1e309", " 200 "]) assert.equal(savedShellWidth(raw), null, String(raw));
  assert.equal(savedShellWidth("900"), 900); // Valid old width is clamped on every desktop visit.
  assert.equal(shellWidth(savedShellWidth("900"), 800), 320);
});
