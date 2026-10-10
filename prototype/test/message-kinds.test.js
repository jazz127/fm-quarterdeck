import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const code = await readFile(new URL("../public/message-kinds.js", import.meta.url), "utf8");

function kinds(storage = {}) {
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem(key, value) { storage[key] = String(value); },
  };
  const context = vm.createContext({ window: {}, localStorage });
  vm.runInContext(code, context);
  return context.window.messageKinds;
}

test("message kinds catalog defaults, migrates legacy prefs, and maps type ids", () => {
  const api = kinds();
  assert.equal(api.TYPES[0].id, "captain");
  assert.equal(api.TYPES[1].label, "Firstmate replies");
  assert.ok(api.TYPES.some((type) => type.id === "crew"));
  assert.equal(api.stored().has("captain"), true);
  assert.equal(api.stored().has("crew"), false);
  assert.equal(api.typeId({ role: "captain", kind: "conversation" }), "captain");
  assert.equal(api.typeId({ role: "firstmate", kind: "thinking" }), "thinking");
  assert.equal(api.typeId({ role: "firstmate" }), "conversation");
  // Unverified transcript/inbox input has its own kind, outside the default feed and never captain.
  assert.equal(api.typeId({ role: "input", kind: "input", author: "Pi session input" }), "input");
  assert.equal(api.label("input"), "unverified input");
  assert.equal(api.stored().has("input"), false);
  assert.equal(api.DEFAULT_IDS.includes("input"), false);
  assert.equal(api.label("conversation"), "Firstmate replies");
  assert.equal(api.label("narration"), "Firstmate progress");
  assert.equal(api.known("narration"), true);
  assert.equal(api.DEFAULT_IDS.includes("narration"), false);
  assert.equal(api.stored().has("narration"), false);
  assert.equal(api.typeId({ role: "firstmate", kind: "narration" }), "narration");
  const saved = {};
  saved[api.KEY] = JSON.stringify(["captain", "conversation", "supervision"]);
  assert.equal(kinds(saved).stored().has("narration"), false, "a stored preference does not gain progress lines");
  assert.equal(api.icon("tools"), "tools");
  assert.match(api.svg("tools"), /message-kind-svg/);
  assert.match(api.svg("unknown-kind"), /circle|M9\.1 9/);

  const legacy = {};
  legacy[api.LEGACY_KEY] = JSON.stringify(["conversation", "thinking"]);
  const migrated = kinds(legacy).stored();
  assert.equal(migrated.has("conversation"), true);
  assert.equal(migrated.has("captain"), true);
  assert.equal(migrated.has("supervision"), true);
  assert.equal(migrated.has("thinking"), true);
});
