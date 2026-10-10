import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { callDom, fakeTimers } from "./helpers/call-dom.js";

const code = await readFile(new URL("../public/bearings-patch.js", import.meta.url), "utf8");

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (key) => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

const card = (key, summary, extra = {}) => ({ key, type: key.split(":")[0], task: key.split(":")[1], summary, rev: `${summary}`.replace(/\W+/g, "-").slice(0, 16), ...extra });
const model = (cards, extra = {}) => ({ schema: "fm-quarterdeck-call.v1", rev: cards.map((entry) => `${entry.key}@${entry.rev}`).join("|") || "empty", state: "ready", cards, coverage: { known: 3, checked: 3, provenClear: false }, omitted: [], ...extra });
// Product rendering lives in bearings-view.js; this one carries one draft field per card.
const view = {
  cardHtml: (entry) => `<p data-summary>${entry.summary}</p><button type="button" data-copy>Copy</button><textarea data-call-draft="note"></textarea><input data-call-draft="other">`,
};

function setup({ storage = memoryStorage(), clipboard, scroller } = {}) {
  const dom = callDom();
  const timers = fakeTimers();
  const { document } = dom;
  const section = document.createElement("section");
  const status = document.createElement("p");
  const list = document.createElement("div");
  const coverage = document.createElement("p");
  const sortControl = document.createElement("select");
  const sortLabel = document.createElement("label");
  sortLabel.append(sortControl);
  const outside = document.createElement("button");
  section.append(sortLabel, status, list, coverage);
  document.body.append(section, outside);
  const scrolls = [];
  const win = { document, matchMedia: () => ({ matches: false }), navigator: { clipboard }, scrollBy: (x, y) => scrolls.push(y) };
  const context = vm.createContext({ window: win });
  vm.runInContext(code, context);
  const patcher = win.bearingsPatch.createCallPatcher({ section, list, status, coverage, view, doc: document, win, storage, timers, scroller, sortControl });
  const cardNode = (key) => list.children.find((node) => node.getAttribute("data-call-key") === key);
  return { dom, timers, document, section, status, list, coverage, outside, patcher, storage, cardNode, scrolls, sortControl, api: win.bearingsPatch };
}

const A = card("decision:alpha-call", "Pick the alpha window");
const B = card("merge:beta-merge", "Merge beta");
const C = card("decision:gamma-credential", "Provide gamma credential");

test("first model renders keyed cards in order with coverage; an empty model shows the honest empty state", () => {
  const { list, coverage, patcher, cardNode } = setup();
  assert.equal(patcher.update(model([A, B])), "applied");
  assert.deepEqual(list.children.map((node) => node.getAttribute("data-call-key")), [A.key, B.key]);
  assert.equal(cardNode(A.key).getAttribute("data-call-rev"), A.rev);
  assert.equal(cardNode(A.key).getAttribute("data-call-type"), "decision");
  assert.equal(cardNode(A.key).classList.contains("call-card-new"), false, "nothing is highlighted on first paint");
  assert.equal(coverage.textContent, "checked 3 of 3");
  patcher.update(model([], { coverage: { known: 3, checked: 2, provenClear: false } }));
  assert.equal(list.querySelector("[data-call-empty]").textContent, "No decision is recorded");
  assert.equal(coverage.textContent, "checked 2 of 3");
});

test("unengaged patches touch only the changed card; new cards insert, order moves nodes, gone cards fade out", () => {
  const { list, patcher, cardNode, timers } = setup();
  patcher.update(model([A, B]));
  const alpha = cardNode(A.key), beta = cardNode(B.key);
  const alphaSummary = alpha.querySelector("[data-summary]");
  const betaSummary = beta.querySelector("[data-summary]");

  const B2 = { ...B, summary: "Merge beta now green", rev: "beta-2" };
  assert.equal(patcher.update(model([A, B2])), "applied");
  assert.equal(cardNode(A.key), alpha, "unchanged card keeps its node");
  assert.equal(alpha.querySelector("[data-summary]"), alphaSummary, "and its children");
  assert.equal(cardNode(B.key), beta, "a changed card keeps its outer node");
  assert.notEqual(beta.querySelector("[data-summary]"), betaSummary, "only its content is replaced");
  assert.equal(beta.querySelector("[data-summary]").textContent, "Merge beta now green");

  patcher.update(model([C, B2, A]));
  const gamma = cardNode(C.key);
  assert.deepEqual(list.children.map((node) => node.getAttribute("data-call-key")), [C.key, B.key, A.key]);
  assert.equal(cardNode(A.key), alpha, "reordering moves nodes rather than recreating them");
  assert.equal(gamma.classList.contains("call-card-new"), true, "a new call is highlighted once");
  timers.advance(2400);
  assert.equal(gamma.classList.contains("call-card-new"), false);

  patcher.update(model([C, A]));
  assert.equal(beta.classList.contains("call-card-leaving"), true);
  assert.equal(beta.getAttribute("aria-hidden"), "true");
  timers.advance(320);
  assert.equal(beta.isConnected, false);
  assert.deepEqual(list.children.map((node) => node.getAttribute("data-call-key")), [C.key, A.key]);
});

