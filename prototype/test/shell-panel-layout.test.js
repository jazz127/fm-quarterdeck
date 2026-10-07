import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SHELL_DEFAULT_WIDTH, SHELL_RESIZE_STEP, SHELL_WIDTH_KEY, restoreShellWidth, savedShellWidth, shellWidth, shellWidthBounds } from "../public/shell-panel-layout.js";

test("shell width reserves 480px for the conversation and caps navigation at 440px", () => {
  assert.deepEqual(shellWidthBounds(1600), { min: 220, max: 440 });
  // Above 1200px the Fleet Chats rail (288px) and collapsed filter rails (52px + 44px) are reserved too.
  assert.deepEqual(shellWidthBounds(1201), { min: 220, max: 337 });
  assert.deepEqual(shellWidthBounds(1374), { min: 220, max: 440 });
  assert.deepEqual(shellWidthBounds(1200), { min: 220, max: 440 });
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

test("saved width is applied to the workspace, clamped to the viewport, before any feed render", () => {
  const workspace = () => ({ style: { applied: null, setProperty(name, value) { this.applied = [name, value]; } } });
  const storage = (value) => ({ getItem: (key) => (key === SHELL_WIDTH_KEY ? value : null) });
  const wide = workspace();
  assert.equal(restoreShellWidth(wide, 1600, storage("380")), 380);
  assert.deepEqual(wide.style.applied, ["--shell-nav-width", "380px"]);
  const narrow = workspace();
  restoreShellWidth(narrow, 800, storage("900"));
  assert.deepEqual(narrow.style.applied, ["--shell-nav-width", "320px"]);
  for (const bad of [null, "NaN", "-5", { getItem() { throw new Error("blocked"); } }]) {
    const untouched = workspace();
    assert.equal(restoreShellWidth(untouched, 1600, bad !== null && typeof bad === "object" ? bad : storage(bad)), null);
    assert.equal(untouched.style.applied, null, "no usable preference leaves the CSS default");
  }
});

test("the width restore module executes before app.js so the first feed render sees final column widths", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const modules = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(modules.includes("/shell-width.js"));
  assert.ok(modules.indexOf("/shell-width.js") < modules.indexOf("/app.js"));
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.equal(server.match(/"\/shell-width\.js"/g).length, 2, "served and allowed as a preview read");
});
