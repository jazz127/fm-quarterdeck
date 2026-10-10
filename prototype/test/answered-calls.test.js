import test from "node:test";
import assert from "node:assert/strict";
import { classifyAnsweredCalls } from "../answered-calls.js";

const card = { key: "decision:sample", type: "decision", rev: "abc", answer: { question: "sample" } };
const note = (extra = {}) => ({ request_id: "quarterdeck-call:sample", body: '\n```json fm-bearings-answer\n' + JSON.stringify({ schema: "fm-bearings-answer.v1", channel: "quarterdeck", type: "decision", question: "sample", cardRev: "abc", ...extra }) + '\n```' });
test("only a durable sent answer hides an open call; intake and reply do not close it", () => {
  for (const collection of ["pending", "handled"]) {
    const receipts = { [collection]: [note()], replies: [{ body: "confirmed" }] };
    assert.equal(classifyAnsweredCalls([card], receipts)[0].answered, true);
    assert.deepEqual(classifyAnsweredCalls([], receipts), [], "closed calls never return from receipts");
  }
  assert.equal(classifyAnsweredCalls([card], null)[0].answered, undefined);
});
test("other cards, non-Quarterdeck notes and malformed records stay active", () => {
  for (const entry of [note({ question: "other" }), note({ type: "merge" }), note({ channel: "board" }), note({ schema: "unknown" }), { ...note(), request_id: "quarterdeck-thread:sample" }, { ...note(), body: "bad" }]) {
    assert.equal(classifyAnsweredCalls([card], { pending: [entry] })[0].answered, undefined);
  }
  assert.equal(classifyAnsweredCalls([card], { pending: [note({ cardRev: "old" })] })[0].answered, true, "a presentation change is not confirmation");
  assert.equal(card.answered, undefined, "classification never mutates source");
});

const taskCard = { ...card, task: "sample" };
const answerNote = (where, extra = {}) => ({ id: "answer-1", at: "2026-01-02T10:00:00.000Z", request_id: "quarterdeck-call:sample", body: "\n```json fm-bearings-answer\n" + JSON.stringify({ schema: "fm-bearings-answer.v1", channel: "quarterdeck", type: "decision", task: "sample", question: "sample", selection: "later", note: "Defer. I will want to test this first", ...extra }) + "\n```" });
const threadNote = (id, at) => ({ id, at, request_id: `quarterdeck-thread:decision:sample:${id}`, body: "\n```json fm-quarterdeck-thread\n" + JSON.stringify({ schema: "fm-quarterdeck-card-thread.v1", key: "decision:sample", question: "Defer. I will want to test this first" }) + "\n```" });

test("the latest inbox note is pending, acknowledged, or replied without closing the card", () => {
  assert.equal(classifyAnsweredCalls([taskCard], { pending: [answerNote()], handled: [], replies: [] })[0].sentReceipt, "pending");
  assert.equal(classifyAnsweredCalls([taskCard], { pending: [], handled: [answerNote()], replies: [] })[0].sentReceipt, "acknowledged");
  const replied = classifyAnsweredCalls([taskCard], { pending: [], handled: [answerNote()], replies: [{ id: "answer-1", body: "Noted. It stays open for you." }] })[0];
  assert.equal(replied.answered, true);
  assert.equal(replied.sentReceipt, "replied");
  assert.equal(replied.sentReply, "Noted. It stays open for you.");
  const newer = classifyAnsweredCalls([taskCard], {
    pending: [threadNote("thread-2", "2026-01-02T12:00:00.000Z")],
    handled: [answerNote()],
    replies: [{ id: "answer-1", body: "Noted. It stays open for you." }],
  })[0];
  assert.equal(newer.sentReceipt, "pending", "a later unread note wins over an older reply");
  assert.equal(classifyAnsweredCalls([], { pending: [answerNote()], replies: [{ id: "answer-1", body: "gone" }] }).length, 0, "a closed call is not returned");
});

test("receipt deduplication retains batch siblings while handled wins for a duplicate item", () => {
  const other = { ...taskCard, key: "decision:other", task: "other", answer: { question: "other" } };
  const first = answerNote();
  const second = { ...answerNote(null, { task: "other", question: "other" }), request_id: "quarterdeck-call:other" };
  const cards = classifyAnsweredCalls([taskCard, other], { handled: [first], pending: [first, second], replies: [] });
  assert.equal(cards[0].answered, true);
  assert.equal(cards[0].sentReceipt, "acknowledged");
  assert.equal(cards[1].answered, true);
  assert.equal(cards[1].sentReceipt, "pending");
});