test("typing holds only its card: neighbours insert/remove immediately, local notice and one rebuild after blur", () => {
  const { list, section, status, patcher, cardNode, timers, storage } = setup();
  patcher.update(model([A, B]));
  const field = cardNode(A.key).querySelector("[data-call-draft=\"note\"]");
  field.type("Ask about the rollback window");
  assert.equal(storage.getItem("fm-quarterdeck-call-draft.v1:decision:alpha-call"), JSON.stringify({ note: "Ask about the rollback window" }));

  const alpha = cardNode(A.key);
  const A2 = { ...A, summary: "Pick the alpha window (moved)", rev: "alpha-2" };
  assert.equal(patcher.update(model([A2, C])), "held");
  assert.equal(alpha.querySelector('[data-call-draft="note"]'), field, "engaged field is untouched");
  assert.ok(cardNode(C.key), "new neighbour appears immediately");
  assert.ok(cardNode(B.key).classList.contains("call-card-leaving"), "unengaged removal starts immediately");
  assert.equal(section.getAttribute("data-held"), null);
  assert.equal(section.getAttribute("aria-busy"), null);
  assert.equal(status.hidden, true);
  assert.equal(status.querySelector("[data-call-update-now]"), null);
  assert.equal(alpha.getAttribute("data-held"), "true");
  assert.equal(alpha.querySelector("[data-call-held]").getAttribute("role"), "status");
  assert.equal(alpha.querySelector("[data-call-held-text]").textContent, "Call updated — updates when you're done");
  assert.equal(field.value, "Ask about the rollback window", "the typed text is untouched");
  assert.ok(section.getAttribute("inert") === null && section.getAttribute("disabled") === null, "never inert: copy and editing keep working");
  assert.equal(alpha.querySelector("[data-summary]").textContent, A.summary);

  const A3 = { ...A, summary: "Pick the alpha window (final)", rev: "alpha-3" };
  assert.equal(patcher.update(model([A3, C])), "held", "a newer update replaces the pending one");
  assert.equal(alpha.querySelector('[data-call-draft="note"]'), field);
  assert.equal(patcher.pending.cards[0].rev, "alpha-3");

  field.blur();
  timers.advance(0);
  timers.advance(599);
  assert.equal(alpha.querySelector('[data-call-draft="note"]'), field, "the rebuild waits out the grace period");
  timers.advance(1);
  assert.equal(patcher.held, false);
  assert.equal(section.getAttribute("data-held"), null);
  assert.equal(status.hidden, true);
  assert.equal(patcher.applied.cards[0].rev, "alpha-3", "only the newest model is applied");
  const rebuilt = cardNode(A.key).querySelector("[data-call-draft=\"note\"]");
  assert.notEqual(rebuilt, field, "the changed card was rebuilt");
  assert.equal(rebuilt.value, "Ask about the rollback window", "and its draft survived the rebuild");
  timers.advance(5000);
  assert.equal(patcher.applied.cards[0].rev, "alpha-3");
});

test("moving focus between fields of one card, or straight back, never triggers a rebuild", () => {
  const { list, patcher, cardNode, timers } = setup();
  patcher.update(model([A]));
  const note = cardNode(A.key).querySelector("[data-call-draft=\"note\"]");
  const other = cardNode(A.key).querySelector("[data-call-draft=\"other\"]");
  note.focus();
  patcher.update(model([{ ...A, rev: "alpha-2", summary: "x" }]));
  const before = list.innerHTML;
  other.focus();
  timers.advance(1000);
  assert.equal(list.innerHTML, before);
  other.blur();
  timers.advance(300);
  other.focus();
  timers.advance(1000);
  assert.equal(list.innerHTML, before, "refocusing inside the grace period keeps the hold");
  assert.equal(patcher.held, true);
});

