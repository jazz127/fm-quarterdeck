import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { callDom, fakeTimers } from "./helpers/call-dom.js";
import { normalizeSnapshot } from "../bearings.js";
import { composeCallModel, extractAsks } from "../chat-asks.js";
import { prefixHold, prefixReason, binaryQuestionReasons } from "./helpers/prefix-hold.js";

const sources = await Promise.all(["bearings-patch.js", "bearings-view.js", "bearings-answer-form.js", "bearings-overflow.js", "call-lifecycle.js"].map((name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8")));
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const decision = (rev = "a1", summary = "Pick the alpha rollout window") => ({ key: "decision:alpha-call", type: "decision", task: "alpha-call", summary, rev,
  answer: { question: "alpha-call", options: [], recommend: null, close: null, freeform: true } });
const merge = (rev = "b1") => ({ key: "merge:beta-merge", type: "merge", task: "beta-merge", reason: "checks green", url: "https://example.invalid/pull/7", rev,
  answer: { question: "merge.beta-merge", options: [{ value: "merge", label: "Merge now", hint: "Firstmate re-checks" }], recommend: null, close: null, freeform: true } });
const model = (cards) => ({ schema: "fm-quarterdeck-call.v1", rev: cards.map((card) => `${card.key}@${card.rev}`).join("|") || "empty", state: "ready", cards, coverage: { known: 1, checked: 1, provenClear: false }, omitted: [] });

function setup({ responses = [], storage = null, viewerStorage = null, onAsked = () => {}, activeFilter = false } = {}) {
  const dom = callDom();
  const timers = fakeTimers();
  const { document } = dom;
  const section = document.createElement("section");
  const status = document.createElement("p");
  const list = document.createElement("div");
  const outside = document.createElement("button");
  section.append(status, list);
  document.body.append(section, outside);
  const win = { document, matchMedia: () => ({ matches: false }), navigator: {}, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({ window: win, URL, TextEncoder });
  for (const source of sources) vm.runInContext(source, context);
  const fetches = [];
  const queue = [...responses];
  const fetchImpl = async (url, init = {}) => {
    fetches.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = await (queue.shift() || { status: 202, body: { state: "accepted", sentAt: "2026-01-02T03:04:05.000Z" } });
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status < 300, json: async () => next.body };
  };
  let n = 0;
  let answers = null, overflow = null;
  const patcher = win.bearingsPatch.createCallPatcher({ section, list, status, view: win.bearingsView, doc: document, win, storage, viewerStorage, timers,
    onRender: (node, card) => { answers?.render(node, card); overflow?.render(node, card); },
    onApply: (next) => { answers?.prune(next.cards.map((card) => card.key)); overflow?.prune(next.cards.map((card) => card.key)); } });
  answers = win.bearingsAnswerForm.createAnswerController({ list, drafts: patcher.drafts, doc: document, win, storage, fetchImpl, timers, uuid: () => uuid(++n), onAsked,
    onChange(key, answer) {
      const card = list.querySelector(`[data-call-key="${key}"]`);
      if (activeFilter && card) {
        card.hidden = !win.callLifecycle.visible(win.callLifecycle.cardState({ answer }), "active");
        if (card.hidden && card.contains(document.activeElement)) outside.focus();
      }
      patcher.refreshPending?.();
    } });
  overflow = win.bearingsOverflow.createOverflowController({ list, win });
  const node = (key) => list.children.find((entry) => entry.getAttribute("data-call-key") === key);
  const part = (key, name) => node(key).querySelector(`[data-call-answer-${name}]`);
  const submit = (key) => node(key).querySelector("[data-call-answer]").dispatchEvent({ type: "submit", preventDefault() {} });
  const leave = () => { outside.focus(); outside.click(); timers.advance(700); };
  return { dom, document, timers, list, patcher, answers, overflow, fetches, node, part, submit, leave, win };
}

const explicitBooleanModel = () => {
  const base = normalizeSnapshot({ schema: "fm-bearings.v1", decisions_open: [{ id: "alpha-call", owner: "(main)", summary: "Archive sample notes?", hold_set_at: "2030-01-02T10:00:00Z" }], contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] });
  const ask = { ...extractAsks("DECISION NEEDED [task:alpha-call] Archive sample notes? Reply Yes or No.")[0], key: "chat:sampleboolean", linkedTasks: ["alpha-call"], source: "synthetic/main", offset: 0, part: 0 };
  return composeCallModel({ ...base, state: "ready" }, [ask], { state: "ready", sources: [] });
};

test("extracted Yes and No controls use the typed answer path; text alone remains a thread note", async () => {
  const current = explicitBooleanModel(), key = "decision:alpha-call";
  for (const reply of ["Yes", "No"]) {
    const t = setup(); t.patcher.update(current);
    const radio = t.node(key).querySelector(`input[data-call-reply="${reply}"]`);
    assert.ok(radio, `${reply} is visible`);
    radio.checked = true; radio.dispatchEvent({ type: "change" });
    t.submit(key); t.part(key, "send").click(); await flush();
    assert.equal(t.fetches[0].url, "/api/bearings/answer");
    assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, cardRev: current.cards[0].rev, selection: "", note: reply });
  }
  for (const text of ["Yes", "No", "Please explain the timing"]) {
    const t = setup(); t.patcher.update(current);
    t.part(key, "text").type(text); t.submit(key); t.part(key, "send").click(); await flush();
    assert.equal(t.fetches[0].url, "/api/bearings/thread");
    assert.equal(t.fetches[0].body.text, text);
  }
});

