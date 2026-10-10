import assert from "node:assert/strict";
import test from "node:test";
import { inboxReviewState, noteWithRequestId } from "../inbox.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("an inbox that closes stdin early refuses delivery without terminating the server process", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-inbox-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "bin"));
  await writeFile(path.join(home, "bin/fm-inbox.sh"), "#!/bin/sh\nexec 0<&-\nexit 1\n", { mode: 0o755 });
  await assert.rejects(noteWithRequestId(home, "quarterdeck-call:synthetic", "x".repeat(2 * 1024 * 1024)), (error) => error.code === "EPIPE" || error.message === "Firstmate note not saved");
});

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
