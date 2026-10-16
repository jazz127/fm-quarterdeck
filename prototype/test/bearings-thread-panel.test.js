import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { callDom, fakeTimers } from "./helpers/call-dom.js";
import { normalizeSnapshot } from "../bearings.js";

const sources = await Promise.all(["bearings-patch.js", "bearings-view.js", "bearings-thread-panel.js", "call-lifecycle.js"].map((name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8")));
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const decision = (rev = "a1") => ({ key: "decision:alpha-call", type: "decision", task: "alpha-call", summary: "Pick the alpha rollout window", rev,
  answer: { question: "alpha-call", options: [], recommend: null, close: null, freeform: true } });
const model = (cards) => ({ schema: "fm-quarterdeck-call.v1", rev: cards.map((card) => `${card.key}@${card.rev}`).join("|") || "empty", state: "ready", cards, coverage: { known: 1, checked: 1, provenClear: false }, omitted: [] });
const history = (entries = []) => ({ status: 200, body: { schema: "fm-quarterdeck-card-thread.v1", key: "decision:alpha-call", task: "alpha-call", entries, omitted: 0, transcript: { state: "ready", windowed: false }, checkedAt: "2026-01-02T00:00:00Z" } });
const KEY = "decision:alpha-call";

function tabStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.has(key) ? entries.get(key) : null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key),
    key: (index) => [...entries.keys()][index], get length() { return entries.size; } };
}

function setup({ responses = [], storage = null } = {}) {
  const dom = callDom();
  const timers = fakeTimers();
  const { document } = dom;
  const section = document.createElement("section");
  const status = document.createElement("p");
  const list = document.createElement("div");
  section.append(status, list);
  document.body.append(section);
  const win = { document, matchMedia: () => ({ matches: false }), navigator: {}, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window: win, URL, TextEncoder });
  for (const source of sources) vm.runInContext(source, context);
  const fetches = [];
  const queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    fetches.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = await (queue.shift() || history());
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status < 300, json: async () => next.body };
  };
  let n = 0;
  let threads = null;
  const patcher = win.bearingsPatch.createCallPatcher({ section, list, status, view: win.bearingsView, doc: document, win, storage, timers,
    onRender: (node, card) => threads?.render(node, card), onApply: (next) => threads?.prune(next.cards.map((card) => card.key)) });
  threads = win.bearingsThread.createThreadController({ list, drafts: patcher.drafts, doc: document, win, storage, fetchImpl, timers, uuid: () => uuid(++n) });
  const node = () => list.children.find((entry) => entry.getAttribute("data-call-key") === KEY);
  const part = (name) => node().querySelector(`[data-call-thread-${name}]`);
  const ask = () => part("form").dispatchEvent({ type: "submit", preventDefault() {} });
  return { document, timers, list, patcher, threads, fetches, node, part, ask };
}

test("a card shows the latest exchange above the text box, with a count, and keeps watching", async () => {
  const entries = [
    { kind: "chat-ask", from: "firstmate", at: "2026-01-02T09:00:00.000Z", text: "Filed a hold for alpha-call." },
    { kind: "ask", from: "captain", at: "2026-01-02T10:00:00.000Z", text: "What is alpha?", state: "replied" },
    { kind: "reply", from: "firstmate", at: "2026-01-02T11:00:00.000Z", text: "It picks the rollout window." },
  ];
  const t = setup({ responses: [history(entries)] });
  t.patcher.update(model([decision()]));
  await flush();
  const markup = t.node().innerHTML;
  const boxAt = markup.indexOf("data-call-answer-text");
  assert.ok(markup.indexOf("data-call-thread-expand") < boxAt, "expand sits above the text box");
  assert.ok(markup.indexOf("data-call-thread-history") < boxAt, "history sits above the text box");
  assert.equal(t.part("count").textContent, "Thread · 3");
  assert.equal(t.node().querySelector("[data-call-thread-toggle]"), null);
  assert.equal(t.node().querySelector("[data-call-thread-text]"), null);
  assert.equal(t.fetches.length, 1, "the card reads its history without a separate composer");
  assert.equal(t.fetches[0].url, `/api/bearings/thread?key=${encodeURIComponent(KEY)}`);
  assert.equal(t.part("expand").hidden, false);
  assert.equal(t.node().querySelector("[data-call-thread-history]").hidden, true, "history stays collapsed until expanded");
  assert.equal(t.part("log").children.length, 0);
  t.part("expand").click();
  assert.equal(t.node().querySelector("[data-call-thread-history]").hidden, false);
  assert.deepEqual([...t.part("log").children].map((entry) => entry.querySelector("strong").textContent), ["You asked", "Firstmate replied"]);
  assert.match(t.part("earlier").textContent, /1 earlier message/);
  assert.equal(t.part("history-toggle").hidden, false);
  t.part("history-toggle").click();
  assert.equal(t.node().querySelector("[data-call-thread-text]"), null, "showing earlier messages does not open a composer");
  assert.deepEqual([...t.part("log").children].map((entry) => entry.querySelector("strong").textContent), ["Firstmate asked in chat", "You asked", "Firstmate replied"]);
  assert.match(t.part("log").children[1].textContent, /replied/);
  assert.equal(t.part("log").children[2].querySelector("time").getAttribute("datetime"), "2026-01-02T11:00:00.000Z");
  t.part("history-toggle").click();
  assert.equal(t.part("log").children.length, 2, "the card can return to the latest exchange");
  assert.match(t.part("status").textContent, /^3 messages about this call/);

  // The thread survives Firstmate's next snapshot refilling the card.
  t.patcher.update(model([decision("a2")]));
  assert.equal(t.part("count").textContent, "Thread · 3");
  assert.equal(t.node().querySelector("[data-call-thread-history]").hidden, false, "expanded state survives a refill in this tab");
  assert.equal(t.part("log").children.length, 2);

  t.timers.advance(15000);
  await flush();
  assert.equal(t.fetches.length, 2, "a present card polls");
  t.timers.advance(15000);
  await flush();
  assert.equal(t.fetches.length, 3, "a loaded card keeps watching for replies");
});