test("canonical prefix and binary-question radios require Queue/Send; typed Yes/Proceed/No stay thread notes", async () => {
  for (const reason of [prefixReason, ...binaryQuestionReasons]) {
    const { model: current } = await prefixHold({ reason }), key = "decision:sample-call";
    for (const selection of ["yes", "no"]) {
      const t = setup(); t.patcher.update(current);
      assert.equal(t.node(key).querySelectorAll('input[type="radio"]').length, 2, reason);
      assert.ok(t.node(key).textContent.includes(reason), "full reason stays visible");
      const radio = t.node(key).querySelector(`input[value="${selection}"]`);
      radio.checked = true; radio.dispatchEvent({ type: "change" });
      assert.equal(t.fetches.length, 0, "selection alone never sends");
      t.submit(key);
      assert.equal(t.answers.state(key).phase, "confirm");
      assert.equal(t.fetches.length, 0, "Queue alone never sends");
      t.part(key, "send").click(); await flush();
      assert.equal(t.fetches.length, 1);
      assert.equal(t.fetches[0].url, "/api/bearings/answer");
      assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, cardRev: current.cards[0].rev, selection, note: "" });
    }
    for (const text of ["Yes", "Proceed", "No"]) {
      const t = setup(); t.patcher.update(current); t.part(key, "text").type(text);
      t.submit(key); assert.equal(t.fetches.length, 0);
      t.part(key, "send").click(); await flush();
      assert.equal(t.fetches[0].url, "/api/bearings/thread");
      assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, text });
    }
    assert.equal(current.cards[0].backlogReason, reason);
  }
});

test("canonical question choice arrival preserves the engaged same-hold draft until accepted", async () => {
  const { model: current, raw } = await prefixHold({ reason: binaryQuestionReasons[1] });
  const earlier = structuredClone(raw); delete earlier.decisions_open[0].options;
  const before = { ...normalizeSnapshot(earlier), state: "ready" };
  assert.equal(before.cards[0].holdVersion, current.cards[0].holdVersion);
  const t = setup(), key = current.cards[0].key; t.patcher.update(before);
  const field = t.part(key, "text"); field.focus(); field.type("Keep this draft");
  t.patcher.update(current);
  assert.equal(t.patcher.held, true);
  assert.equal(t.document.activeElement, field);
  assert.equal(t.part(key, "text").value, "Keep this draft");
  assert.equal(t.node(key).querySelector('input[value="yes"]'), null);
  t.node(key).querySelector("[data-call-update-now]").click();
  assert.equal(t.part(key, "text").value, "Keep this draft");
  assert.ok(t.node(key).querySelector('input[value="yes"]'));
  assert.ok(t.node(key).querySelector('input[value="no"]'));
  assert.equal(t.fetches.length, 0);
});

test("arrival of explicit Yes/No choices holds the engaged card and preserves focus and draft", () => {
  const t = setup(), current = explicitBooleanModel(), key = "decision:alpha-call";
  const before = { ...current.cards[0], rev: "a1", chatAsks: [] };
  t.patcher.update(model([before]));
  const field = t.part(key, "text"); field.focus(); field.type("Keep this draft");
  t.patcher.update(current);
  assert.equal(t.patcher.held, true);
  assert.equal(t.document.activeElement, field);
  assert.equal(t.part(key, "text"), field);
  assert.equal(field.value, "Keep this draft");
  assert.equal(t.node(key).querySelector('input[data-call-reply="Yes"]'), null);
  t.node(key).querySelector("[data-call-update-now]").click();
  assert.equal(t.part(key, "text").value, "Keep this draft");
  assert.ok(t.node(key).querySelector('input[data-call-reply="Yes"]'));
});

test('optional cycle identity retains an accepted answer across presentation changes and resets only a new hold', async () => {
  const t=setup();const key='merge:beta-merge';
  const c={...merge(),holdVersion:'current'};
  t.patcher.update(model([c]));
  const radio=t.node(key).querySelector('input[value="merge"]');radio.checked=true;radio.dispatchEvent({type:'change'});
  t.submit(key);t.part(key,'send').click();await flush();t.leave();
  assert.equal(t.answers.state(key).holdVersion,'current');
  t.patcher.update(model([{...c,rev:'b2'}]));t.leave();
  assert.equal(t.answers.state(key).phase,'sent','cosmetic revision cannot reset a versioned accepted answer');
  t.patcher.update(model([{...c,rev:'b3',holdVersion:'new'}]));t.leave();
  assert.equal(t.answers.state(key),null,'new hold excludes the old local lock');
  assert.equal(t.part(key,'text').readOnly,false);
});

const generatedDecision = (hold = '2026-01-02T10:00:00Z', extra = {}) => normalizeSnapshot({ schema: 'fm-bearings.v1', decisions_open: [{ id: 'alpha-call', owner: '(main)', summary: 'Pick a window', reason: 'Choose staged or now', hold_set_at: hold, options: [{ value: 'staged', label: 'Staged' }, { value: 'now', label: 'Now' }], ...extra }], contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] }).cards[0];

for (const reload of [false, true]) {
  test(`a new hold preserves the follow-up draft after a reply${reload ? " across reload" : " during refresh"}`, async () => {
    const key = "decision:alpha-call", storage = tabStorage();
    const t = setup({ storage, responses: [
      { status: 202, body: { noteId: "answered-note", sentAt: "2026-01-02T11:00:00Z" } },
      { status: 200, body: { answers: { [uuid(1)]: { state: "replied", replyScope: "individual", reply: "Staged is ready" } } } },
    ] });
    t.patcher.update(model([generatedDecision()]));
    const choice = t.node(key).querySelector('input[value="staged"]');
    choice.checked = true; choice.dispatchEvent({ type: "change" });
    t.part(key, "text").type("Use staged");
    t.submit(key); t.part(key, "send").click(); await flush();
    t.timers.advance(15000); await flush();
    assert.equal(t.answers.state(key).phase, "compose");
    assert.equal(t.answers.state(key).heldReply, "Staged is ready");
    const followUpChoice = t.node(key).querySelector('input[value="now"]');
    followUpChoice.checked = true; followUpChoice.dispatchEvent({ type: "change" });
    t.part(key, "text").focus(); t.part(key, "text").type("Please check the next window");
    const current = reload ? setup({ storage }) : t;
    current.patcher.update(model([generatedDecision("2026-01-02T12:00:00Z")]));
    if (!reload) {
      assert.equal(current.patcher.held, true);
      current.node(key).querySelector("[data-call-update-now]").click();
    }
    assert.equal(current.answers.state(key), null, "old receipt metadata is discarded");
    assert.equal(current.part(key, "text").value, "Please check the next window");
    assert.equal(current.part(key, "text").readOnly, false);
    assert.equal(current.patcher.drafts.get(key).answer, "Please check the next window");
    assert.equal(current.node(key).querySelector('input[value="now"]').checked, true);
    const restored = setup({ storage }); restored.patcher.update(model([generatedDecision("2026-01-02T12:00:00Z")]));
    assert.equal(restored.part(key, "text").value, "Please check the next window");
    assert.equal(restored.node(key).querySelector('input[value="now"]').checked, true);
    current.submit(key);
    assert.equal(current.answers.state(key).phase, "confirm");
    assert.equal(current.answers.state(key).selection, "now");
    assert.equal(current.answers.state(key).note, "Please check the next window");
    assert.equal(t.fetches.length, 2, "refresh and reload never send the follow-up");
  });
}

