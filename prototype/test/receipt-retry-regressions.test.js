// Receipt identity and uncertain delivery regressions (BEARINGS.md "Lifecycle" and
// "Just landed"). Fixtures are synthetic inbox records, client DOMs and session storage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createAnswerRelay } from "../bearings-answer.js";
import { createThreadRelay } from "../bearings-thread.js";
import { callDom, fakeTimers } from "./helpers/call-dom.js";

const sources = await Promise.all(["bearings-view.js", "call-lifecycle.js", "bearings-answer-form.js", "bearings-thread-panel.js", "bearings-landed.js"].map((name) => readFile(new URL(`../public/${name}`, import.meta.url), "utf8")));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const card = { key: "decision:alpha-call", type: "decision", task: "alpha-call", summary: "Pick the window", rev: "a".repeat(16), answer: { question: "alpha-call", options: [], freeform: true } };
const landed = { key: "landed:ship-window", type: "landed", task: "ship-window", what: "Land the window", rev: "b".repeat(16), artifact: "local main" };
const model = { state: "ready", rev: "current", cards: [card], landed: [landed], omitted: [] };
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const oldAsk = { kind: "ask", from: "captain", noteId: "old-note", at: "2026-10-01T10:00:00Z", state: "replied", replyScope: "individual", text: "Old question" };
const oldReply = { kind: "reply", from: "firstmate", noteId: oldAsk.noteId, at: "2026-10-01T10:05:00Z", text: "Old reply" };
const newAsk = { kind: "ask", from: "captain", noteId: "new-note", at: "2026-10-01T11:00:00Z", state: "waiting", text: "New question" };

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

// A click whose handler may call preventDefault.
const press = (node) => node.dispatchEvent({ type: "click", preventDefault() {} });

function mount(fetchImpl, { tab = storage(), isLanded = false, nextId = null } = {}) {
  const dom = callDom();
  const timers = fakeTimers();
  const win = { document: dom.document, sessionStorage: tab, navigator: {} };
  const context = vm.createContext({ window: win, URL, TextEncoder });
  for (const source of sources) vm.runInContext(source, context);
  const list = dom.document.createElement("div");
  dom.document.body.append(list);
  let n = 0;
  let board, answers, threads, node;
  if (isLanded) {
    board = win.bearingsLanded.createController({ list, doc: dom.document, storage: tab, timers, fetchImpl, uuid: nextId || (() => uuid(++n)) });
    board.update(model);
    node = list.querySelector("[data-landed-key]");
  } else {
    node = dom.document.createElement("article");
    node.setAttribute("data-call-key", card.key);
    node.setAttribute("data-call-rev", card.rev);
    node.innerHTML = win.bearingsView.cardHtml(card);
    list.append(node);
    threads = win.bearingsThread.createThreadController({ list, doc: dom.document, win, storage: tab, timers, fetchImpl });
    answers = win.bearingsAnswerForm.createAnswerController({ list, doc: dom.document, win, storage: tab, timers, fetchImpl, uuid: () => uuid(++n),
      onAsked: (key, holdVersion, noteId) => threads.noteSent(key, holdVersion, noteId) });
    answers.render(node, card);
    threads.render(node);
  }
  const part = (name) => node.querySelector(`[data-${isLanded ? "landed" : "call-answer"}-${name}]`);
  const queue = () => (isLanded ? part("follow") : node.querySelector("[data-call-answer]")).dispatchEvent({ type: "submit", preventDefault() {} });
  return { ...dom, win, board, answers, threads, node, part, queue, tab, life: win.callLifecycle,
    facts: () => ({ card, answer: answers?.state(card.key), thread: threads?.state(card.key) }),
    destroy() { board?.destroy(); answers?.destroy(); threads?.destroy(); } };
}

