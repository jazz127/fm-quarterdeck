import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { answerEnvelope, answerRequestId, formatAnswerNote } from "../bearings-answer.js";
import { createBearingsHub } from "../bearings.js";
import { ThreadRefused, createThreadRelay, createTranscriptTurns, formatThreadNote, noteForCard, taggedEnvelope, threadKeyPart, threadRequestId, threadText } from "../bearings-thread.js";
import { createServer } from "../server.js";

const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const refusal = (code) => (error) => error instanceof ThreadRefused && error.code === code;
const decision = { key: "decision:alpha-call", type: "decision", task: "alpha-call", summary: "Pick the alpha rollout window", rev: "r1",
  answer: { question: "alpha-call", options: [], recommend: null, close: null, freeform: true } };
const chat = { key: "chat:0123456789abcdef", type: "chat", marker: "DECISION NEEDED", summary: "Ship the synthetic beta?", rev: "c1", clock: { at: "2026-01-01T09:00:00.000Z" },
  answer: { question: "chat.0123456789abcdef", options: [], recommend: null, close: null, freeform: true } };
const model = (cards = [decision, chat]) => ({ cards });
const empty = async () => ({ pending: [], handled: [], replies: [] });
const noTranscript = async () => ({ turns: [], omitted: false });

test("thread request ids embed the card key, or its hash when the inbox id grammar would overflow", () => {
  assert.equal(threadRequestId("decision:alpha-call", uuid()), `quarterdeck-thread:decision:alpha-call:${uuid()}`);
  const long = `decision:${"a".repeat(100)}`;
  assert.match(threadKeyPart(long), /^h-[0-9a-f]{16}$/);
  for (const key of ["decision:alpha-call", long, chat.key]) assert.match(threadRequestId(key, uuid()), /^[A-Za-z0-9._:-]{1,128}$/);
});

test("a thread note names the card, the reply route and a fence the captain's text cannot close", () => {
  const text = formatThreadNote({ key: decision.key, card: decision, text: "What is this ```about```?", requestId: uuid() });
  assert.match(text, /^Captain asks about Decision alpha-call from Quarterdeck: /);
  assert.match(text, /fm-inbox\.sh reply <this note id>/);
  assert.match(text, /nothing was decided/);
  const envelope = taggedEnvelope(text, "fm-quarterdeck-thread");
  assert.deepEqual(envelope, { schema: "fm-quarterdeck-card-thread.v1", key: decision.key, type: "decision", task: "alpha-call", question: "What is this ```about```?", requestId: uuid() });
  const ask = taggedEnvelope(formatThreadNote({ key: chat.key, card: chat, text: "Context?", requestId: uuid() }), "fm-quarterdeck-thread");
  assert.equal(ask.ask, "DECISION NEEDED: Ship the synthetic beta?");
  assert.equal(ask.task, undefined);
});

test("thread text keeps line breaks but never serves absolute paths or control characters", () => {
  assert.equal(threadText("See /srv/synthetic/home/data/report.md\n\n\n\nok\u0007"), "See …/report.md\n\nok");
  assert.equal(threadText("x".repeat(10), 5), "xxxx…");
  assert.equal(threadText(null), "");
});

