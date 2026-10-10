import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const source = app.slice(app.indexOf("let healthPreferencesLoaded = false;"), app.indexOf("let preferencesRefreshing = false;"));
function ui(value = { awayCheckInMinutes: 10, openNoteAlarmMinutes: 15 }) {
  const nodes = Object.fromEntries(["#away-check-in", "#open-note-alarm", "#health-preferences-status", "#health-preferences-form", "#health-preferences-form button"].map(key => [key, { value: "", disabled: true, textContent: "", addEventListener(type, fn) { this[type] = fn; } }]));
  let saved, failed = false;
  const context = vm.createContext({ $: key => nodes[key], fetchJson: async () => { if (failed) throw new Error(); return value; }, fetch: async (url, options) => { saved = JSON.parse(options.body); return { ok: !failed }; } });
  vm.runInContext(source, context);
  return { nodes, refresh: () => vm.runInContext("refreshHealthPreferences()", context), submit: () => nodes["#health-preferences-form"].submit({ preventDefault() {} }), saved: () => saved, fail: () => { failed = true; } };
}
test("health form loads saved settings, preserves unsaved edits on refresh, explicitly saves integer payload", async () => {
  const form = ui(); await form.refresh();
  assert.equal(form.nodes["#away-check-in"].value, 10);
  assert.equal(form.nodes["#health-preferences-form button"].disabled, false);
  form.nodes["#away-check-in"].value = "30";
  form.nodes["#open-note-alarm"].value = "5";
  await form.refresh(); assert.equal(form.nodes["#away-check-in"].value, "30");
  await form.submit(); assert.deepEqual(form.saved(), { awayCheckInMinutes: 30, openNoteAlarmMinutes: 5 });
  assert.match(form.nodes["#health-preferences-status"].textContent, /Saved/);
  const reload = ui(form.saved()); await reload.refresh(); assert.equal(reload.nodes["#away-check-in"].value, 30);
});
test("unavailable loads disable save and failed writes retain edits and allow retry", async () => {
  const form = ui(); form.fail(); await form.refresh();
  assert.equal(form.nodes["#health-preferences-form button"].disabled, true);
  assert.match(form.nodes["#health-preferences-status"].textContent, /unavailable/);
  const loaded = ui(); await loaded.refresh(); loaded.nodes["#away-check-in"].value = "20"; loaded.fail(); await loaded.submit();
  assert.equal(loaded.nodes["#away-check-in"].value, "20");
  assert.equal(loaded.nodes["#health-preferences-form button"].disabled, false);
  assert.match(loaded.nodes["#health-preferences-status"].textContent, /retry/);
});
test("phone and desktop form use responsive tracks, bounded controls and minute constraints", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(css, /\.health-preferences-form \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 260px\), 1fr\)\)/);
  assert.match(css, /\.health-preferences-form input \{[^}]*width: 100%[^}]*min-height: 44px/);
  for (const id of ["away-check-in", "open-note-alarm"]) assert.match(html, new RegExp(`id="${id}"[^>]*type="number" min="1" max="1440" step="1"`));
});
