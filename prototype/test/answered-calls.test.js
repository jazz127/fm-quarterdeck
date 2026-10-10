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