test('generated hold upgrades unversioned legacy sent state only with current durable classification and forgets a re-hold on reload', () => {
  const key = 'decision:alpha-call', storageKey = 'fm-quarterdeck-call-answer.v1:' + key;
  const legacy = { phase: 'sent', requestId: uuid(9), note: 'Use staged', selection: 'staged', sentAt: '2026-01-02T11:00:00Z', receipt: { state: 'accepted' } };
  for (const answered of [false, true]) {
    const storage = tabStorage(); storage.setItem(storageKey, JSON.stringify(legacy));
    const t = setup({ storage }); const c = generatedDecision();
    t.patcher.update(model([{ ...c, answered }]));
    if (answered) {
      assert.equal(t.answers.state(key).holdVersion, c.holdVersion);
      assert.equal(t.part(key, 'text').readOnly, true);
      const reload = setup({ storage }); reload.patcher.update(model([generatedDecision('2026-01-02T12:00:00Z')]));
      assert.equal(reload.answers.state(key), null);
      assert.equal(reload.part(key, 'text').value, '');
      assert.equal(reload.part(key, 'text').readOnly, false);
      assert.equal(reload.node(key).querySelectorAll('input[type="radio"]').some(input => input.checked), false);
    } else {
      assert.equal(t.answers.state(key), null, 'missing current durable receipt cannot upgrade legacy local words');
      assert.equal(t.part(key, 'text').value, '');
    }
    assert.equal(t.fetches.length, 0, 'upgrade/reset never resends');
  }
});

test('actual generated cycle retains sent echo for cosmetic update but clears local lock between history polls', async () => {
  const t = setup({ responses: [{ status: 202, body: { state: 'accepted', sentAt: '2026-01-02T11:00:00Z' } }] });
  const key = 'decision:alpha-call', c = generatedDecision();
  t.patcher.update(model([c]));
  const radio = t.node(key).querySelector('input[value="staged"]'); radio.checked = true; radio.dispatchEvent({ type: 'change' });
  t.part(key, 'text').type('Use the staged window'); t.submit(key); t.part(key, 'send').click(); await flush(); t.leave();
  assert.equal(t.answers.state(key).holdVersion, c.holdVersion);
  t.patcher.update(model([generatedDecision(undefined, { repo: 'example-app' })])); t.leave();
  assert.equal(t.answers.state(key).phase, 'sent');
  assert.equal(t.part(key, 'text').value, 'Use the staged window');
  t.patcher.update(model([generatedDecision('2026-01-02T12:00:00Z')])); t.leave();
  assert.equal(t.answers.state(key), null);
  assert.equal(t.part(key, 'summary').hidden, true);
  assert.equal(t.part(key, 'text').readOnly, false);
  assert.equal(t.part(key, 'text').value, '');
  assert.equal(t.node(key).querySelectorAll('input[type="radio"]').some(input => input.checked), false);
  assert.equal(t.fetches.length, 1, 're-hold never replays the accepted answer');
});

test('protected sorting preserves typing, confirmation and viewer preference across reload', () => {
  const viewerStorage = tabStorage();
  const t = setup({ viewerStorage });
  const cards = [{ ...decision(), clock: { at: '2026-01-01T00:00:00Z', label: 'Created' } }, { ...merge(), clock: { at: '2026-02-01T00:00:00Z', label: 'Checked' } }];
  t.patcher.update(model(cards));
  assert.equal(t.list.children[0], t.node('merge:beta-merge'));
  const field = t.part('decision:alpha-call', 'text');
  field.focus(); field.type('Tuesday');
  t.submit('decision:alpha-call');
  const send = t.part('decision:alpha-call', 'send');
  t.patcher.setSort('oldest');
  assert.equal(t.patcher.held, true);
  assert.equal(t.list.children[0], t.node('merge:beta-merge'), 'engaged sorting is deferred');
  t.patcher.update(model(cards));
  assert.equal(t.patcher.held, true, 'unchanged polls cannot cancel a pending sort');
  t.leave();
  assert.equal(t.list.children[0], t.node('decision:alpha-call'));
  assert.equal(t.part('decision:alpha-call', 'send'), send, 'same form nodes survive reorder');
  assert.equal(t.part('decision:alpha-call', 'text').value, 'Tuesday');
  assert.equal(t.answers.state('decision:alpha-call').phase, 'confirm');
  const reload = setup({ viewerStorage });
  reload.patcher.update(model(cards));
  assert.equal(reload.patcher.sortOrder, 'oldest');
  assert.equal(reload.list.children[0], reload.node('decision:alpha-call'));
});

test('clock ticks only change clock text and leave focused answer nodes intact', () => {
  const t = setup();
  t.patcher.update(model([{ ...decision(), clock: { at: new Date(Date.now() - 120000).toISOString(), label: 'Updated' } }]));
  const key = 'decision:alpha-call';
  const field = t.part(key, 'text'); field.focus(); field.type('Tuesday');
  const clock = t.node(key).querySelector('[data-call-clock]'); clock.textContent = 'outdated';
  t.timers.advance(1000);
  assert.match(clock.textContent, /2m ago/);
  assert.equal(t.part(key, 'text'), field);
  assert.equal(t.document.activeElement, field);
  assert.equal(field.value, 'Tuesday');
});