test("a text selection inside the section holds updates until it collapses", () => {
  const { dom, list, patcher, cardNode, timers } = setup();
  patcher.update(model([A, B]));
  dom.selection.selectAllChildren(cardNode(B.key).querySelector("[data-summary]"));
  assert.equal(patcher.tracker.engaged(), true);
  const summary = cardNode(B.key).querySelector("[data-summary]");
  assert.equal(patcher.update(model([A])), "held");
  timers.advance(5000);
  assert.equal(cardNode(B.key).querySelector("[data-summary]"), summary, "selected text stays put for copying");
  assert.equal(cardNode(B.key).querySelector("[data-call-held-text]").textContent, "Call resolved — updates when you're done");
  assert.equal(cardNode(B.key).classList.contains("call-card-leaving"), false);
  dom.selection.removeAllRanges();
  timers.advance(600);
  assert.equal(patcher.held, false);
  assert.equal(cardNode(B.key).classList.contains("call-card-leaving"), true);
});

test("a selection elsewhere on the page does not hold the section", () => {
  const { dom, outside, patcher } = setup();
  patcher.update(model([A]));
  dom.selection.selectAllChildren(outside);
  assert.equal(patcher.tracker.engaged(), false);
  assert.equal(patcher.update(model([A, B])), "applied");
});

test("a pointer press holds until release; a clicked card stays selected until Escape, a second click or a click outside", () => {
  const { list, outside, patcher, cardNode, timers, document } = setup();
  patcher.update(model([A, B]));
  const alpha = cardNode(A.key);
  alpha.dispatchEvent({ type: "pointerdown" });
  assert.equal(patcher.update(model([A])), "applied", "pointer on alpha does not hold beta's removal");
  document.dispatchEvent({ type: "pointercancel" });
  timers.advance(600);
  assert.equal(patcher.held, false);
  timers.advance(320);

  alpha.querySelector("[data-summary]").click();
  assert.equal(alpha.getAttribute("aria-current"), "true");
  assert.equal(patcher.tracker.state().selected, A.key);
  const A2 = { ...A, rev: "alpha-2" };
  assert.equal(patcher.update(model([A2, C])), "held");
  timers.advance(5000);
  assert.ok(cardNode(C.key), "a selected card does not hold new cards");
  assert.equal(alpha.getAttribute("data-call-rev"), A.rev, "selected card waits indefinitely");
  document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(alpha.getAttribute("aria-current"), null);
  timers.advance(600);
  assert.equal(patcher.held, false);
  assert.ok(cardNode(C.key));

  alpha.click();
  assert.equal(patcher.tracker.state().selected, A.key);
  alpha.click();
  assert.equal(patcher.tracker.state().selected, null, "a second click deselects");
  alpha.click();
  outside.click();
  assert.equal(patcher.tracker.state().selected, null, "a click outside deselects");

  alpha.querySelector("[data-copy]").click();
  assert.equal(patcher.tracker.state().selected, null, "controls inside a card never select it");
});

test("a card resolved while the captain typed in it becomes a copyable stub instead of losing the text", async () => {
  const copied = [];
  const { list, patcher, cardNode, timers, storage } = setup({ clipboard: { writeText: async (text) => { copied.push(text); } } });
  patcher.update(model([A, B]));
  const field = cardNode(A.key).querySelector("[data-call-draft=\"note\"]");
  field.type("Half-written answer for alpha");
  assert.equal(patcher.update(model([B])), "held");
  field.blur();
  timers.advance(600);
  const stub = list.children.find((node) => node.getAttribute("data-call-stub") === A.key);
  assert.ok(stub, "the gone card left a stub");
  assert.equal(cardNode(A.key), undefined);
  assert.equal(stub.querySelector("[data-call-stub-text]").textContent, "Half-written answer for alpha");
  assert.match(stub.textContent, /Resolved by Firstmate — your unsent text/);
  stub.querySelector("[data-call-stub-copy]").click();
  await Promise.resolve();
  assert.deepEqual(copied, ["Half-written answer for alpha"]);
  stub.querySelector("[data-call-stub-dismiss]").click();
  assert.equal(stub.isConnected, false);
  assert.equal(storage.getItem("fm-quarterdeck-call-draft.v1:decision:alpha-call"), null, "dismiss discards the draft");
});

