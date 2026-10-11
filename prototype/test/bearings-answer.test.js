import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AnswerRefused, answerEnvelope, answerRequestId, createAnswerRelay, formatAnswerNote, validateAnswer } from "../bearings-answer.js";
import { createBearingsHub, normalizeSnapshot } from "../bearings.js";
import { createServer } from "../server.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/bearings/${name}.json`, import.meta.url), "utf8"));
const ready = (content) => ({ schema: "fm-quarterdeck-call.v1", rev: "model-rev-1", state: "ready", ...content });
const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const refusal = (code) => (error) => error instanceof AnswerRefused && error.code === code;

// The intake key and allowed answers come only from Firstmate's own row.
test("cards carry the board's intake key; options, recommendation and close only when Firstmate supplies them", async () => {
  const raw = await fixture("two-calls");
  const { cards } = normalizeSnapshot(raw);
  const byKey = Object.fromEntries(cards.map((card) => [card.key, card]));
  assert.deepEqual(byKey["decision:alpha-call"].answer, { question: "alpha-call", options: [], recommend: null, close: null, freeform: true, allow_freeform: false, freeform_hint: null });
  assert.deepEqual(byKey["merge:beta-merge"].answer.question, "merge.beta-merge");
  assert.deepEqual(byKey["merge:beta-merge"].answer.options.map((option) => option.value), ["merge"]);
  assert.equal(byKey["merge:beta-merge"].answer.recommend, null, "Quarterdeck never recommends a merge");

  raw.decisions_open[0] = { ...raw.decisions_open[0], options: [{ value: "staged", label: "Staged rollout", hint: "Fewer users at once" }, { value: "now", label: "Ship now" }], recommend_value: "staged", close: "release" };
  const structured = normalizeSnapshot(raw).cards.find((card) => card.key === "decision:alpha-call").answer;
  assert.deepEqual(structured, { question: "alpha-call", options: [{ value: "staged", label: "Staged rollout", hint: "Fewer users at once" }, { value: "now", label: "Ship now", hint: null }], recommend: "staged", close: "release", freeform: true, allow_freeform: false, freeform_hint: null });

  for (const options of [[{ value: "reconcile", label: "Re-check" }], [{ value: "a b", label: "Bad slug" }], [{ value: "x", label: "One" }, { value: "x", label: "Duplicate" }], [{ value: "x" }], Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))]) {
    raw.decisions_open[0] = { ...raw.decisions_open[0], options, recommend_value: "x", close: "sometimes" };
    const answer = normalizeSnapshot(raw).cards.find((card) => card.key === "decision:alpha-call").answer;
    assert.deepEqual(answer.options, [], `one invalid option voids them all: ${JSON.stringify(options)}`);
    assert.equal(answer.recommend, null);
    assert.equal(answer.close, null);
  }
  raw.decisions_open[0] = { ...raw.decisions_open[0], id: `t${"x".repeat(130)}` };
  assert.equal(normalizeSnapshot(raw).cards[0].answer, null, "a key the intake cannot accept is answered in chat instead");
});

test("an answer must name an open card at the revision shown and one of its own options", async () => {
  const model = ready(normalizeSnapshot(await fixture("two-calls")));
  const decision = model.cards.find((card) => card.key === "decision:alpha-call");
  const merge = model.cards.find((card) => card.key === "merge:beta-merge");
  const body = (extra) => ({ requestId: uuid(), key: decision.key, cardRev: decision.rev, selection: "", note: "Use the Tuesday window", ...extra });
  assert.equal(validateAnswer(body(), model).note, "Use the Tuesday window");
  assert.equal(validateAnswer(body({ key: merge.key, cardRev: merge.rev, selection: "merge", note: "" }), model).selection, "merge");
  assert.equal(validateAnswer(body({ note: "  two\r\nlines  " }), model).note, "two\nlines");
  const refused = [
    [null, "invalid"], [body({ extra: 1 }), "invalid"], [body({ requestId: "not-a-uuid" }), "invalid"], [body({ cardRev: "zz" }), "invalid"],
    [body({ note: "bell\u0007" }), "invalid-text"], [body({ selection: "reconcile" }), "reconcile"], [body({ note: "   " }), "empty"],
    [body({ note: "é".repeat(257) }), "too-long"], [body({ key: "decision:missing" }), "gone"], [body({ cardRev: "0".repeat(16) }), "changed"],
    [body({ selection: "merge" }), "bad-option"],
  ];
  for (const [input, code] of refused) assert.throws(() => validateAnswer(input, model), refusal(code), code);
  assert.throws(() => validateAnswer(body(), { ...model, state: "stale" }), refusal("not-current"));
  assert.throws(() => validateAnswer(body(), { ...model, cards: [{ ...decision, answer: null }] }), refusal("not-answerable"));
});