test('Edit after an unconfirmed send and changed-card refusal retain identity, including reload', async () => {
  const storage = tabStorage();
  const t = setup({ storage, responses: [new Error('offline')] });
  const key = 'decision:alpha-call'; t.patcher.update(model([decision()]));
  t.part(key, 'text').type('Tuesday'); t.submit(key); t.part(key, 'send').click(); await flush();
  const requestId = t.answers.state(key).requestId;
  assert.match(t.part(key, 'error').textContent, /may already have reached/);
  let writes = 0;
  const error = t.part(key, 'error'), text = error.textContent;
  Object.defineProperty(error, 'textContent', { get: () => text, set: () => { writes++; }, configurable: true });
  t.answers.render(t.node(key)); t.answers.render(t.node(key));
  assert.equal(writes, 0, 'unchanged alerts are not rewritten');
  t.part(key, 'edit').click(); t.part(key, 'text').type('Wednesday'); t.submit(key);
  assert.equal(t.answers.state(key).requestId, requestId);
  t.leave(); t.patcher.update(model([decision('a2')]));
  assert.equal(t.answers.state(key).phase, 'confirm', 'unfocused unsent text waits for acknowledgement');
  t.node(key).querySelector('[data-call-update-now]').click();
  assert.equal(t.answers.state(key).phase, 'refused');
  assert.equal(t.answers.state(key).requestId, requestId);
  const reload = setup({ storage }); reload.patcher.update(model([decision('a2')]));
  reload.part(key, 'text').type('Thursday'); reload.submit(key);
  assert.equal(reload.answers.state(key).requestId, requestId);
});

function tabStorage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) || null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key),
    key: (index) => [...entries.keys()][index], get length() { return entries.size; } };
}

test("Active-filter chat removal waits for accepted body consumption and leaves no unsent stub", async () => {
  let consume;
  const body = new Promise(resolve => { consume = resolve; });
  const t = setup({ activeFilter: true, responses: [{ status: 202, body }] });
  const chat = { ...merge(), key: "chat:0123456789abcdef", type: "chat", marker: "ACTION NEEDED", summary: "Rotate the sample token", answer: {
    question: "chat.0123456789abcdef", options: [{ value: "reply-1", label: "rotated" }], freeform: true,
  } };
  const key = chat.key;
  t.patcher.update(model([chat, decision()]));
  const radio = t.node(key).querySelector('input[value="reply-1"]');
  radio.checked = true; radio.dispatchEvent({ type: "change" });
  t.submit(key);
  assert.equal(t.node(key).hidden, true, "Queued leaves the Active filter");
  const original = t.node(key);
  t.part(key, "send").click();
  t.leave(); await flush();
  assert.equal(original.contains(t.document.activeElement), false, "no engagement protects the send");
  t.patcher.update(model([decision("a2", "Updated neighbour")]));
  assert.equal(original.querySelector('[data-call-update-now]').textContent, 'Show update');
  original.querySelector('[data-call-update-now]').click();
  t.patcher.applyNow(key);
  t.part(key, 'send').click();
  assert.equal(t.fetches.length, 1, 'acknowledgement cannot send or duplicate the in-flight response');
  assert.equal(t.node(key), original, "source removal waits while the accepted body is unread");
  assert.equal(t.answers.state(key).phase, "sending");
  assert.equal(t.list.querySelector("[data-call-stub]"), null);
  assert.match(t.node("decision:alpha-call").textContent, /Updated neighbour/, "unrelated changes still apply");
  consume({ state: "accepted" }); await flush(); t.timers.advance(700);
  assert.equal(original.isConnected, false, "resolved chat leaves after confirmation is consumed");
  assert.equal(t.patcher.drafts.text(key), "");
  assert.equal(t.list.querySelector("[data-call-stub]"), null, "accepted words never become unsent text");
  assert.equal(t.patcher.pending, null);
});

test("a filed answer keeps its sent echo across a source update during sending", async () => {
  let consume;
  const t = setup({ activeFilter: true, responses: [{ status: 202, body: new Promise(resolve => { consume = resolve; }) }] });
  const key = merge().key;
  t.patcher.update(model([merge()]));
  const radio = t.node(key).querySelector('input[value="merge"]'); radio.checked = true; radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("Preserve compatibility"); t.submit(key); t.part(key, "send").click(); t.leave(); await flush();
  t.patcher.update(model([{ ...merge("b2"), reason: "Updated review context" }]));
  consume({ state: "accepted" }); await flush();
  assert.equal(t.answers.state(key).phase, "sent");
  assert.equal(t.node(key).getAttribute("data-call-rev"), "b2");
  assert.match(t.node(key).textContent, /Updated review context/);
  assert.equal(t.part(key, "text").value, "Preserve compatibility");
  assert.equal(t.node(key).querySelector('input[value="merge"]').disabled, true);
  assert.equal(t.patcher.drafts.text(key), "");
});

test("source removal during an unconfirmed send preserves copyable unsent text", async () => {
  let respond;
  const t = setup({ activeFilter: true, responses: [new Promise(resolve => { respond = resolve; })] });
  const key = merge().key;
  t.patcher.update(model([merge()]));
  const radio = t.node(key).querySelector('input[value="merge"]'); radio.checked = true; radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("Check the sample migration"); t.submit(key); t.part(key, "send").click(); t.leave();
  t.patcher.update(model([]));
  t.node(key).querySelector('[data-call-update-now]').click();
  t.part(key, 'send').click();
  assert.equal(t.fetches.length, 1, 'Show update leaves the unconfirmed request protected');
  assert.ok(t.node(key), "the request is still awaiting confirmation");
  respond({ status: 502, body: { error: "Unconfirmed" } }); await flush(); t.timers.advance(700);
  const stub = t.list.querySelector("[data-call-stub]");
  assert.ok(stub);
  assert.match(stub.querySelector("[data-call-stub-text]").textContent, /Check the sample migration/);
  assert.match(t.patcher.drafts.text(key), /Check the sample migration/);
});

test("visible answer and thread sends clear drafts before a pending source removal", async () => {
  for (const path of ["answer", "thread"]) {
    let consume;
    const t = setup({ responses: [{ status: 202, body: new Promise(resolve => { consume = resolve; }) }] });
    const key = merge().key; t.patcher.update(model([merge()]));
    if (path === "answer") {
      const radio = t.node(key).querySelector('input[value="merge"]'); radio.checked = true; radio.dispatchEvent({ type: "change" });
    }
    t.part(key, "text").type("Sample context"); t.submit(key); t.part(key, "send").click(); t.leave(); await flush();
    t.patcher.update(model([]));
    assert.equal(t.answers.state(key).path, path);
    assert.ok(t.node(key));
    consume({ state: "accepted" }); await flush();
    assert.equal(t.patcher.drafts.text(key), "", `${path} clears only after confirmation`);
    t.leave();
    assert.equal(t.list.querySelector("[data-call-stub]"), null, `${path} has no leftover unsent stub`);
    assert.equal(t.patcher.pending, null);
  }
});