test("drafts outlive the page: a new patcher restores typed text by card key, and storage failures are harmless", () => {
  const storage = memoryStorage();
  const first = setup({ storage });
  first.patcher.update(model([A]));
  first.cardNode(A.key).querySelector("[data-call-draft=\"note\"]").type("Keep me across reloads");
  const second = setup({ storage });
  second.patcher.update(model([A]));
  assert.equal(second.cardNode(A.key).querySelector("[data-call-draft=\"note\"]").value, "Keep me across reloads");

  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const blocked = setup({ storage: throwing });
  blocked.patcher.update(model([A]));
  const field = blocked.cardNode(A.key).querySelector("[data-call-draft=\"note\"]");
  field.type("Memory only");
  blocked.patcher.update(model([{ ...A, rev: "alpha-2" }]));
  field.blur();
  blocked.timers.advance(600);
  assert.equal(blocked.cardNode(A.key).querySelector("[data-call-draft=\"note\"]").value, "Memory only");
});

test("per-card Update now applies only its pending change; reverting clears its notice", () => {
  const { status, patcher, cardNode, dom } = setup();
  patcher.update(model([A, B]));
  const alpha = cardNode(A.key), beta = cardNode(B.key);
  alpha.querySelector('[data-summary]').click();
  dom.selection.selectAllChildren(beta.querySelector('[data-summary]'));
  const A2 = { ...A, rev: 'alpha-2' }, B2 = { ...B, rev: 'beta-2' };
  patcher.update(model([A2, B2]));
  assert.equal(patcher.held, true);
  assert.equal(status.hidden, true);
  assert.equal(status.children.length, 0, 'no section-level notice');
  alpha.querySelector('[data-call-update-now]').click();
  assert.equal(alpha.getAttribute('data-call-rev'), A2.rev);
  assert.equal(alpha.querySelector('[data-call-held]'), null);
  assert.equal(beta.getAttribute('data-call-rev'), B.rev, 'other engaged card still waits');
  assert.ok(beta.querySelector('[data-call-held]'));
  patcher.update(model([A2, B]));
  assert.equal(patcher.held, false, 'changed back: nothing waits');
  assert.equal(beta.querySelector('[data-call-held]'), null);
});

test("unengaged cards update while another card is engaged, and each card releases independently", () => {
  const { patcher, cardNode, timers } = setup();
  patcher.update(model([A, B]));
  const alpha = cardNode(A.key), beta = cardNode(B.key);
  const field = alpha.querySelector('[data-call-draft="note"]');
  field.type('Protected');
  const A2 = { ...A, rev: 'alpha-2' }, B2 = { ...B, rev: 'beta-2', summary: 'Beta updated' };
  patcher.update(model([A2, B2]));
  assert.equal(beta.querySelector('[data-summary]').textContent, B2.summary);
  assert.equal(beta.querySelector('[data-call-held]'), null);
  assert.equal(alpha.querySelector('[data-call-draft="note"]'), field);
  beta.querySelector('[data-call-draft="note"]').focus();
  timers.advance(600);
  assert.equal(alpha.getAttribute('data-call-rev'), A2.rev, 'alpha releases even while beta stays focused');
  assert.equal(alpha.querySelector('[data-call-draft="note"]').value, 'Protected');
});

test("sort pending notice belongs to the sort control, not the section", () => {
  const { patcher, cardNode, status, section, sortControl, timers } = setup();
  patcher.update(model([{ ...A, clock: { at: '2026-02-01' } }, { ...B, clock: { at: '2026-01-01' } }]));
  cardNode(A.key).querySelector('[data-call-draft="note"]').focus();
  patcher.setSort('oldest');
  const notice = sortControl.parentNode.querySelector('[data-call-sort-pending]');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Sort waits/);
  assert.equal(status.hidden, true);
  assert.equal(section.getAttribute('data-held'), null);
  assert.equal(cardNode(A.key).querySelector('[data-call-held]'), null, 'sort alone is not a card change');
  cardNode(A.key).querySelector('[data-call-draft="note"]').blur();
  timers.advance(600);
  assert.equal(notice.hidden, true);
});

