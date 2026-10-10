import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { callDom, fakeTimers } from "./helpers/call-dom.js";

const sources = await Promise.all(["bearings-view.js", "bearings-landed.js", "overview-tabs.js"].map((name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8")));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const landing = (task = "ship-window", rev = "a1") => ({ key: `landed:${task}`, task, rev, what: `Land ${task}`, repo: "example-app", owner: "(main)", artifact: "local main", clock: { label: "Landed", at: "2026-10-01" } });

function setup() {
  const dom = callDom();
  const timers = fakeTimers();
  const context = vm.createContext({ window: { document: dom.document }, URL, TextEncoder });
  for (const source of sources) vm.runInContext(source, context);
  const list = dom.document.createElement("div");
  list.innerHTML = '<p data-landed-empty></p>';
  const toggle = dom.document.createElement("button");
  dom.document.body.append(toggle, list);
  let entries = [];
  const acks = {};
  const sends = [];
  const board = context.window.bearingsLanded.createController({
    list, toggle, doc: dom.document, timers, uuid: () => "00000000-0000-4000-8000-000000000001",
    fetchImpl: async (url, options) => {
      if (options?.method === "POST") {
        const body = JSON.parse(options.body);
        if (url.endsWith("/ack")) acks[body.key] = list.querySelector(`[data-landed-key="${body.key}"]`).getAttribute("data-landed-rev");
        else sends.push(body);
      }
      return { ok: true, json: async () => url.includes("/thread") ? { entries } : { acks: { ...acks } } };
    },
  });
  const update = (landed) => board.update({ state: "ready", landed, omitted: [] });
  const node = (key = "landed:ship-window") => list.querySelector(`[data-landed-key="${key}"]`);
  return { ...dom, timers, context, board, list, toggle, update, node, sends, history(next) { entries = next; } };
}

test("BEARINGS landed refreshes preserve editor identity, focus, selection and drafts", async () => {
  const t = setup();
  await flush();
  const first = landing();
  const second = landing("notes");
  t.update([first, second]);
  await flush();
  const card = t.node();
  const box = card.querySelector("[data-landed-text]");
  box.type("Follow up on the window");
  box.setSelectionRange(3, 12, "backward");
  t.update([{ ...first }, { ...second }]);
  assert.equal(t.document.activeElement, box, "an unrelated call update must not detach the editor");
  assert.equal(t.node(), card);
  assert.deepEqual([box.selectionStart, box.selectionEnd, box.selectionDirection], [3, 12, "backward"]);
  t.update([{ ...first, rev: "a2", what: "Updated landing" }, second]);
  assert.equal(t.node(), card);
  assert.equal(card.querySelector("h3").textContent, "Updated landing");
  assert.equal(card.querySelector("[data-landed-text]"), box);
  assert.equal(t.document.activeElement, box);
  assert.equal(box.value, "Follow up on the window");
  t.update([second, { ...first, rev: "a2", what: "Updated landing" }]);
  assert.deepEqual(t.list.querySelectorAll("[data-landed-key]").map((node) => node.getAttribute("data-landed-key")), [second.key, first.key]);
  assert.equal(t.document.activeElement, box);
  assert.deepEqual([box.selectionStart, box.selectionEnd, box.selectionDirection], [3, 12, "backward"]);
  t.update([{ ...first, rev: "a2", what: "Updated landing" }, second]);
  assert.equal(t.document.activeElement, box, "moving the edited card restores its focus");
  assert.deepEqual([box.selectionStart, box.selectionEnd, box.selectionDirection], [3, 12, "backward"]);
  card.querySelector("[data-landed-follow]").dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(box.disabled, true);
  t.update([second, { ...first, rev: "a3" }]);
  assert.equal(card.querySelector("[data-landed-preview]").textContent, "Follow up on the window");
  assert.equal(card.querySelector("[data-landed-send]").hidden, false);
  card.querySelector("[data-landed-edit]").click();
  assert.equal(box.disabled, false);
  assert.equal(box.value, "Follow up on the window");
  card.querySelector("[data-landed-follow]").dispatchEvent({ type: "submit", preventDefault() {} });
  card.querySelector("[data-landed-send]").dispatchEvent({ type: "click", preventDefault() {} });
  await flush();
  assert.deepEqual(t.sends, [{ requestId: "00000000-0000-4000-8000-000000000001", key: first.key, text: "Follow up on the window" }]);
  box.blur();
  t.update([second, { ...first, rev: "a3" }]);
  assert.equal(box.value, "");
  card.querySelector("[data-landed-ack]").dispatchEvent({ type: "click", preventDefault() {} });
  await flush();
  assert.equal(card.hidden, true);
  t.toggle.click();
  assert.equal(card.hidden, false);
  assert.equal(card.querySelector("[data-landed-ack]").textContent, "Acknowledged");
  t.board.destroy();
});

test("landed history polls keep selected text connected and append new replies in place", async () => {
  const t = setup();
  await flush();
  const entries = [{ from: "captain", text: "How did the landing go?" }, { from: "firstmate", text: "The window landed." }];
  t.history(entries);
  t.update([landing()]);
  await flush();
  const card = t.node();
  card.querySelector("[data-landed-thread-expand]").click();
  const log = card.querySelector("[data-landed-thread-log]");
  const selected = log.children[1].querySelector(".call-thread-text");
  t.selection.selectAllChildren(selected);
  t.timers.advance(15000);
  await flush();
  assert.equal(log.children[1].querySelector(".call-thread-text"), selected);
  assert.equal(selected.isConnected, true);
  assert.equal(t.selection.node, selected);
  t.history([...entries, { from: "firstmate", text: "The next window is ready." }]);
  t.timers.advance(15000);
  await flush();
  assert.equal(log.children.length, 3);
  assert.equal(log.children[1].querySelector(".call-thread-text"), selected);
  assert.equal(selected.isConnected, true);
  assert.equal(log.children[2].querySelector(".call-thread-text").textContent, "The next window is ready.");
  t.update([{ ...landing(), rev: "a2", what: "Revised window" }]);
  assert.equal(t.node().querySelector("[data-landed-thread-log]"), log);
  assert.equal(selected.isConnected, true);
  t.board.destroy();
});

test("BEARINGS phone panels leave populated second mates visible on both tabs", async () => {
  const t = setup();
  await flush();
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const root = t.document.createElement("main");
  root.innerHTML = html.slice(html.indexOf('<section id="overview-view"'), html.indexOf('<section id="work-view"'));
  t.document.body.append(root);
  const query = (id) => root.querySelector(`[id="${id}"]`);
  const mates = query("secondmates-section");
  mates.hidden = false;
  const calls = query("overview-primary");
  const landed = query("overview-secondary");
  const tabs = query("overview-section-tabs");
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  const phone = t.context.window.overviewTabs.createController({ root: query("overview-view"), tabs, panels: { calls, landed }, media, doc: t.document });
  const visible = (node) => { for (let parent = node; parent; parent = parent.parentNode) if (parent.hidden) return false; return true; };
  for (const name of ["landed", "calls"]) {
    tabs.querySelector(`[data-overview-tab="${name}"]`).click();
    assert.equal(visible(calls), name === "calls");
    assert.equal(visible(landed), name === "landed");
    assert.equal(visible(mates), true);
  }
  media.matches = false;
  phone.paint();
  assert.equal(visible(calls), true);
  assert.equal(visible(landed), true);
  assert.equal(visible(mates), true);
  phone.destroy();
  t.board.destroy();
});