test("selecting a lettered option submits that letter, and text alone stays a thread note", async () => {
  const key = "decision:alpha-call";
  const lettered = () => {
    const card = decision();
    card.answer = { ...card.answer, options: [
      { value: "a", label: "a", hint: "Staged rollout — fewer users at once" },
      { value: "b", label: "b", hint: "Ship now — faster delivery" },
    ] };
    return card;
  };
  const typed = setup();
  typed.patcher.update(model([lettered()]));
  typed.part(key, "text").type("Tuesday");
  typed.submit(key);
  assert.equal(typed.answers.state(key).path, "thread");
  assert.equal(typed.fetches.length, 0, "text with no letter selected is not an answer yet");

  const t = setup();
  t.patcher.update(model([lettered()]));
  assert.match(t.node(key).querySelector('input[value="a"]').closest(".call-opt").textContent, /Staged rollout — fewer users at once/);
  assert.equal(t.node(key).querySelectorAll('input[type="radio"]').length, 2);
  const radio = t.node(key).querySelector('input[value="a"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.submit(key);
  assert.equal(t.answers.state(key).selection, "a");
  assert.equal(t.answers.state(key).selectionLabel, "a");
  assert.equal(t.part(key, "preview").textContent, "a");
  t.part(key, "send").click();
  await flush();
  assert.equal(t.fetches[0].url, "/api/bearings/answer");
  assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, cardRev: "a1", selection: "a", note: "" });
});

test("a named linked alternative relays its exact label; unselected text uses the thread endpoint", async () => {
  const card = { ...decision(), chatAsks: [{ summary: 'Choose the window. Reply "Staged rollout" or "Release now".', replies: ["Staged rollout", "Release now"] }] };
  const key = card.key;
  const t = setup();
  t.patcher.update(model([card]));
  const radio = t.node(key).querySelector('input[data-call-reply="Release now"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("Use the sample window");
  t.submit(key);
  assert.equal(t.fetches.length, 0);
  assert.equal(t.part(key, "preview").textContent, "Release now - Use the sample window");
  t.part(key, "send").click();
  await flush();
  assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, cardRev: card.rev, selection: "", note: "Release now - Use the sample window" });
  assert.equal(t.fetches[0].url, "/api/bearings/answer");

  const note = setup();
  note.patcher.update(model([card]));
  note.part(key, "text").type("Release now");
  note.submit(key);
  assert.equal(note.answers.state(key).path, "thread", "matching an option's text is not selecting it");
  note.part(key, "send").click();
  await flush();
  assert.equal(note.fetches[0].url, "/api/bearings/thread");
  assert.equal(note.fetches[0].body.text, "Release now");
  assert.equal(note.fetches[0].body.selection, undefined);
});