test("submit validates, relays once per request id and refuses reuse with different words", async () => {
  const calls = [];
  let fail = true;
  const relay = createThreadRelay({ home: "/synthetic/home", receipts: empty, transcript: noTranscript, now: () => Date.parse("2026-01-02T03:04:05Z"),
    note: async (_home, id, text) => { calls.push({ id, text }); if (fail) { fail = false; throw new Error("down"); } return { id: "note-1", outcome: calls.length > 1 ? "replay" : "created" }; } });
  const body = { requestId: uuid(), key: decision.key, text: "  What is alpha about?  " };
  await assert.rejects(createThreadRelay({}).submit(body, model()), refusal("unconfigured"));
  await assert.rejects(relay.submit({ ...body, extra: 1 }, model()), refusal("invalid"));
  await assert.rejects(relay.submit({ ...body, requestId: "nope" }, model()), refusal("invalid"));
  await assert.rejects(relay.submit({ ...body, key: "lane:x" }, model()), refusal("invalid"));
  await assert.rejects(relay.submit({ ...body, text: "   " }, model()), refusal("empty"));
  await assert.rejects(relay.submit({ ...body, text: "a\u0007b" }, model()), refusal("invalid-text"));
  await assert.rejects(relay.submit({ ...body, text: "é".repeat(1001) }, model()), refusal("too-long"));
  await assert.rejects(relay.submit({ ...body, key: "decision:missing" }, model()), refusal("gone"));
  assert.equal(calls.length, 0, "no refusal reaches Firstmate");

  await assert.rejects(relay.submit(body, model()), refusal("unconfirmed"));
  await assert.rejects(relay.submit({ ...body, text: "Different words" }, model()), refusal("request-reused"));
  // The card may leave between the unconfirmed send and its retry; the same note is resent.
  const retry = await relay.submit(body, model([]));
  assert.deepEqual(retry, { state: "accepted", requestId: uuid(), key: decision.key, noteId: "note-1", replay: true, sentAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, `quarterdeck-thread:decision:alpha-call:${uuid()}`);
  assert.equal(calls[1].text, calls[0].text, "a retry resends the original note byte for byte");
});

test("noteForCard matches thread asks by key and answers by their envelope, never another card's", () => {
  const ask = (key, n = 1) => ({ id: `n${n}`, request_id: threadRequestId(key, uuid(n)), body: formatThreadNote({ key, card: key === chat.key ? chat : decision, text: `Q${n}`, requestId: uuid(n) }) });
  assert.deepEqual(noteForCard(ask(decision.key), decision.key, decision), { kind: "ask", text: "Q1" });
  assert.equal(noteForCard(ask(decision.key), "merge:alpha-call", null), null);
  assert.equal(noteForCard(ask(chat.key), decision.key, decision), null);
  const answer = (card, selection, note) => ({ id: "a1", request_id: answerRequestId(uuid(9)), body: formatAnswerNote(answerEnvelope({ card, selection, note }, "m1")) });
  assert.deepEqual(noteForCard(answer(decision, "", "Tuesday"), decision.key, decision), { kind: "answer", text: "Tuesday" });
  assert.equal(noteForCard(answer(decision, "", "Tuesday"), "merge:alpha-call", null), null, "a decision answer is not the merge card's");
  assert.deepEqual(noteForCard(answer(chat, "", "Yes"), chat.key, chat), { kind: "answer", text: "Yes" });
  assert.equal(noteForCard({ id: "x", request_id: "agentos-review:abc", body: "unrelated" }, decision.key, decision), null);
  // A hand-filed note that carries the tagged fence still joins its card.
  assert.deepEqual(noteForCard({ id: "h", request_id: null, body: `Hand note\n\`\`\`json fm-quarterdeck-thread\n${JSON.stringify({ key: decision.key, question: "By hand" })}\n\`\`\`` }, decision.key, decision), { kind: "ask", text: "By hand" });
});

test("history joins the card's notes, replies, chat asks and Firstmate chat turns, oldest first", async () => {
  const askNote = { id: "note-ask", at: "2026-01-02T10:00:00Z", request_id: threadRequestId(decision.key, uuid(1)), body: formatThreadNote({ key: decision.key, card: decision, text: "What is alpha?", requestId: uuid(1) }),
    reply: { id: "note-ask", at: "2026-01-02T11:00:00Z", body: "Alpha picks the rollout window; see /srv/synthetic/home/data/alpha.md" } };
  const reply = askNote.reply;
  delete askNote.reply; // Real receipts return replies in a separate collection.
  const answerNote = { id: "note-answer", at: "2026-01-02T12:00:00Z", request_id: answerRequestId(uuid(2)), body: formatAnswerNote(answerEnvelope({ card: decision, selection: "", note: "Tuesday" }, "m1")) };
  const other = { id: "note-other", at: "2026-01-02T09:30:00Z", request_id: threadRequestId("decision:gamma", uuid(3)), body: "elsewhere" };
  const turns = [
    { at: "2026-01-02T09:00:00.000Z", text: "Filed a hold for alpha-call: pick the window." },
    { at: "2026-01-02T09:10:00.000Z", text: "Unrelated alpha-callback work." },
    { at: null, text: "alpha-call is still waiting." },
  ];
  const relay = createThreadRelay({ home: "/synthetic/home", now: () => Date.parse("2026-01-03T00:00:00Z"), transcript: async () => ({ turns, omitted: true }),
    receipts: async () => ({ pending: [answerNote, other], handled: [askNote], replies: [reply] }) });
  const history = await relay.history(decision.key, model());
  assert.equal(history.task, "alpha-call");
  assert.deepEqual(history.transcript, { state: "ready", windowed: true });
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.from, entry.at]), [
    ["chat", "firstmate", "2026-01-02T09:00:00.000Z"],
    ["ask", "captain", "2026-01-02T10:00:00Z"],
    ["reply", "firstmate", "2026-01-02T11:00:00Z"],
    ["answer", "captain", "2026-01-02T12:00:00Z"],
    ["chat", "firstmate", null],
  ]);
  assert.equal(history.entries[1].state, "replied");
  assert.equal(history.entries[3].state, "waiting");
  assert.match(history.entries[2].text, /see …\/alpha\.md$/);

  await assert.rejects(relay.history("lane:x", model()), refusal("invalid"));
  const chatHistory = await createThreadRelay({ home: "/synthetic/home", receipts: empty, transcript: async () => { throw new Error("not consulted"); } }).history(chat.key, model());
  assert.equal(chatHistory.transcript.state, "not-applicable");
  assert.deepEqual(chatHistory.entries.map((entry) => entry.kind), ["chat-ask"]);
  const broken = await createThreadRelay({ home: "/synthetic/home", receipts: empty, transcript: async () => { throw new Error("gone"); } }).history(decision.key, model());
  assert.equal(broken.transcript.state, "unavailable");
});

