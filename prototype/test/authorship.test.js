import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ANSWER_ENVELOPE, THREAD_ENVELOPE, quarterdeckSendMatches } from "../authorship.js";
import { ANSWER_SCHEMA, answerEnvelope, answerRequestId, formatAnswerNote } from "../bearings-answer.js";
import { THREAD_NOTE_TAG, THREAD_SCHEMA, formatThreadNote, threadRequestId } from "../bearings-thread.js";
import { noteWithRequestId } from "../inbox.js";
import { formatReviewNote } from "../review-note.js";
import { deliverLocalReview, reconcileLocalReview, reviewVersion } from "../review.js";
import { createServer } from "../server.js";

// Synthetic home, ids and text only. The fake CLI writes notes the way stock
// `fm-inbox.sh note [--request-id]` does: state/inbox/<id>.note with id/at/source/
// request_id headers, and the idempotent reservation state/inbox/.requests/<request-id>.
const FAKE_INBOX = `#!/bin/sh
set -e
inbox="$FM_HOME/state/inbox"
case "$1" in
 ready) cat >/dev/null; echo '{"schema":"fm-primary-ready.v1","can_receive":true}' ;;
 announce) cat >/dev/null; echo '{"announced":true}' ;;
 receipts) cat >/dev/null; echo '{"schema":"fm-inbox-receipts.v1","pending":[],"handled":[],"replies":[],"omitted":[]}' ;;
 note)
  shift; request=""; [ "$1" = "--request-id" ] && { request=$2; shift 2; }
  body=$(cat); mkdir -p "$inbox/.requests"
  count=$(ls "$inbox" | grep -c '\\.note$' || true); id="179000000$count-Synth$count"
  if [ -n "$request" ] && [ -f "$inbox/.requests/$request" ]; then id=$(cat "$inbox/.requests/$request"); outcome=replay
  else
    [ -z "$request" ] || printf '%s\\n' "$id" > "$inbox/.requests/$request"
    { printf 'id=%s\\nat=2030-05-0%sT10:00:00Z\\nsource=text\\nannounce_marker=1\\n' "$id" "$((count + 1))"
      [ -z "$request" ] || printf 'request_id=%s\\n' "$request"
      printf -- '--\\n%s\\n' "$body"; } > "$inbox/$id.note"
    outcome=created
  fi
  echo '{"schema":"fm-inbox-note.v1","id":"'"$id"'","request_id":"'"$request"'","saved":true,"announced":true,"outcome":"'"$outcome"'"}' ;;
esac
`;