test("a confirmed thread note reloads history and shows the receipt notice", async () => {
  const t = setup({ responses: [history(), history([{ kind: "ask", from: "captain", noteId: "note-accepted", at: "2026-01-02T10:00:00.000Z", text: "What is alpha?", state: "waiting" }])] });
  t.patcher.update(model([decision()]));
  await flush();
  assert.equal(t.fetches.length, 1, "history loads before any note is sent");
  assert.equal(t.part("expand").hidden, true);
  t.threads.noteSent(KEY, null, "note-accepted");
  await flush();
  assert.match(t.part("notice").textContent, /Question sent to Firstmate/);
  assert.equal(t.part("notice").hidden, false, "the send notice stays visible");
  assert.equal(t.node().querySelector("[data-call-thread-history]").hidden, true, "one entry does not duplicate the card");
  assert.equal(t.part("expand").hidden, true);
  assert.equal(t.part("log").children.length, 0);
});

test("a call that left forgets its thread", async () => {
  const storage = tabStorage();
  const t = setup({ storage, responses: [history()] });
  t.patcher.update(model([decision()]));
  await flush();
  t.patcher.update(model([]));
  assert.equal(t.threads.state(KEY), null, "a call that left forgets its thread");
  assert.ok(![...Array(storage.length).keys()].some((index) => storage.key(index)?.startsWith("fm-quarterdeck-call-thread.v1:")), "its saved state is removed");
});

test("a later reply is counted until the history is acknowledged", async () => {
  const reply = { kind: "reply", from: "firstmate", noteId: "n1", at: "2026-01-02T11:00:00Z", text: "The rollout window." };
  const t = setup({ responses: [history(), history([reply]), history([reply])] });
  t.patcher.update(model([decision()]));
  await flush();
  t.timers.advance(15000);
  await flush();
  assert.equal(t.part("expand").hidden, true, "one entry does not offer a thread");
  assert.match(t.part("count").textContent, /Thread · 1 · 1 new reply/);
  assert.equal(t.part("replies").getAttribute("role"), "status");
  assert.match(t.part("replies").textContent, /1 new reply from Firstmate/);
  t.node().querySelector("[data-call-thread-history]").click();
  assert.equal(t.part("replies").textContent, "");
  t.document.visibilityState = "hidden";
  const count = t.fetches.length;
  await t.threads.poll();
  assert.equal(t.fetches.length, count, "hidden tabs never poll");
  t.threads.destroy();
});

test("long entries stay fully readable and copy fails visibly", async () => {
  const text = "Synthetic context ".repeat(300);
  const t = setup({ responses: [history([
    { kind: "ask", from: "captain", at: "2026-01-02T10:00:00Z", text: "Earlier question" },
    { kind: "reply", from: "firstmate", at: "2026-01-02T11:00:00Z", text },
  ])] });
  t.patcher.update(model([decision()]));
  await flush();
  t.part("expand").click();
  const entry = [...t.part("log").children].find((item) => item.querySelector(".call-thread-text").textContent === text);
  assert.equal(entry.querySelector(".call-thread-text").textContent, text);
  assert.equal(entry.querySelectorAll("button").length, 1);
  assert.match(entry.querySelector("time").textContent, /ago/);
  entry.querySelector("button").click();
  await flush();
  assert.match(t.part("notice").textContent, /Copy unavailable/);
  assert.match(t.part("status").textContent, /Copy unavailable/);
});