test("transcript turns are Firstmate's own text, re-read only when the file changes", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fm-thread-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const line = (type, text, timestamp) => JSON.stringify({ type, timestamp, message: { role: type, content: [{ type: "text", text }] } });
  await writeFile(file, `${line("user", "captain says alpha-call", "2026-01-02T08:00:00Z")}\n${line("assistant", "Firstmate on alpha-call", "2026-01-02T08:01:00Z")}\n`);
  let discovered = 0;
  const turns = createTranscriptTurns({ home: "/synthetic/home", discover: async () => { discovered += 1; return { sources: [{ file, origin: "claude", source: "primary" }, { file: path.join(dir, "missing.jsonl"), origin: "claude", source: "primary" }] }; } });
  const first = await turns();
  assert.deepEqual(first.turns.map((turn) => [turn.text, turn.at]), [["Firstmate on alpha-call", "2026-01-02T08:01:00.000Z"]]);
  assert.equal(first.omitted, false);
  assert.strictEqual((await turns()).turns[0].text, first.turns[0].text);
  assert.equal(discovered, 1, "discovery is cached between reads");
  assert.deepEqual(await createTranscriptTurns({})(), { turns: [], omitted: false });
});

async function threadServer(context, { relay, revision = "a".repeat(40) } = {}) {
  const raw = JSON.parse(await readFile(new URL("./fixtures/bearings/two-calls.json", import.meta.url), "utf8"));
  const hub = createBearingsHub({ runner: async () => JSON.stringify(raw), watchRecords: null, fingerprint: null });
  let head = revision;
  const server = createServer({}, { revisionResolver: { initial: revision, snapshot: async () => head }, bearingsSource: hub, threadRelay: relay });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  hub.touch();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { base, hub, moveHead: (value) => { head = value; } };
}

test("thread routes are same-origin JSON on the host only and revision-guarded", async (context) => {
  const calls = [];
  const relay = createThreadRelay({ home: "/synthetic/home", transcript: noTranscript, receipts: empty, note: async (_home, id, text) => { calls.push({ id, text }); return { id: "note-3", outcome: "created" }; } });
  const { base, moveHead } = await threadServer(context, { relay });
  const post = (body, headers = {}, route = "/api/bearings/thread") => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const body = { requestId: uuid(), key: "decision:alpha-call", text: "What is alpha about?" };

  assert.equal((await post(body, { origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await post(body, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("x".repeat(5000))).status, 413);
  assert.equal((await post({ ...body, key: "decision:missing" })).status, 409);
  assert.equal((await post(body, {}, "/preview/main/api/bearings/thread")).status, 404);
  assert.equal((await fetch(`${base}/preview/main/api/bearings/thread?key=decision:alpha-call`)).status, 404);
  assert.equal(calls.length, 0);

  const accepted = await post(body);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).noteId, "note-3");
  assert.equal(calls[0].id, `quarterdeck-thread:decision:alpha-call:${uuid()}`);

  const history = await fetch(`${base}/api/bearings/thread?key=${encodeURIComponent("decision:alpha-call")}`);
  assert.equal(history.status, 200);
  assert.equal((await history.json()).task, "alpha-call");
  assert.equal((await fetch(`${base}/api/bearings/thread?key=nope`)).status, 400);

  moveHead("b".repeat(40));
  assert.ok([409, 503].includes((await post({ ...body, requestId: uuid(2) })).status), "a moved revision never relays");
  assert.equal(calls.length, 1);
});

test("thread history fails visibly when Firstmate receipts are unavailable", async (context) => {
  const relay = createThreadRelay({ home: "/synthetic/home", transcript: noTranscript, receipts: async () => { throw new Error("offline"); } });
  const { base } = await threadServer(context, { relay });
  const response = await fetch(`${base}/api/bearings/thread?key=decision:alpha-call`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "unavailable");
});


test("Pi primary transcript joins only Firstmate text naming the whole card task", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "fm-thread-pi-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "session.jsonl");
  const line = (role, content) => JSON.stringify({ type: "message", timestamp: "2026-01-02T08:01:00Z", message: { role, content } });
  await writeFile(file, [
    line("user", "captain mentions alpha-call"),
    line("assistant", [{ type: "thinking", thinking: "alpha-call private reasoning" }, { type: "text", text: "Firstmate explains alpha-call: " + "context ".repeat(600) }]),
    line("assistant", "Unrelated alpha-callback"),
    line("toolResult", "Tool mentions alpha-call"),
  ].join("\n") + "\n");
  const transcript = createTranscriptTurns({ home: "/synthetic/home", discover: async () => ({ sources: [{ file, origin: "pi", source: "primary" }] }) });
  const relay = createThreadRelay({ home: "/synthetic/home", receipts: empty, transcript });
  const result = await relay.history(decision.key, model());
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, "chat");
  assert.equal(result.entries[0].at, "2026-01-02T08:01:00.000Z");
  assert.ok(result.entries[0].text.length > 4000, "More can reveal long context instead of the old 4000-character cut");
});