async function home(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-authorship-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "state", "inbox", "handled"), { recursive: true });
  await writeFile(path.join(root, "data", "projects.md"), "- Alpha - Synthetic authorship lane\n");
  await writeFile(path.join(root, "bin", "fm-inbox.sh"), FAKE_INBOX);
  await chmod(path.join(root, "bin", "fm-inbox.sh"), 0o700);
  return root;
}
async function serve(t, fmHome) {
  const receipts = await mkdtemp(path.join(os.tmpdir(), "qd-authorship-receipts-"));
  t.after(() => rm(receipts, { recursive: true, force: true }));
  const server = createServer({ FM_HOME: fmHome }, {
    localReviewDeliver: (body, statusPath) => deliverLocalReview(body, receipts, statusPath),
    localReviewReceipt: (body) => reconcileLocalReview(body, receipts),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const fleetLog = async (base) => {
  const data = await (await fetch(`${base}/api/lanes`)).json();
  return new Map(data.lanes.find((lane) => lane.id === "general").messages.map((message) => [message.source.split("/").pop(), message]));
};

const card = { key: "decision:alpha-task", type: "decision", task: "alpha-task", rev: "rev-1", answer: { question: "alpha-task", options: [{ value: "a", label: "Option A" }] } };
const answerId = "11111111-2222-4333-8444-555555555555";
const threadId = "66666666-7777-4888-9999-aaaaaaaaaaaa";
const batchId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const reviewBody = (batch) => formatReviewNote({ schema: "fm-agentos-review.v2", batchId: batch, version: "v", route: "#lanes", end: false, entries: [{ prompt: "Synthetic review", tag: "message", selector: "", text: "" }] });

test("the captain's genuine Quarterdeck sends appear as Captain in the fleet log", async (t) => {
  const fmHome = await home(t);
  const base = await serve(t, fmHome);
  // A review batch through the real POST /api/review → announceReview path.
  const sent = await fetch(`${base}/api/review`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({
    schema: "fm-agentos-review.v2", batchId, sessionId: "", version: reviewVersion, route: "#lanes", end: false,
    entries: [{ prompt: "Synthetic: my Quarterdeck message must show as mine", tag: "message", selector: "", text: "" }] }) });
  assert.equal(sent.status, 200);
  // Captain's Call answer and card-thread note through the relays' exact note calls.
  await noteWithRequestId(fmHome, answerRequestId(answerId), formatAnswerNote(answerEnvelope({ card, selection: "a", note: "synthetic answer" }, "rev-1")));
  await noteWithRequestId(fmHome, threadRequestId(card.key, threadId), formatThreadNote({ key: card.key, card, text: "Synthetic thread question", requestId: threadId }));
  // A retried send replays the same note instead of adding another.
  await noteWithRequestId(fmHome, answerRequestId(answerId), formatAnswerNote(answerEnvelope({ card, selection: "a", note: "synthetic answer" }, "rev-1")));

  const log = await fleetLog(base);
  const captain = [...log.values()].filter((message) => message.role === "captain");
  assert.equal(captain.length, 3);
  for (const message of captain) assert.deepEqual([message.author, message.role, message.state, message.kind], ["Captain", "captain", "captain", "conversation"]);
  assert.ok(captain.some((message) => message.review?.prompts[0].prompt === "Synthetic: my Quarterdeck message must show as mine"));
  assert.ok(captain.some((message) => message.text.startsWith("Captain's Call answer from Quarterdeck")));
  assert.ok(captain.some((message) => message.text.startsWith("Captain asks about Decision alpha-task from Quarterdeck: Synthetic thread question")));
  // Acknowledged (handled) notes stay the Captain's.
  const [name] = [...log.keys()].filter((key) => log.get(key).review);
  await writeFile(path.join(fmHome, "state", "inbox", "handled", name), await readFile(path.join(fmHome, "state", "inbox", name)));
  await rm(path.join(fmHome, "state", "inbox", name));
  assert.equal((await fleetLog(base)).get(name).role, "captain");
});

test("presence in the inbox is not authorship: unproven notes are unverified input", async (t) => {
  const fmHome = await home(t);
  const inbox = path.join(fmHome, "state", "inbox");
  const note = async (name, headers, body) => writeFile(path.join(inbox, name), `${headers.join("\n")}\n--\n${body}\n`);
  // Agent-written notes through the same CLI, with or without a request id.
  await noteWithRequestId(fmHome, "qm-2030-05-01-synthetic", "Quartermaster: synthetic advisory");
  await noteWithRequestId(fmHome, "captain-synthetic-scout", "Synthetic note claiming to be the captain");
  await note("relay-note.note", ["id=relay-note", "at=2030-05-01T09:00:00Z", "source=text"], "Memory warning from the user, relayed through another agent.");
  // Forgeries of a Quarterdeck send that fail one proof each.
  const forged = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await note("no-reservation.note", ["id=no-reservation", "at=2030-05-01T09:01:00Z", "source=text", `request_id=agentos-review:${forged}`], reviewBody(forged));
  const wrong = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await mkdir(path.join(inbox, ".requests"), { recursive: true });
  await writeFile(path.join(inbox, ".requests", `agentos-review:${wrong}`), "some-other-note\n");
  await note("wrong-reservation.note", ["id=wrong-reservation", "at=2030-05-01T09:02:00Z", "source=text", `request_id=agentos-review:${wrong}`], reviewBody(wrong));
  const mismatch = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await noteWithRequestId(fmHome, `agentos-review:${mismatch}`, reviewBody(forged));
  await noteWithRequestId(fmHome, threadRequestId(card.key, mismatch), formatThreadNote({ key: card.key, card, text: "Envelope names another request", requestId: threadId }));
  await noteWithRequestId(fmHome, answerRequestId(mismatch), "Captain's Call answer from Quarterdeck · Decision alpha-task: plain text without the envelope");
  await note("author.note", ["id=author", "at=2030-05-01T09:03:00Z", "source=text", "author=Captain"], "An author header proves nothing.");
  await note("legacy.msg", ["at=2030-05-01T09:04:00Z"], "A .msg in the captain inbox.");
  // A verified-looking note outside Firstmate's own inbox (legacy home inbox/) never verifies.
  await noteWithRequestId(fmHome, answerRequestId(answerId), formatAnswerNote(answerEnvelope({ card, selection: "a", note: "copied" }, "rev-1")));
  const realNote = (await readFile(path.join(inbox, ".requests", answerRequestId(answerId)), "utf8")).trim();
  await mkdir(path.join(fmHome, "inbox"));
  await writeFile(path.join(fmHome, "inbox", `${realNote}.note`), await readFile(path.join(inbox, `${realNote}.note`)));
  await rm(path.join(inbox, `${realNote}.note`));

  const base = await serve(t, fmHome);
  const log = await fleetLog(base);
  assert.equal(log.size, 11);
  for (const [name, message] of log) {
    assert.deepEqual([message.author, message.role, message.state, message.kind], ["Inbox note", "input", "input", "input"], name);
  }
  assert.ok([...log.values()].some((message) => message.text === "Memory warning from the user, relayed through another agent."), "text is kept");
});

test("the verified-send namespaces match the formats Quarterdeck writes", () => {
  assert.equal(ANSWER_ENVELOPE.schema, ANSWER_SCHEMA);
  assert.deepEqual([THREAD_ENVELOPE.tag, THREAD_ENVELOPE.schema], [THREAD_NOTE_TAG, THREAD_SCHEMA]);
  assert.equal(quarterdeckSendMatches(`agentos-review:${batchId}`, reviewBody(batchId)), true);
  assert.equal(quarterdeckSendMatches(`agentos-review:${batchId}`, `${reviewBody(batchId)}\ntrailing text`), false);
  assert.equal(quarterdeckSendMatches(answerRequestId(answerId), formatAnswerNote(answerEnvelope({ card, selection: "a", note: "" }, "rev-1"))), true);
  assert.equal(quarterdeckSendMatches(threadRequestId(card.key, threadId), formatThreadNote({ key: card.key, card, text: "q", requestId: threadId })), true);
  const longKey = `decision:${"x".repeat(150)}`;
  assert.equal(quarterdeckSendMatches(threadRequestId(longKey, threadId), formatThreadNote({ key: longKey, card: { ...card, key: longKey, task: "x".repeat(150) }, text: "q", requestId: threadId })), true);
  for (const id of ["models", "quarterdeck-call:not-a-uuid", "agentos-review:../../etc", `quarterdeck-thread:a/b:${threadId}`, "", null]) {
    assert.equal(quarterdeckSendMatches(id, reviewBody(batchId)), false, String(id));
  }
});