for (const held of [false, true]) {
  test(`history order wins over a restarted answer retry's ${held ? "held reply" : "sent receipt"}`, async () => {
    let now = Date.parse("2026-10-01T10:00:00Z");
    const notes = new Map();
    const note = async (_home, id, body) => {
      const previous = notes.get(id);
      if (previous) return { id: previous.id, outcome: "replay" };
      const value = { id: `note-${notes.size + 1}`, request_id: id, body, at: new Date(now).toISOString() };
      notes.set(id, value);
      return { id: value.id, outcome: "created" };
    };
    const body = { requestId: uuid(1), key: card.key, cardRev: card.rev, selection: "", note: "Earlier answer" };
    await createAnswerRelay({ home: "/synthetic/home", note, now: () => now }).submit(body, model);
    now = Date.parse("2026-10-01T11:00:00Z");
    await createAnswerRelay({ home: "/synthetic/home", note, now: () => now }).submit({ ...body, requestId: uuid(2), note: "Newer answer" }, model);
    // A restarted relay replays the earlier note but reports the retry's own clock.
    now = Date.parse("2026-10-01T12:00:00Z");
    const replay = await createAnswerRelay({ home: "/synthetic/home", note, now: () => now }).submit(body, model);
    assert.equal(replay.noteId, "note-1");
    assert.equal(replay.replay, true);
    const receipts = { pending: [notes.get(`quarterdeck-call:${uuid(2)}`)], handled: [notes.get(`quarterdeck-call:${uuid(1)}`)], replies: [] };
    const relay = createThreadRelay({ home: "/synthetic/home", receipts: async () => receipts, transcript: async () => ({ turns: [] }) });
    const thread = await relay.history(card.key, model);
    const t = mount(async () => response({ entries: [] }));
    for (const state of ["received", "replied"]) {
      const answer = held ? { phase: "compose", heldNoteId: replay.noteId, heldAt: replay.sentAt, heldReply: "Earlier reply", heldReplyScope: "individual" }
        : { phase: "sent", noteId: replay.noteId, sentAt: replay.sentAt, receipt: { state, reply: "Earlier reply", replyScope: "individual" } };
      const facts = { card, answer, thread };
      assert.equal(t.life.delivery(facts).posture, "pending", "the newer pending note owns the receipt");
      assert.equal(t.life.delivery(facts).reply, "");
      assert.equal(t.life.cardState(facts), "sent");
      for (const [latestState, expected] of [["received", "acknowledged"], ["replied", "replied"]]) {
        const updated = { ...thread, entries: thread.entries.map((entry) => entry.noteId === "note-2" ? { ...entry, state: latestState, ...(latestState === "replied" ? { replyScope: "individual" } : {}) } : entry) };
        const current = { card, answer, thread: updated };
        assert.equal(t.life.delivery(current).posture, expected);
        assert.equal(t.life.delivery(current).reply, "", "the earlier note's reply is never credited to the newer note");
      }
    }
    t.destroy();
  });
}

test("an accepted thread note keeps its identity through a stale in-flight history read", async () => {
  let finishOld, finishNew;
  let reads = 0;
  const t = mount(async (_url, options) => {
    if (options?.method === "POST") return response({ state: "accepted", noteId: newAsk.noteId }, 202);
    reads++;
    if (reads === 1) return new Promise((resolve) => { finishOld = resolve; });
    return new Promise((resolve) => { finishNew = resolve; });
  });
  t.part("text").type(newAsk.text);
  t.queue();
  press(t.part("send"));
  await flush();
  assert.equal(t.life.delivery(t.facts()).posture, "pending");
  finishOld(response({ entries: [oldAsk, oldReply] }));
  await flush();
  assert.equal(t.life.delivery(t.facts()).posture, "pending", "an older replied ask cannot stand in for the newly accepted note");
  assert.equal(t.life.delivery(t.facts()).reply, "");
  finishNew(response({ entries: [oldAsk, oldReply, newAsk] }));
  await flush();
  assert.equal(t.life.delivery(t.facts()).posture, "pending");
  t.destroy();
});

test("an accepted thread note keeps its identity across a reload until its own reply appears", async () => {
  const tab = storage();
  const first = mount(async () => response({ entries: [oldAsk, oldReply] }), { tab });
  await flush();
  first.threads.noteSent(card.key, null, newAsk.noteId);
  await flush();
  first.destroy();
  let entries = [oldAsk, oldReply];
  const second = mount(async () => response({ entries }), { tab });
  await flush();
  assert.equal(second.life.delivery(second.facts()).posture, "pending");
  entries = [oldAsk, oldReply, { ...newAsk, state: "replied", replyScope: "individual" }, { kind: "reply", from: "firstmate", noteId: newAsk.noteId, text: "New reply" }];
  await second.threads.load(card.key);
  assert.equal(second.life.delivery(second.facts()).posture, "replied");
  assert.equal(second.life.delivery(second.facts()).reply, "New reply");
  second.destroy();
});

