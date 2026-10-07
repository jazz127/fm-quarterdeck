import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const code = await readFile(new URL("../public/message-font-size.js", import.meta.url), "utf8");

function prefs(storage = {}) {
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
  };
  const context = vm.createContext({ window: {}, localStorage });
  vm.runInContext(code, context);
  return context.window.messageFontSizePrefs;
}

test("message font size prefs normalize, step, and persist the rem ladder", () => {
  const storage = {};
  const api = prefs(storage);
  assert.equal(api.stored(), "M");
  assert.equal(api.normalize("nope"), "M");
  assert.equal(api.rem("L"), "1.125rem");
  assert.equal(api.step("M", 1), "L");
  assert.equal(api.step("XL", 1), "XL");
  assert.equal(api.step("S", -1), "S");
  assert.equal(api.bounds("S").atMin, true);
  assert.equal(api.bounds("S").atMax, false);
  assert.equal(api.bounds("XL").atMin, false);
  assert.equal(api.bounds("XL").atMax, true);
  api.persist("L");
  assert.equal(storage[api.KEY], "L");
  assert.equal(prefs(storage).stored(), "L");
});