test("explicit sort Update now reorders without releasing pending card changes", () => {
  const { patcher, cardNode, sortControl, list, dom } = setup();
  const newest = { ...A, clock: { at: '2026-02-01' } }, oldest = { ...B, clock: { at: '2026-01-01' } };
  patcher.update(model([newest, oldest]));
  cardNode(A.key).querySelector('[data-call-draft="note"]').focus();
  dom.selection.selectAllChildren(cardNode(B.key).querySelector('[data-summary]'));
  patcher.update(model([{ ...newest, rev: 'alpha-2' }, { ...oldest, rev: 'beta-2' }]));
  patcher.setSort('oldest');
  sortControl.parentNode.querySelector('[data-call-sort-now]').click();
  assert.deepEqual(list.children.map((node) => node.getAttribute('data-call-key')), [B.key, A.key]);
  assert.equal(cardNode(A.key).getAttribute('data-call-rev'), A.rev);
  assert.equal(cardNode(B.key).getAttribute('data-call-rev'), B.rev);
  assert.ok(cardNode(A.key).querySelector('[data-call-held]'));
  assert.ok(cardNode(B.key).querySelector('[data-call-held]'));
  assert.equal(sortControl.parentNode.querySelector('[data-call-sort-pending]').hidden, true);
});

test("freshness refreshes the empty state and coverage without touching cards", () => {
  const { list, coverage, patcher } = setup();
  patcher.update(model([], { state: "loading", coverage: null }));
  assert.equal(list.querySelector("[data-call-empty]").textContent, "Checking for captain's calls…");
  patcher.observe({ rev: "empty", state: "unavailable", error: "Firstmate bearings snapshot is not installed" });
  assert.equal(list.querySelector("[data-call-empty]").textContent, "Captain's Call unavailable: Firstmate bearings snapshot is not installed");
  patcher.update(model([], { coverage: { known: 4, checked: 4, provenClear: true } }));
  assert.equal(list.querySelector("[data-call-empty]").textContent, "Nothing needs your action right now");
  assert.equal(coverage.textContent, "checked 4 of 4");
  patcher.observe({ rev: "other", state: "stale" });
  assert.equal(patcher.applied.state, "ready", "freshness for another revision is ignored");
});

test("engaged card keeps focus and viewport position when neighbours insert and remove", () => {
  const { dom, list, patcher, cardNode, scrolls, timers, document } = setup();
  dom.Element.prototype.getBoundingClientRect = function () {
    const index = list.children.indexOf(this);
    return { top: index * 100 + 400, bottom: index * 100 + 500 };
  };
  patcher.update(model([A, B]));
  const beta = cardNode(B.key), field = beta.querySelector('[data-call-draft="note"]');
  field.focus();
  patcher.update(model([C, A, B]));
  assert.deepEqual(scrolls, [100]);
  assert.equal(document.activeElement, field, 'engaged node is never detached');
  patcher.update(model([C, B]));
  assert.deepEqual(scrolls, [100, -100], 'leaving neighbour moves below anchor immediately');
  timers.advance(320);
  assert.equal(document.activeElement, field);
});

test("once scrolled, the first visible card stays put when calls are inserted above it", () => {
  const { dom, list, patcher, scrolls } = setup();
  let scrollY = 0;
  const listTop = 400;
  dom.Element.prototype.getBoundingClientRect = function () {
    if (this === list) return { top: listTop - scrollY, bottom: listTop - scrollY + 100 * list.children.length };
    const index = list.children.indexOf(this);
    const top = listTop + index * 100 - scrollY;
    return index < 0 ? { top: 0, bottom: 0 } : { top, bottom: top + 100 };
  };
  patcher.update(model([A, B]));
  patcher.update(model([C, A, B]));
  assert.deepEqual(scrolls, [], "at the top of the page a new call pushes in visibly");
  scrollY = 620; // A is above the fold; B is the first visible card
  patcher.update(model([card("merge:delta-merge", "Merge delta"), C, A, B]));
  assert.deepEqual(scrolls, [100], "the page scrolls by exactly the inserted height");
});