test("recorded replies and thread messages expose safe links without changing note text or state", async () => {
  const text = 'Read https://example.invalid/acme/example-app/one. Then https://example.invalid/acme/example-app/two?a=1&b=2 (keep this note).';
  const entries = [
    { kind: "ask", from: "captain", noteId: "note-1", at: null, text, state: "replied" },
    { kind: "reply", from: "firstmate", noteId: "note-1", at: "2026-01-02T11:00:00Z", text },
  ];
  const t = setup({ responses: [history(entries), { status: 502, body: { error: "Firstmate receipts unavailable" } }] });
  t.patcher.update(model([decision()]));
  await flush();
  t.part("expand").click();
  for (const entry of t.part("log").children) {
    const body = entry.querySelector(".call-thread-text");
    assert.equal(body.textContent, text);
    const links = body.querySelectorAll("a");
    assert.deepEqual(links.map((link) => link.getAttribute("href")), ["https://example.invalid/acme/example-app/one", "https://example.invalid/acme/example-app/two?a=1&b=2"]);
    for (const link of links) {
      assert.equal(link.getAttribute("target"), "_blank");
      assert.equal(link.getAttribute("rel"), "noopener noreferrer");
      link.focus();
      assert.equal(t.document.activeElement, link);
    }
  }
  assert.match(t.part("log").textContent, /time unknown/);
  assert.match(t.part("log").textContent, /replied/);
  await t.threads.load(KEY);
  assert.equal(t.threads.state(KEY).error, "Firstmate receipts unavailable", "a recorded reply does not erase a later read failure");
  assert.equal(t.part("log").querySelectorAll("a").length, 4, "retain original reply evidence on a failed refresh");
});

test("untrusted schemes, credentials and HTML remain plain thread text", async () => {
  const text = '<img src=x onerror=alert(1)> javascript:alert(1) http://example.invalid/ https://user:secret@example.invalid/ javascript:https://example.invalid/';
  const t = setup({ responses: [history([
    { kind: "ask", from: "captain", text: "Which link?", state: "waiting" },
    { kind: "reply", from: "firstmate", text },
  ])] });
  t.patcher.update(model([decision()]));
  await flush();
  t.part("expand").click();
  const body = t.part("log").children[1].querySelector(".call-thread-text");
  assert.equal(body.textContent, text);
  assert.equal(body.querySelectorAll("a").length, 0);
  assert.equal(body.querySelectorAll("img").length, 0);
});

test("combined and contextual provenance is separately reachable, copyable and retained across refills", async () => {
  const response = history([{ kind: "ask", from: "captain", noteId: "shared", state: "replied", replyScope: "combined", text: "Explain my card" }]);
  response.body.provenance = [
    { kind: "combined-submission", from: "captain", noteId: "shared", text: "Original item A and item B", state: "replied" },
    { kind: "combined-reply", from: "firstmate", noteId: "shared", text: "Item A: window. Item B: board." },
    { kind: "context", from: "firstmate", text: "alpha-call and another task; attribution unverified" },
  ];
  const t = setup({ responses: [response] });
  t.patcher.update(model([decision()]));
  await flush();
  assert.equal(t.part("count").textContent, "Thread · 1");
  assert.equal(t.part("expand").hidden, true);
  assert.equal(t.part("provenance-toggle").hidden, false);
  assert.equal(t.part("provenance").hidden, true);
  t.part("provenance-toggle").click();
  assert.equal(t.part("provenance").hidden, false);
  assert.match(t.part("provenance-log").textContent, /Reply to the combined submission · not card-specific/);
  assert.match(t.part("provenance-log").textContent, /Item B: board/);
  assert.equal(t.part("provenance-log").querySelectorAll("button").length, 3);
  assert.equal(t.part("log").textContent, "");
  assert.equal(t.part("replies").textContent, "", "provenance is not an unread card reply");
  t.patcher.update(model([decision("a2")]));
  assert.equal(t.part("provenance").hidden, false);
  assert.match(t.part("provenance-status").textContent, /original durable records are unchanged/);
});