test("the envelope is the board's fm-bearings-answer.v1 context plus provenance, in a fence captain text cannot close", async () => {
  const model = ready(normalizeSnapshot(await fixture("two-calls")));
  const merge = model.cards.find((card) => card.key === "merge:beta-merge");
  const envelope = answerEnvelope({ card: merge, selection: "merge", note: "after the ```demo``` today" }, model.rev);
  assert.deepEqual(envelope, {
    schema: "fm-bearings-answer.v1", question: "merge.beta-merge", selection: "", note: "merge - after the ```demo``` today",
    channel: "quarterdeck", type: "merge", task: "beta-merge", label: "Merge beta-merge -> merge - after the ```demo``` today", cardRev: merge.rev, observedRev: "model-rev-1",
  });
  const bare = answerEnvelope({ card: merge, selection: "merge", note: "" }, model.rev);
  assert.equal(bare.selection, "merge");
  assert.equal(bare.note, "");
  assert.notEqual(envelope.selection || envelope.note, "merge", "a typed note is instruction text in the keyed intake");
  const text = formatAnswerNote(envelope);
  assert.match(text.split("\n")[0], /^Captain's Call answer from Quarterdeck · Merge beta-merge: merge - after the/);
  const fences = text.split("\n").filter((line) => line.startsWith("```"));
  assert.deepEqual(fences, ["```json fm-bearings-answer", "```"], "exactly one fenced block");
  const json = JSON.parse(/```json fm-bearings-answer\n([\s\S]*?)\n```/.exec(text)[1]);
  assert.deepEqual(json, envelope);
  // The lavish adapter's own rule: answer = selection when set, else note; close only when declared.
  const decision = model.cards.find((card) => card.key === "decision:alpha-call");
  const freeform = answerEnvelope({ card: { ...decision, answer: { ...decision.answer, close: "release" } }, selection: "", note: "Tuesday" }, "r");
  assert.equal(freeform.question, "alpha-call");
  assert.equal(freeform.close, "release");
  assert.equal("close" in answerEnvelope({ card: decision, selection: "", note: "Tuesday" }, "r"), false);
});

test("the relay notes once per request id, replays a retry after the card left, and reports receipts", async () => {
  const notes = [];
  const relay = createAnswerRelay({ home: "/synthetic/home", now: () => Date.parse("2026-01-02T03:04:05Z"),
    note: async (home, id, text) => { notes.push({ home, id, text }); return { id: "note-1", outcome: notes.length > 1 ? "replay" : "created" }; },
    receipts: async () => ({ pending: [{ id: "note-1", request_id: answerRequestId(uuid()), announced: true }], handled: [], replies: [] }) });
  const model = ready(normalizeSnapshot(await fixture("two-calls")));
  const decision = model.cards.find((card) => card.key === "decision:alpha-call");
  const body = { requestId: uuid(), key: decision.key, cardRev: decision.rev, selection: "", note: "Tuesday" };
  const first = await relay.submit(body, model);
  assert.equal(first.state, "accepted");
  assert.equal(first.replay, false);
  assert.equal(notes[0].id, "quarterdeck-call:00000000-0000-4000-8000-000000000001");
  // Firstmate already acted and the card is gone: the retry still resends the identical note.
  const retry = await relay.submit(body, ready({ cards: [], coverage: null, omitted: [] }));
  assert.equal(retry.replay, true);
  assert.equal(notes[1].text, notes[0].text);
  await assert.rejects(relay.submit({ ...body, note: "Wednesday" }, model), refusal("request-reused"));
  const status = await relay.status([uuid(), uuid(2), "bad"]);
  assert.deepEqual(status.answers, { [uuid()]: { state: "accepted", announced: true }, [uuid(2)]: { state: "unknown" } });

  const failing = createAnswerRelay({ home: "/synthetic/home", note: async () => { throw new Error("down"); } });
  await assert.rejects(failing.submit({ ...body, requestId: uuid(3) }, model), refusal("unconfirmed"));
  await assert.rejects(createAnswerRelay({}).submit(body, model), refusal("unconfigured"));
});

test("an unconfirmed delivery retains its exact envelope for a same-id retry after the model changes", async () => {
  const model = ready(normalizeSnapshot(await fixture("two-calls")));
  const card = model.cards[0];
  const body = { requestId: uuid(), key: card.key, cardRev: card.rev, selection: "", note: "Tuesday" };
  const attempts = [];
  const relay = createAnswerRelay({ home: "/synthetic/home", note: async (_home, _id, text) => {
    attempts.push(text);
    if (attempts.length === 1) throw new Error("acknowledgement unavailable");
    return { id: "note-1", outcome: "replay" };
  } });
  await assert.rejects(relay.submit(body, model), refusal("unconfirmed"));
  await assert.rejects(relay.submit({ ...body, note: "Wednesday" }, model), refusal("request-reused"));
  const retry = await relay.submit(body, ready({ cards: [], rev: "new-model" }));
  assert.equal(retry.replay, true);
  assert.equal(retry.envelope.observedRev, model.rev);
  assert.equal(attempts[1], attempts[0], "unconfirmed retries preserve the original note byte for byte");
});

async function answerServer(context, { relay, revision = "a".repeat(40) } = {}) {
  const raw = await fixture("two-calls");
  const hub = createBearingsHub({ runner: async () => JSON.stringify(raw), watchRecords: null, fingerprint: null });
  let head = revision;
  const server = createServer({}, { revisionResolver: { initial: revision, snapshot: async () => head }, bearingsSource: hub, answerRelay: relay });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  hub.touch();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { base, hub, moveHead: (value) => { head = value; } };
}

test("POST /api/bearings/answer is same-origin JSON on the host only, revision-guarded, and relays exactly once", async (context) => {
  const calls = [];
  const relay = createAnswerRelay({ home: "/synthetic/home", note: async (home, id, text) => { calls.push({ id, text }); return { id: "note-9", outcome: "created" }; }, receipts: async () => ({ pending: [], handled: [], replies: [] }) });
  const { base, hub, moveHead } = await answerServer(context, { relay });
  const card = hub.current().cards.find((entry) => entry.key === "decision:alpha-call");
  const origin = base;
  const post = (body, headers = {}, path = "/api/bearings/answer") => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const body = { requestId: uuid(), key: card.key, cardRev: card.rev, selection: "", note: "Tuesday window" };

  assert.equal((await post(body, { origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await post(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(5000))).status, 413);
  assert.equal((await post({ ...body, key: "decision:missing" })).status, 409);
  assert.equal((await post({ ...body, selection: "reconcile" })).status, 422);
  assert.equal((await post(body, {}, "/preview/main/api/bearings/answer")).status, 404);
  assert.equal((await fetch(`${base}/preview/main/api/bearings/answer/status?ids=${uuid()}`)).status, 404);
  assert.equal(calls.length, 0, "no refusal reaches Firstmate");

  const accepted = await post(body);
  assert.equal(accepted.status, 202);
  const receipt = await accepted.json();
  assert.equal(receipt.requestId, uuid());
  assert.equal(receipt.envelope.question, "alpha-call");
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /```json fm-bearings-answer/);

  const status = await (await fetch(`${base}/api/bearings/answer/status?ids=${uuid()}`)).json();
  assert.deepEqual(status, { answers: { [uuid()]: { state: "unknown" } } });

  moveHead("b".repeat(40));
  const moved = await post({ ...body, requestId: uuid(2) });
  assert.ok([409, 503].includes(moved.status), "a moved revision never answers");
  assert.equal(calls.length, 1);
});

test("answer status fails visibly when Firstmate receipts are unavailable", async (context) => {
  const relay = createAnswerRelay({ home: "/synthetic/home", receipts: async () => { throw new Error("offline"); } });
  const { base } = await answerServer(context, { relay });
  const response = await fetch(`${base}/api/bearings/answer/status?ids=${uuid()}`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "Firstmate receipts unavailable");
});