test("nothing is sent until Queue and then an explicit Send; the sent answer clears its draft and shows receipts", async () => {
  const t = setup({ responses: [{ status: 202, body: { state: "accepted", noteId: "note-accepted", sentAt: "2026-01-02T03:04:05.000Z" } }, { status: 200, body: { answers: { [uuid(1)]: { state: "received" } } } }, { status: 200, body: { answers: { [uuid(1)]: { state: "replied", replyScope: "individual", reply: "Holding until Tuesday" } } } }] });
  const card = decision();
  card.answer = { ...card.answer, options: [{ value: "staged", label: "Staged", hint: "Fewer users" }], recommend: "staged" };
  t.patcher.update(model([card]));
  const key = "decision:alpha-call";
  assert.equal(t.part(key, "summary").hidden, true, "compose does not show a sent answer");
  assert.equal(t.part(key, "confirm").hidden, true);
  assert.equal(t.part(key, "compose").textContent, "Queue");
  assert.equal(t.part(key, "send").hidden, true, "Send appears only for a queued answer");
  const radio = t.node(key).querySelector('input[value="staged"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("  Use the Tuesday window  ");
  t.submit(key);
  assert.equal(t.fetches.length, 0, "queueing never sends");
  assert.equal(t.answers.state(key).phase, "confirm");
  assert.equal(t.part(key, "preview").textContent, "Staged - Use the Tuesday window");
  assert.equal(t.part(key, "confirm").hidden, false);
  assert.equal(t.part(key, "text").readOnly, true, "the queued text cannot change while queued");
  assert.equal(t.part(key, "fields").hasAttribute("data-locked"), true);
  assert.equal(t.part(key, "summary").hidden, true, "a queued answer is not yet Your answer");
  assert.equal(t.part(key, "compose").hidden, true, "Queue gives way to Send and Edit");
  assert.equal(t.part(key, "edit").hidden, false);
  assert.equal(t.document.activeElement, t.part(key, "send"));
  // Updates arriving meanwhile never send either.
  t.patcher.update(model([{ ...card }, merge()]));
  assert.equal(t.fetches.length, 0);

  t.part(key, "send").click();
  await flush();
  assert.equal(t.fetches.length, 1);
  assert.equal(t.fetches[0].url, "/api/bearings/answer");
  assert.deepEqual(t.fetches[0].body, { requestId: uuid(1), key, cardRev: "a1", selection: "staged", note: "Use the Tuesday window" });
  assert.equal(t.answers.state(key).phase, "sent");
  assert.equal(t.answers.state(key).noteId, "note-accepted");
  assert.equal(t.patcher.drafts.text(key), "", "sent words are not 'unsent text'");
  assert.equal(t.part(key, "receipt").hidden, false);
  assert.match(t.part(key, "receipt-text").textContent, /^Sent to Firstmate: Staged - Use the Tuesday window · waiting/);
  assert.equal(t.part(key, "summary").hidden, false);
  assert.equal(t.part(key, "summary").querySelector("h4").textContent, "Your answer");
  assert.equal(t.part(key, "summary-label").textContent, "Staged");
  assert.equal(t.part(key, "summary-label").hidden, false);
  assert.equal(t.part(key, "summary-hint").textContent, "Fewer users");
  assert.equal(t.part(key, "summary-hint").hidden, false);
  assert.equal(t.part(key, "summary-note").textContent, "Use the Tuesday window");
  assert.equal(t.part(key, "summary-note").hidden, false);
  assert.equal(t.part(key, "summary-sent").getAttribute("datetime"), "2026-01-02T03:04:05.000Z");
  assert.match(t.part(key, "summary-sent").textContent, /^Sent /);
  const summary = t.part(key, "summary");
  const ask = t.node(key).querySelector("h3");
  let seenSummary = false;
  let summaryBeforeAsk = false;
  const walk = (entry) => {
    for (const child of entry.childNodes || []) {
      if (child === summary) seenSummary = true;
      if (child === ask && seenSummary) summaryBeforeAsk = true;
      walk(child);
    }
  };
  walk(t.node(key));
  assert.equal(summaryBeforeAsk, true, "Your answer sits above the ask");
  assert.equal(t.part(key, "fields").hidden, false, "a sent answer keeps its choices visible");
  assert.equal(t.part(key, "fields").hasAttribute("data-locked"), true);
  assert.equal(t.part(key, "fields").hasAttribute("data-sent"), true);
  assert.equal(radio.disabled, true, "sent radios cannot be changed");
  assert.equal(radio.checked, true, "the sent choice stays shown");
  assert.equal(t.part(key, "text").readOnly, true);
  assert.equal(t.part(key, "text").disabled, false, "the sent note stays selectable");
  assert.equal(t.part(key, "text").value, "Use the Tuesday window");
  assert.equal(t.part(key, "compose").hidden, true);
  assert.equal(t.node(key).querySelector(".call-answer-bar").hidden, true);
  assert.equal(t.part(key, "confirm").hidden, true, "a sent answer is not still queued");
  assert.equal(t.part(key, "send").hidden, true);
  assert.equal(t.part(key, "edit").hidden, true);

  t.timers.advance(15000);
  await flush();
  assert.match(t.fetches[1].url, new RegExp(`/api/bearings/answer/status\\?ids=${uuid(1)}`));
  assert.match(t.part(key, "receipt-text").textContent, /received by Firstmate/);
  t.timers.advance(15000);
  await flush();
  assert.equal(t.answers.state(key).phase, "compose", "a reply unlocks the answer");
  assert.equal(t.answers.state(key).heldReply, "Holding until Tuesday");
  assert.equal(t.answers.state(key).heldNoteId, "note-accepted");
  assert.equal(t.part(key, "receipt").hidden, true, "the card banner owns the reply");
  assert.equal(t.part(key, "text").readOnly, false);
  assert.equal(radio.disabled, false);
  assert.equal(radio.checked, false);
  assert.equal(t.part(key, "text").value, "");
  assert.equal(t.part(key, "summary").hidden, true);
  assert.equal(t.part(key, "compose").hidden, false);
  assert.equal(t.win.callLifecycle.cardState({ card, answer: t.answers.state(key) }), "active");
  assert.equal(t.win.callLifecycle.replyBanner(t.answers.state(key).heldReply), "Firstmate replied: Holding until Tuesday");
  t.timers.advance(60000);
  await flush();
  assert.equal(t.fetches.length, 3, "a replied answer stops polling");

  // Firstmate resolves the call: the card leaves without an unsent-text stub, and its state is forgotten.
  t.leave();
  t.patcher.update(model([merge()]));
  t.timers.advance(1000);
  assert.equal(t.list.querySelector("[data-call-stub]"), null);
  assert.equal(t.answers.state(key), null);
});

test("a call that changes while the answer is under review is never sent as reviewed", async () => {
  const t = setup();
  t.patcher.update(model([decision("a1")]));
  const key = "decision:alpha-call";
  t.part(key, "text").type("Tuesday");
  t.submit(key);
  t.patcher.update(model([decision("a2", "Pick the alpha rollout window and region")]));
  assert.equal(t.patcher.held, true, "the hold keeps the reviewed card on screen");
  t.leave();
  assert.equal(t.answers.state(key).phase, "refused");
  assert.match(t.part(key, "error").textContent, /changed while you were reviewing/);
  assert.equal(t.part(key, "text").value, "Tuesday", "the draft survives the rebuild");
  t.part(key, "send").click();
  await flush();
  assert.equal(t.fetches.length, 0);
});

test("unconfirmed sends retry only by click with the same request id; refusals return to editing with the server's reason", async () => {
  const t = setup({ responses: [new Error("offline"), { status: 502, body: { error: "Firstmate did not confirm" } }, { status: 409, body: { error: "This call is no longer open" } }] });
  t.patcher.update(model([merge()]));
  const key = "merge:beta-merge";
  const radio = t.node(key).querySelector('input[type="radio"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.submit(key);
  assert.equal(t.part(key, "preview").textContent, "Merge now");
  t.part(key, "send").click();
  await flush();
  assert.equal(t.answers.state(key).phase, "failed");
  assert.equal(t.part(key, "send").textContent, "Retry send");
  t.timers.advance(120000);
  await flush();
  assert.equal(t.fetches.length, 1, "no automatic retry");
  t.part(key, "send").click();
  await flush();
  assert.equal(t.fetches[1].body.requestId, t.fetches[0].body.requestId);
  assert.equal(t.fetches[1].body.selection, "merge");
  assert.match(t.part(key, "error").textContent, /^Firstmate did not confirm.*may already have reached/);
  t.part(key, "send").click();
  await flush();
  assert.equal(t.answers.state(key).phase, "refused");
  assert.equal(t.part(key, "error").textContent, "This call is no longer open");
  assert.equal(t.part(key, "compose").hidden, false);
  assert.equal(t.part(key, "text").readOnly, false);
  // A refusal after an uncertain attempt cannot mint a second note identity.
  t.submit(key);
  assert.equal(t.answers.state(key).requestId, uuid(1));
});

test("an empty or oversized answer is refused locally and nothing is sent", async () => {
  const t = setup();
  t.patcher.update(model([decision()]));
  const key = "decision:alpha-call";
  t.submit(key);
  assert.match(t.part(key, "error").textContent, /Choose an option or write an answer/);
  t.part(key, "text").type("é".repeat(1100));
  t.submit(key);
  assert.match(t.part(key, "error").textContent, /longer than 2000 bytes/);
  assert.equal(t.answers.state(key).path, undefined);
  assert.equal(t.fetches.length, 0);
  t.part(key, "text").type("é".repeat(300));
  t.submit(key);
  assert.equal(t.answers.state(key).path, "thread", "text alone is a thread note, under the question cap");
  t.part(key, "edit").click();
  t.leave();
  const opted = decision("a2");
  opted.answer = { ...opted.answer, options: [{ value: "staged", label: "Staged", hint: null }] };
  t.patcher.update(model([opted]));
  t.node(key).querySelector('[data-call-update-now]').click();
  const radio = t.node(key).querySelector('input[value="staged"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("é".repeat(300));
  t.submit(key);
  assert.match(t.part(key, "error").textContent, /longer than 512 bytes/);
  assert.equal(t.fetches.length, 0);
});

test("option drafts restore after a refill; Edit preserves drafts and Answer again starts empty", async () => {
  const t = setup();
  const key = "merge:beta-merge";
  t.patcher.update(model([merge()]));
  const radio = () => t.node(key).querySelector('input[type="radio"]');
  radio().checked = true;
  radio().dispatchEvent({ type: "change" });
  t.part(key, "text").type("After the demo");
  t.leave();
  t.patcher.update(model([merge("b2")]));
  assert.equal(radio().checked, true);
  assert.equal(t.part(key, "text").value, "After the demo");
  t.submit(key);
  t.part(key, "edit").click();
  assert.equal(t.answers.state(key), null);
  assert.equal(t.part(key, "text").readOnly, false);
  assert.equal(radio().checked, true);
  assert.equal(t.part(key, "text").value, "After the demo");
  t.submit(key);
  t.part(key, "send").click();
  await flush();
  t.part(key, "again").click();
  assert.equal(t.answers.state(key), null);
  assert.equal(t.part(key, "text").value, "");
  assert.equal(t.part(key, "text").readOnly, false);
  assert.equal(t.part(key, "text").disabled, false);
  assert.equal(radio().disabled, false, "Answer again unlocks the choices");
  assert.equal(radio().checked, false);
  assert.equal(t.part(key, "summary").hidden, true, "Answer again clears Your answer");
  t.submit(key);
  assert.equal(t.answers.state(key).phase, "refused");
  assert.equal(t.fetches.length, 1, "Answer again never sends the old words");
});

test("tab storage restores confirmation and receipts; prune forgets a re-held task", async () => {
  const storage = tabStorage();
  const key = "decision:alpha-call";
  const card = decision();
  card.answer = { ...card.answer, options: [{ value: "staged", label: "Staged", hint: null }], recommend: "staged" };
  const t = setup({ storage });
  t.patcher.update(model([card]));
  const radio = t.node(key).querySelector('input[value="staged"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.part(key, "text").type("Tuesday");
  t.submit(key);
  const reloaded = setup({ storage });
  reloaded.patcher.update(model([card]));
  assert.equal(reloaded.answers.state(key).phase, "confirm");
  assert.equal(reloaded.part(key, "preview").textContent, "Staged - Tuesday");
  assert.equal(reloaded.fetches.length, 0);
  reloaded.part(key, "send").click();
  await flush();
  const receiptReload = setup({ storage });
  receiptReload.patcher.update(model([decision()]));
  assert.equal(receiptReload.answers.state(key).phase, "sent");
  assert.equal(receiptReload.part(key, "receipt").hidden, false);
  assert.equal(receiptReload.part(key, "summary").hidden, false);
  assert.equal(receiptReload.part(key, "summary-label").textContent, "Staged");
  assert.equal(receiptReload.part(key, "summary-hint").textContent, "staged", "a missing option hint falls back to the sent value");
  assert.equal(receiptReload.part(key, "summary-note").textContent, "Tuesday");
  assert.equal(receiptReload.fetches.length, 0, "reload does not resend");
  receiptReload.patcher.update(model([]));
  receiptReload.timers.advance(1000);
  receiptReload.patcher.update(model([decision("a2")]));
  assert.equal(receiptReload.answers.state(key), null);
  assert.equal(receiptReload.part(key, "confirm").hidden, true);
  assert.equal(receiptReload.part(key, "text").value, "");
});

test("reload during an uncertain send offers only an explicit same-id retry", async () => {
  const storage = tabStorage();
  const key = "decision:alpha-call";
  storage.setItem("fm-quarterdeck-call-answer.v1:" + key, JSON.stringify({ phase: "sending", requestId: uuid(9), cardRev: "a1", selection: "", note: "Tuesday" }));
  const t = setup({ storage });
  t.patcher.update(model([decision()]));
  assert.equal(t.answers.state(key).phase, "failed");
  assert.equal(t.part(key, "send").textContent, "Retry send");
  t.timers.advance(60000);
  await flush();
  assert.equal(t.fetches.length, 0);
  t.part(key, "send").click();
  await flush();
  assert.equal(t.fetches[0].body.requestId, uuid(9));
});

test("a pending receipt read cannot overwrite Answer again", async () => {
  const storage = tabStorage();
  const key = "decision:alpha-call";
  storage.setItem("fm-quarterdeck-call-answer.v1:" + key, JSON.stringify({ phase: "sent", requestId: uuid(1), note: "Tuesday", receipt: { state: "accepted" } }));
  let respond;
  const t = setup({ storage, responses: [new Promise((resolve) => { respond = resolve; })] });
  t.patcher.update(model([decision()]));
  const pending = t.answers.poll();
  t.part(key, "again").click();
  respond({ status: 200, body: { answers: { [uuid(1)]: { state: "received" } } } });
  await pending;
  assert.equal(t.answers.state(key), null, "late receipts do not restore the old sent phase");
});

test("receipt polling batches at most twenty ids and leaves unavailable receipts pending", async () => {
  const storage = tabStorage();
  const cards = Array.from({ length: 21 }, (_, i) => ({ ...decision(), key: `decision:call-${i}` }));
  for (let i = 0; i < cards.length; i++) storage.setItem("fm-quarterdeck-call-answer.v1:" + cards[i].key, JSON.stringify({ phase: "sent", requestId: uuid(i + 1), note: "Tuesday", receipt: { state: "accepted" } }));
  const t = setup({ storage, responses: [{ status: 502, body: {} }, { status: 200, body: { answers: { [uuid(21)]: { state: "received" } } } }] });
  t.patcher.update(model(cards));
  await t.answers.poll();
  assert.equal(t.fetches.length, 2);
  assert.equal(new URL(t.fetches[0].url, "http://example.invalid").searchParams.get("ids").split(",").length, 20);
  assert.equal(new URL(t.fetches[1].url, "http://example.invalid").searchParams.get("ids"), uuid(21));
  assert.equal(t.answers.state(cards[0].key).receipt.state, "accepted");
  assert.equal(t.answers.state(cards[20].key).receipt.state, "received");
});

test("asks, task ids and upstream shortening stay readable without a clamp", () => {
  const t = setup();
  const key = "decision:alpha-call";
  t.patcher.update(model([decision("a1", "A short ask")]));
  const title = () => t.node(key).querySelector("h3");
  assert.equal(title().textContent, "A short ask");
  assert.equal(t.node(key).querySelector("[data-call-more]"), null);
  assert.equal(t.node(key).querySelector("[data-call-clamp]"), null);
  assert.match(t.node(key).querySelector(".call-id").textContent, /alpha-call/);
  t.leave();
  t.patcher.update(model([decision("a2", "A changed short ask")]));
  assert.equal(title().textContent, "A changed short ask");
  t.timers.advance(600);
  t.patcher.update(model([decision("a3", "Pick the window: staged or immediate, with the…")]));
  assert.equal(title().textContent, "Pick the window: staged or immediate, with the…");
  assert.equal(title().hasAttribute("data-call-truncated"), true);
  assert.match(t.node(key).querySelector(".call-shortened").textContent, /shortened this ask/);
  assert.match(t.node(key).querySelector(".call-id").textContent, /alpha-call/);
});

// Arrays built inside the vm context are not this realm's arrays.
const plain = (value) => JSON.parse(JSON.stringify(value));
test("queued answers list for the review queue, send together with their own ids, and Remove returns one to its card", async () => {
  const t = setup({ responses: [{ status: 202, body: { state: "accepted" } }, { status: 503, body: { error: "Firstmate did not confirm" } }] });
  const linked = { ...merge(), chatAsks: [{ summary: "Merge it?", replies: ["ship it"] }] };
  t.patcher.update(model([decision(), linked]));
  const [first, second] = ["decision:alpha-call", "merge:beta-merge"];
  assert.deepEqual(plain(t.answers.queued()), []);
  t.part(first, "text").type("Tuesday");
  t.submit(first);
  t.leave();
  const reply = t.node(second).querySelector('input[data-call-reply="ship it"]');
  reply.checked = true;
  reply.dispatchEvent({ type: "change" });
  t.submit(second);
  assert.equal(t.fetches.length, 0, "queueing never sends");
  assert.deepEqual(plain(t.answers.queued()), [
    { key: first, label: "Decision alpha-call", text: "Tuesday", phase: "confirm" },
    { key: second, label: "Merge beta-merge", text: "ship it", phase: "confirm" },
  ]);
  assert.equal(await t.answers.sendQueued(), false, "one unconfirmed answer reports the batch incomplete");
  assert.deepEqual(t.fetches.map((entry) => [entry.url, entry.body.key, entry.body.requestId, entry.body.text ?? null, entry.body.selection ?? null, entry.body.note ?? null]), [
    ["/api/bearings/thread", first, uuid(1), "Tuesday", null, null],
    ["/api/bearings/answer", second, uuid(2), null, "", "ship it"],
  ], "text alone is a thread note; a suggested chat reply stays an answer in the captain's words");
  assert.equal(t.answers.state(first), null, "a thread note does not become a sent answer");
  assert.equal(t.part(first, "summary").hidden, true, "a thread note does not show Your answer");
  assert.deepEqual(plain(t.answers.queued()).map((entry) => [entry.key, entry.phase]), [[second, "failed"]]);
  t.answers.unqueue(second);
  assert.equal(t.answers.state(second).phase, "compose");
  assert.equal(t.answers.state(second).requestId, uuid(2), "an attempted answer keeps its identity after Remove");
  assert.deepEqual(plain(t.answers.queued()), []);
});

test("Send batch relays every queued card on its own route and those cards become Sent", async () => {
  const asked = new Map();
  const t = setup({
    responses: [{ status: 202, body: { state: "accepted", noteId: "thread-note", sentAt: "2026-01-02T03:04:05.000Z" } }, { status: 202, body: { state: "accepted", noteId: "answer-note", sentAt: "2026-01-02T03:04:06.000Z" } }],
    onAsked: (key, holdVersion, noteId) => asked.set(key, noteId),
  });
  t.patcher.update(model([decision(), merge()]));
  const first = "decision:alpha-call";
  const second = "merge:beta-merge";
  t.part(first, "text").type("Tuesday");
  t.submit(first);
  const radio = t.node(second).querySelector('input[value="merge"]');
  radio.checked = true;
  radio.dispatchEvent({ type: "change" });
  t.submit(second);
  const thread = (key) => ({ captainAsked: Boolean(asked.get(key)), captainNoteId: asked.get(key) });
  const stateOf = (key, card) => t.win.callLifecycle.cardState({ card, answer: t.answers.state(key), thread: thread(key) });
  assert.equal(stateOf(first, decision()), "queued");
  assert.equal(stateOf(second, merge()), "queued");
  assert.equal(await t.answers.sendQueued(), true);
  assert.deepEqual(t.fetches.map((entry) => [entry.url, entry.body.key]), [["/api/bearings/thread", first], ["/api/bearings/answer", second]]);
  assert.equal(t.answers.state(first), null, "a sent thread note stays out of the answer sent phase");
  assert.equal(asked.get(first), "thread-note");
  assert.equal(t.part(first, "text").readOnly, false, "a sent thread card can still ask a follow-up");
  assert.equal(t.part(first, "text").disabled, false);
  assert.equal(Boolean(t.node(first).querySelector("input[type='radio']")?.disabled), false);
  assert.equal(t.answers.state(second).phase, "sent");
  assert.deepEqual(plain(t.answers.queued()), []);
  assert.equal(stateOf(first, decision()), "sent");
  assert.equal(stateOf(second, merge()), "sent");
  assert.equal(t.win.callLifecycle.cardState({ card: merge(), answer: t.answers.state(second), thread: thread(second), procrastinated: true }), "procrastinated");
});
