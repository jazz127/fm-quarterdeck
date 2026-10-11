import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { callDom, fakeTimers } from "./helpers/call-dom.js";

const sources = ["bearings-view.js", "bearings-landed.js", "overview-tabs.js"].map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
  };
}

function mediaQuery(matches) {
  const listeners = [];
  return {
    get matches() { return matches.value; },
    addEventListener(_type, fn) { listeners.push(fn); },
    removeEventListener(_type, fn) { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
    change() { for (const fn of [...listeners]) fn(); },
    listeners,
  };
}

function mount(dom) {
  const context = vm.createContext({ window: { document: dom.document }, URL, TextEncoder });
  for (const source of sources) vm.runInContext(source, context);
  const root = dom.document.createElement("section");
  const tabs = dom.document.createElement("div");
  tabs.innerHTML = `<button type="button" id="overview-tab-calls" data-overview-tab="calls">Captain's Call (0)</button><button type="button" id="overview-tab-landed" data-overview-tab="landed">Just landed (0)</button>`;
  const calls = dom.document.createElement("div");
  const landed = dom.document.createElement("div");
  const inside = dom.document.createElement("button");
  inside.textContent = "Inside calls";
  calls.append(inside);
  root.append(tabs, calls, landed);
  dom.document.body.append(root);
  return { context, root, tabs, calls, landed, inside };
}

function press(node, key) {
  let prevented = false;
  node.dispatchEvent({ type: "keydown", key, preventDefault() { prevented = true; } });
  return prevented;
}

test("phone tabs switch one Overview section and remember the choice", () => {
  const dom = callDom();
  const { context, root, tabs, calls, landed, inside } = mount(dom);
  const storage = memoryStorage();
  const matches = { value: true };
  const media = mediaQuery(matches);
  let callCount = 3;
  let landedCount = 2;
  const controller = context.window.overviewTabs.createController({
    root, tabs, panels: { calls, landed },
    counts: { calls: () => callCount, landed: () => landedCount },
    storage, media, doc: dom.document,
  });
  const callsTab = tabs.querySelector('[data-overview-tab="calls"]');
  const landedTab = tabs.querySelector('[data-overview-tab="landed"]');
  assert.equal(tabs.getAttribute("role"), "tablist");
  assert.equal(callsTab.getAttribute("role"), "tab");
  assert.equal(callsTab.getAttribute("aria-selected"), "true");
  assert.equal(callsTab.getAttribute("tabindex"), "0");
  assert.equal(landedTab.getAttribute("tabindex"), "-1");
  assert.equal(callsTab.textContent, "Captain's Call (3)");
  assert.equal(landedTab.textContent, "Just landed (2)");
  assert.equal(calls.hidden, false);
  assert.equal(landed.hidden, true);
  assert.equal(calls.getAttribute("role"), "tabpanel");
  assert.equal(root.getAttribute("data-overview-tab"), "calls");
  inside.focus();
  landedTab.click();
  assert.equal(storage.getItem(context.window.overviewTabs.KEY), "landed");
  assert.equal(landed.hidden, false);
  assert.equal(calls.hidden, true);
  assert.equal(landedTab.getAttribute("aria-selected"), "true");
  assert.equal(callsTab.getAttribute("aria-selected"), "false");
  assert.equal(dom.document.activeElement, landedTab);
  assert.equal(press(landedTab, "ArrowRight"), true);
  assert.equal(calls.hidden, false);
  assert.equal(landed.hidden, true);
  assert.equal(dom.document.activeElement, callsTab);
  assert.equal(press(callsTab, "End"), true);
  assert.equal(landedTab.getAttribute("aria-selected"), "true");
  assert.equal(press(landedTab, "Home"), true);
  assert.equal(callsTab.getAttribute("aria-selected"), "true");
  assert.equal(press(callsTab, "ArrowLeft"), true);
  assert.equal(landedTab.getAttribute("aria-selected"), "true");
  callCount = 0;
  landedCount = 4;
  controller.paint();
  assert.equal(callsTab.textContent, "Captain's Call (0)");
  assert.equal(landedTab.textContent, "Just landed (4)");
  matches.value = false;
  media.change();
  assert.equal(calls.hidden, false);
  assert.equal(landed.hidden, false);
  assert.equal(tabs.getAttribute("role"), null);
  assert.equal(calls.getAttribute("role"), null);
  assert.equal(callsTab.getAttribute("role"), null);
  assert.equal(root.getAttribute("data-overview-tab"), null);
  matches.value = true;
  media.change();
  assert.equal(landed.hidden, false, "the phone returns to the remembered tab");
  assert.equal(calls.hidden, true);
  controller.destroy();
  assert.equal(media.listeners.length, 0);
  callsTab.click();
  assert.equal(calls.hidden, true, "a destroyed controller ignores clicks");
});

test("desktop shows both columns and a remembered phone tab stays stored", () => {
  const dom = callDom();
  const { context, tabs, calls, landed } = mount(dom);
  const storage = memoryStorage({ "fm-quarterdeck-overview-tab.v1": "landed" });
  context.window.overviewTabs.createController({
    tabs, panels: { calls, landed }, storage, media: mediaQuery({ value: false }), doc: dom.document,
  });
  assert.equal(calls.hidden, false);
  assert.equal(landed.hidden, false);
  assert.equal(tabs.getAttribute("role"), null);
  assert.equal(storage.getItem("fm-quarterdeck-overview-tab.v1"), "landed");
});

test("an unknown stored tab starts on Captain's Call", () => {
  const dom = callDom();
  const { context, tabs, calls, landed } = mount(dom);
  context.window.overviewTabs.createController({
    tabs, panels: { calls, landed },
    storage: memoryStorage({ "fm-quarterdeck-overview-tab.v1": "nope" }),
    media: mediaQuery({ value: true }),
    doc: dom.document,
  });
  assert.equal(calls.hidden, false);
  assert.equal(landed.hidden, true);
});

test("a landed card continues a title, discloses a different one, and expands a shortened artifact on its own", async () => {
  const dom = callDom();
  const timers = fakeTimers();
  const { context } = mount(dom);
  const view = context.window.bearingsView;
  const landed = context.window.bearingsLanded;
  const continued = landed.cardHtml({ key: "landed:ship-window", task: "ship-window", what: "Ship the example-app release…", backlogTitle: "Ship the example-app release window", repo: "example-app", owner: "(main)", url: "https://example.invalid/acme/example-app/pull/42", artifact: null, clock: { label: "Landed", at: "2026-10-01" } });
  assert.match(continued, /<h3[^>]*>Ship the example-app release window<\/h3>/);
  assert.doesNotMatch(continued, /data-call-text-toggle|snapshot shortened/);
  assert.match(continued, /https:\/\/example\.invalid\/acme\/example-app\/pull\/42/);
  const list = dom.document.createElement("div");
  dom.document.body.append(list);
  const changes = [];
  const rev = "a".repeat(16);
  const both = { key: "landed:local-notes", task: "local-notes", rev, what: "Notes from the other ledger…", backlogTitle: "Land the sample notes on local main", artifact: "https://example.invalid/pull/…", repo: "sample-notes", owner: "(main)", clock: { label: "Landed", at: null } };
  const other = { key: "landed:ship-window", task: "ship-window", rev: "b".repeat(16), what: "Ship the example-app release window", repo: "example-app", owner: "(main)", url: "https://example.invalid/acme/example-app/pull/42", artifact: null, clock: { label: "Landed", at: "2026-10-01" } };
  const board = landed.createController({
    list, doc: dom.document, timers, onChange: () => changes.push(board?.count?.() ?? 0),
    fetchImpl: async () => ({ ok: true, json: async () => ({ acks: { [both.key]: rev } }) }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  board.update({ state: "ready", landed: [both, other], omitted: [] });
  assert.equal(board.count(), 2);
  assert.ok(changes.includes(2));
  const card = list.querySelector('[data-landed-key="landed:local-notes"]');
  assert.equal(card.hidden, true, "an acknowledged landing stays in the count");
  const toggles = [...card.querySelectorAll("[data-call-text-toggle]")];
  assert.equal(toggles.length, 2);
  assert.equal(toggles[0].textContent, "Notes from the other ledger…");
  assert.equal(toggles[1].textContent, "https://example.invalid/pull/…");
  const panel = (toggle) => card.querySelector(`[id="${toggle.getAttribute("aria-controls")}"]`);
  toggles[0].click();
  assert.equal(panel(toggles[0]).hidden, false);
  assert.match(panel(toggles[0]).textContent, /Backlog title/);
  assert.match(panel(toggles[0]).textContent, /Land the sample notes on local main/);
  assert.equal(panel(toggles[1]).hidden, true);
  toggles[1].click();
  assert.equal(panel(toggles[0]).hidden, false);
  assert.equal(panel(toggles[1]).hidden, false);
  assert.match(panel(toggles[1]).textContent, /This is the full text Quarterdeck received/);
  toggles[0].click();
  assert.equal(panel(toggles[0]).hidden, true);
  assert.equal(panel(toggles[1]).hidden, false);
  assert.match(card.textContent, /snapshot shortened this landing/);
  assert.equal(view.sourceShortened("https://example.invalid/pull/…"), true);
  board.destroy();
});

test("the Just landed heading badge and phone tab count only unacknowledged landings", async () => {
  const dom = callDom();
  const timers = fakeTimers();
  const { context, root, tabs, calls, landed } = mount(dom);
  const list = dom.document.createElement("div");
  const empty = dom.document.createElement("p");
  empty.setAttribute("data-landed-empty", "");
  list.append(empty);
  const toggle = dom.document.createElement("button");
  toggle.id = "landed-ack-toggle";
  const badge = dom.document.createElement("b");
  badge.id = "landed-new-count";
  badge.className = "call-badge";
  badge.hidden = true;
  badge.textContent = "0";
  const heading = dom.document.createElement("h2");
  heading.id = "just-landed-heading";
  heading.textContent = "Just landed ";
  heading.append(badge);
  landed.append(heading, toggle, list);
  const rev = "a".repeat(16);
  const otherRev = "b".repeat(16);
  const acked = { key: "landed:local-notes", task: "local-notes", rev, what: "Notes", artifact: "local main", repo: "sample-notes", owner: "(main)", clock: { label: "Landed", at: "2026-10-02" } };
  const fresh = { key: "landed:ship-window", task: "ship-window", rev: otherRev, what: "Ship the window", repo: "example-app", owner: "(main)", url: "https://example.invalid/acme/example-app/pull/42", artifact: null, clock: { label: "Landed", at: "2026-10-01" } };
  const records = { [acked.key]: rev };
  const board = context.window.bearingsLanded.createController({
    list, toggle, badge, doc: dom.document, timers,
    onChange: () => phone.paint(),
    fetchImpl: async (url, options) => {
      if (String(url).includes("/landed/ack") && options?.method === "POST") {
        records[JSON.parse(options.body).key] = otherRev;
      }
      if (String(url).includes("/thread")) return { ok: true, json: async () => ({ entries: [] }) };
      return { ok: true, json: async () => ({ acks: { ...records } }) };
    },
  });
  const phone = context.window.overviewTabs.createController({
    root, tabs, panels: { calls, landed },
    counts: { calls: () => 3, landed: () => board.newCount() },
    storage: memoryStorage(), media: mediaQuery({ value: true }), doc: dom.document,
  });
  const landedTab = tabs.querySelector('[data-overview-tab="landed"]');
  await new Promise((resolve) => setImmediate(resolve));
  board.update({ state: "ready", landed: [acked, fresh], omitted: [] });
  assert.equal(board.count(), 2, "the section still holds acknowledged cards");
  assert.equal(board.newCount(), 1);
  assert.equal(badge.textContent, "1");
  assert.equal(badge.hidden, false);
  assert.equal(badge.getAttribute("aria-label"), "1 new landing");
  assert.equal(heading.contains(badge), true);
  assert.equal(landedTab.textContent, "Just landed (1)");
  const ack = list.querySelector('[data-landed-key="landed:ship-window"]').querySelector('[data-landed-ack]');
  ack.dispatchEvent({ type: "click", preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(board.newCount(), 0);
  assert.equal(badge.textContent, "0");
  assert.equal(badge.hidden, true);
  assert.equal(landedTab.textContent, "Just landed (0)");
  toggle.click();
  assert.equal(list.querySelector('[data-landed-key="landed:ship-window"]').hidden, false);
  assert.equal(board.newCount(), 0, "reviewing an acknowledged landing does not make it new");
  assert.equal(landedTab.textContent, "Just landed (0)");
  board.destroy();
  phone.destroy();
});

test('four phone sections preserve landed navigation and expose only the selected work panel', () => {
  const dom = callDom(), { context, root, tabs, calls, landed } = mount(dom);
  const secondary = dom.document.createElement('div');
  const underway = dom.document.createElement('section'), charted = dom.document.createElement('section');
  for (const name of ['underway', 'charted']) { const button = dom.document.createElement('button'); button.setAttribute('data-overview-tab', name); tabs.append(button); }
  secondary.append(landed, underway, charted); root.append(secondary);
  const matches = { value: true }, media = mediaQuery(matches), storage = memoryStorage();
  const controller = context.window.overviewTabs.createController({ root, tabs, secondary, panels: {calls,landed,underway,charted}, counts: { underway: () => 2, charted: () => 1 }, media, storage, doc: dom.document });
  assert.equal(secondary.hidden, true);
  const tab = tabs.querySelector('[data-overview-tab="underway"]'); tab.click();
  assert.equal(calls.hidden, true); assert.equal(secondary.hidden, false); assert.equal(landed.hidden, true); assert.equal(underway.hidden, false); assert.equal(charted.hidden, true);
  assert.equal(tab.textContent, 'Underway (2)');
  press(tab, 'ArrowRight'); assert.equal(charted.hidden, false); assert.equal(underway.hidden, true);
  assert.equal(storage.getItem(context.window.overviewTabs.KEY), 'charted');
  matches.value = false; media.change();
  for (const panel of [calls,landed,underway,charted,secondary]) assert.equal(panel.hidden, false);
  controller.destroy();
});