test("cached old-cycle notes and legacy task-only entries cannot paint as current exact history", async () => {
  const response = history([
    { kind: "ask", from: "captain", noteId: "old", holdVersion: "old", state: "replied", text: "Old question" },
    { kind: "reply", from: "firstmate", noteId: "old", text: "Old answer" },
    { kind: "chat", from: "firstmate", text: "alpha-call: contextual old scope" },
  ]);
  const t=setup({responses:[response]});
  t.patcher.update(model([{...decision(),holdVersion:"new"}]));await flush();
  assert.equal(t.part("count").textContent,"Thread · 0");
  t.part("provenance-toggle").click();
  assert.match(t.part("provenance-log").textContent,/Old question/);
  assert.match(t.part("provenance-log").textContent,/attribution unverified/);
  assert.equal(t.part("log").textContent,"");
});

for (const engaged of [false, true]) test(`hold timestamps refresh cached thread clocks with equal presentation revisions${engaged ? " after releasing a draft" : ""}`, async () => {
  const card = (at) => normalizeSnapshot({ schema: "fm-bearings.v1", decisions_open: [{ id: "alpha-call", owner: "(main)", summary: "Pick the alpha rollout window",
    reason: "Choose staged or immediate", created: "2026-10-16", ...(at ? { hold_set_at: at } : {}) }],
    contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] }).cards[0];
  const initial = card(), held = card("2026-10-15T20:00:00Z");
  const entries = [
    { kind: "ask", from: "captain", noteId: "same-cycle", holdVersion: held.holdVersion, state: "replied", at: "2026-10-15T21:00:00Z", text: "Which rollout window?" },
    { kind: "reply", from: "firstmate", noteId: "same-cycle", at: "2026-10-15T21:30:00Z", text: "Use the staged window." },
  ];
  const t = setup({ responses: [history(), history(entries), history(entries)] });
  t.patcher.update(model([initial]));
  await flush();
  if (engaged) t.node().querySelector('[data-call-draft="answer"]').type("Keep this draft");
  const apply = (next) => {
    assert.equal(next.rev, initial.rev, "hold timestamps preserve the presentation revision");
    assert.equal(next.holdVersion, initial.holdVersion, "the local creation date keeps the legacy cycle identity stable");
    assert.equal(t.patcher.update(model([next])), engaged ? "held" : "applied");
    if (engaged) {
      assert.equal(t.node().getAttribute("data-held"), "true");
      assert.ok(t.patcher.pending, "metadata changes remain pending until released");
      t.patcher.applyNow(KEY);
      assert.equal(t.patcher.pending, null);
      assert.equal(t.node().querySelector('[data-call-draft="answer"]').value, "Keep this draft");
    }
    assert.equal(t.node().getAttribute("data-call-rev"), initial.rev);
  };
  apply(held);
  await t.threads.load(KEY);
  assert.equal(t.part("count").textContent, "Thread · 2 · 1 new reply", "the 21:00 ask follows the 20:00 hold despite the next-day creation date");
  t.part("expand").click();
  assert.match(t.part("log").textContent, /Which rollout window/);
  assert.match(t.part("log").textContent, /Use the staged window/);
  await t.threads.load(KEY);
  assert.equal(t.part("count").textContent, "Thread · 2", "a history refresh retains the current exchange");
  t.timers.advance(600);
  apply(card("2026-10-15T22:00:00Z"));
  assert.equal(t.part("count").textContent, "Thread · 0", "a hold after the ask makes that exchange stale");
  apply(initial);
  assert.equal(t.part("count").textContent, "Thread · 0", "removing the hold timestamp restores the creation-clock fallback");
  apply(held);
  assert.equal(t.part("count").textContent, "Thread · 2", "adding the earlier hold timestamp restores the exchange");
  assert.equal(t.patcher.update(model([held])), "unchanged");
  t.threads.destroy();
  t.patcher.destroy();
});

test("link boundaries preserve surrounding punctuation, balanced URL paths and fragments", async () => {
  const text = 'Read (https://example.invalid/acme/example-app/a_(b)). Next https://example.invalid/acme/example-app/page?q=a&x=b#notes; done.';
  const t = setup({ responses: [history([
    { kind: "ask", from: "captain", text: "Which guide?", state: "replied" },
    { kind: "reply", from: "firstmate", text },
  ])] });
  t.patcher.update(model([decision()]));
  await flush();
  t.part("expand").click();
  const body = t.part("log").children[1].querySelector(".call-thread-text");
  assert.equal(body.textContent, text);
  assert.deepEqual(body.querySelectorAll("a").map((link) => link.getAttribute("href")), ["https://example.invalid/acme/example-app/a_(b)", "https://example.invalid/acme/example-app/page?q=a&x=b#notes"]);
});
