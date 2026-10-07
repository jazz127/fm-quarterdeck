import assert from "node:assert/strict";
import test from "node:test";
import { inboxReviewState } from "../inbox.js";

const receiptsWithReply = (reply) => ({
  pending: [],
  handled: [{ id: "note-1", request_id: "agentos-review:batch-1", acknowledged: true }],
  replies: [{ id: "reply-1", in_reply_to: "note-1", ...reply }],
});

test("inbox review state reads reply body and falls back to text", () => {
  assert.deepEqual(inboxReviewState(receiptsWithReply({ body: "Recorded reply" }), "batch-1"), {
    state: "replied",
    reply: "Recorded reply",
  });
  assert.deepEqual(inboxReviewState(receiptsWithReply({ body: 42, text: "Legacy reply" }), "batch-1"), {
    state: "replied",
    reply: "Legacy reply",
  });
  assert.deepEqual(inboxReviewState(receiptsWithReply({ body: 42, text: null }), "batch-1"), {
    state: "replied",
    reply: null,
  });
});