test("a stale read for a pruned call cannot clear a re-held call's accepted identity", async () => {
  let resolveOld;
  let reads = 0;
  const t = mount(async () => {
    reads++;
    if (reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
    return response({ entries: [oldAsk, oldReply] });
  });
  t.threads.noteSent(card.key, null, oldAsk.noteId);
  t.threads.prune([]);
  t.threads.render(t.node);
  t.threads.noteSent(card.key, null, newAsk.noteId);
  await flush();
  resolveOld(response({ entries: [oldAsk, oldReply] }));
  await flush();
  assert.equal(t.life.delivery(t.facts()).posture, "pending");
  assert.equal(t.threads.state(card.key).captainNoteId, newAsk.noteId);
  t.destroy();
});

// A thread relay whose first delivery is stored but its response is lost.
function inbox() {
  const notes = new Map();
  const submissions = [];
  const options = { home: "/synthetic/home", note: async (_home, requestId, body) => {
    if (notes.has(requestId)) return { id: notes.get(requestId).id, outcome: "replay" };
    const record = { id: `note-${notes.size + 1}`, body };
    notes.set(requestId, record);
    return { id: record.id, outcome: "created" };
  } };
  let relay = createThreadRelay(options);
  let fail = true;
  const fetchImpl = async (_url, init) => {
    if (init?.method !== "POST") return response({ entries: [], acks: {} });
    const body = JSON.parse(init.body);
    submissions.push(body);
    try {
      const result = await relay.submit(body, model);
      if (fail) { fail = false; throw new TypeError("Response lost after durable storage"); }
      return response(result, 202);
    } catch (error) {
      if (!error.status) throw error;
      return response({ error: error.message }, error.status);
    }
  };
  return { fetchImpl, notes, submissions, restart() { relay = createThreadRelay(options); } };
}

test("an uncertain landed follow-up locks Edit, the text and Queue until the exact payload is confirmed", async () => {
  const fixture = inbox();
  const t = mount(fixture.fetchImpl, { isLanded: true });
  await flush();
  t.part("text").type("Original follow-up");
  t.queue();
  press(t.part("send"));
  await flush();
  assert.equal(fixture.notes.size, 1);
  assert.equal(t.part("edit").disabled, true);
  assert.equal(t.part("send").textContent, "Retry send");
  press(t.part("edit"));
  t.part("text").type("Replacement words");
  t.queue();
  press(t.part("send"));
  await flush();
  assert.deepEqual(fixture.submissions, [
    { requestId: uuid(1), key: landed.key, text: "Original follow-up" },
    { requestId: uuid(1), key: landed.key, text: "Original follow-up" },
  ]);
  assert.equal(fixture.notes.size, 1);
  assert.equal(t.part("notice").textContent, "Question sent to Firstmate");
  t.destroy();
});

test("an uncertain landed payload and request ID survive client and relay restarts", async () => {
  const fixture = inbox();
  const tab = storage();
  const first = mount(fixture.fetchImpl, { tab, isLanded: true });
  await flush();
  first.part("text").type("Persisted original words");
  first.queue();
  press(first.part("send"));
  await flush();
  first.destroy();
  fixture.restart();
  const second = mount(fixture.fetchImpl, { tab, isLanded: true, nextId: () => uuid(2) });
  await flush();
  assert.equal(second.part("text").value, "Persisted original words");
  assert.equal(second.part("text").disabled, true);
  assert.equal(second.part("edit").disabled, true);
  assert.equal(fixture.submissions.length, 1, "reload must not send automatically");
  press(second.part("send"));
  await flush();
  assert.deepEqual(fixture.submissions[1], fixture.submissions[0]);
  assert.equal(fixture.notes.size, 1);
  assert.equal(second.part("notice").textContent, "Question sent to Firstmate");
  second.part("text").type("Replacement after confirmation");
  second.queue();
  press(second.part("send"));
  await flush();
  assert.notEqual(fixture.submissions[2].requestId, fixture.submissions[0].requestId);
  assert.equal(fixture.notes.size, 2);
  second.destroy();
});

test("a landed send stops before delivery when this tab cannot save the attempted payload", async () => {
  const fixture = inbox();
  const tab = { getItem: () => null, setItem() { throw new Error("Storage denied"); }, removeItem() {} };
  const t = mount(fixture.fetchImpl, { tab, isLanded: true });
  await flush();
  t.part("text").type("Keep these words");
  t.queue();
  press(t.part("send"));
  await flush();
  assert.equal(fixture.submissions.length, 0);
  assert.equal(t.part("preview").textContent, "Keep these words");
  assert.equal(t.part("error").hidden, false);
  t.destroy();
});

test("a landed refusal permits editing only when no earlier attempt was uncertain", async () => {
  for (const uncertain of [false, true]) {
    const submissions = [];
    const t = mount(async (_url, init) => {
      if (init?.method !== "POST") return response({ entries: [], acks: {} });
      submissions.push(JSON.parse(init.body));
      if (uncertain && submissions.length === 1) return response({ error: "Unconfirmed delivery" }, 502);
      return response({ error: "Follow-up refused" }, 409);
    }, { isLanded: true });
    await flush();
    t.part("text").type("Original words");
    t.queue();
    press(t.part("send"));
    await flush();
    if (uncertain) {
      assert.equal(t.part("edit").disabled, true);
      press(t.part("send"));
      await flush();
      assert.deepEqual(submissions[1], submissions[0]);
      assert.equal(t.part("text").disabled, true);
      assert.equal(t.part("edit").disabled, true, "a later refusal does not prove the earlier delivery was absent");
      press(t.part("edit"));
      t.part("text").type("Replacement words");
      t.queue();
      press(t.part("send"));
      await flush();
      assert.deepEqual(submissions[2], submissions[0]);
    } else {
      assert.equal(t.part("text").disabled, false);
      t.part("text").type("Replacement words");
      t.queue();
      press(t.part("send"));
      await flush();
      assert.notEqual(submissions[1].requestId, submissions[0].requestId);
      assert.equal(submissions[1].text, "Replacement words");
    }
    t.destroy();
  }
});

test("a landed payload is saved before its response and a reload never sends it automatically", async () => {
  const tab = storage();
  let resolveSend;
  const first = mount(async (_url, init) => init?.method === "POST"
    ? new Promise((resolve) => { resolveSend = resolve; }) : response({ entries: [], acks: {} }), { tab, isLanded: true });
  await flush();
  first.part("text").type("Pending response words");
  first.queue();
  press(first.part("send"));
  await flush();
  assert.equal(first.part("edit").disabled, true);
  first.destroy();
  const submissions = [];
  const second = mount(async (_url, init) => {
    if (init?.method === "POST") {
      submissions.push(JSON.parse(init.body));
      if (submissions.length === 2) throw new TypeError("Second delivery response lost");
    }
    return response({ entries: [], acks: {} });
  }, { tab, isLanded: true, nextId: () => uuid(2) });
  await flush();
  assert.equal(second.part("text").value, "Pending response words");
  assert.equal(second.part("text").disabled, true);
  assert.equal(submissions.length, 0);
  press(second.part("send"));
  await flush();
  assert.deepEqual(submissions, [{ requestId: uuid(1), key: landed.key, text: "Pending response words" }]);
  second.part("text").type("New uncertain words");
  second.queue();
  press(second.part("send"));
  await flush();
  assert.deepEqual(submissions[1], { requestId: uuid(2), key: landed.key, text: "New uncertain words" });
  // The destroyed first controller's late response cannot erase the newer saved payload.
  resolveSend(response({ state: "accepted", noteId: "original-note" }, 202));
  await flush();
  second.destroy();
  const third = mount(async () => response({ entries: [], acks: {} }), { tab, isLanded: true });
  await flush();
  assert.equal(third.part("text").value, "New uncertain words");
  assert.equal(third.part("edit").disabled, true);
  third.destroy();
});
