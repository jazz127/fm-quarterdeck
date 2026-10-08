import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatReviewNote, parseReviewNote } from "../review-note.js";
import { validateReviewPayload, deliverLocalReview, reconcileLocalReview, awaitingReviewCount, reviewStatusLine } from "../review.js";
import { loadFirstmateHome } from "../server.js";

const batchId = "123e4567-e89b-12d3-a456-426614174000";
const version = "a".repeat(40);
const entry = { prompt: "Clarify this\n```code```", tag: "p", selector: ".message-content > p", text: "PRIVATE EXCERPT", record: { recordId: "main-pi-session/demo.jsonl:1:0" } };
const payload = { schema: "fm-agentos-review.v2", batchId, sessionId: "", version, route: "#lanes/demo", end: false, entries: [entry, { prompt: "Otherwise fine", tag: "message", selector: "", text: "" }] };
const temp = async (t) => { const dir = await mkdtemp(path.join(os.tmpdir(), "review-format-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test("v2 format round-trips newlines and fences in prompts without duplicating provenance", () => {
  const note = formatReviewNote({ ...payload, provenance: { preview: "uat", branch: "uat", remoteCheckpoint: "", commit: version } });
  assert.match(note, /^Quarterdeck review: 2 notes on #lanes\/demo\n\n1\. Clarify/);
  assert.equal(note.match(/```json fm-review/g).length, 1);
  assert.deepEqual(parseReviewNote(note).prompts, payload.entries);
  assert.equal(parseReviewNote(note).preview, "uat");
  assert.equal(note.split(version).length, 2);
  for (const bad of ["garbage", note.slice(0, -4), note.replace('"prompt":', '"extra":'), note.replace('"tag":"p"', '"tag":"text"')]) assert.equal(parseReviewNote(bad), null);
});

test("both legacy headers parse, with whole quotes bounded in the browser projection", () => {
  for (const product of ["Quarterdeck", "Agent OS"]) {
    const quote = JSON.stringify({ time: "12:00", lanes: ["demo"], text: "x".repeat(120000) });
    const body = `${product} review annotation batch ${batchId}\nVersion: ${version}\nRoute: #lanes/demo\nEnd: false\nPreview: standalone\nEntries:\n1. lane-message-annotation · #lanes/demo · Lane Chat message quote ${quote}\nClarify this.\n\n2. annotation · #lanes/demo · Card (card/span:0)\nFix the value.\n\n3. message · #lanes/demo · message\nFine.`;
    const review = parseReviewNote(body);
    assert.equal(review.prompts.length, 3);
    assert.equal(review.prompts[0].record.quoteExcerpt.length, 240);
    assert.equal(review.prompts[0].record.quoteTime, "12:00");
    assert.equal(review.prompts[1].label, "Card");
    assert.equal(review.prompts[2].tag, "message");
  }
});

test("v2 strict validation, selected text targets and bounded fingerprint records", () => {
  const valid = (candidate) => validateReviewPayload(candidate, version, "");
  assert.equal(valid(payload), true);
  for (const recordId of ['state/main-session/demo.jsonl@0:0', 'claude-main-session/demo.jsonl@124:0:block:1', 'main-pi-session/demo.jsonl:1:0', 'state/terminal-outcomes.jsonl:1']) {
    assert.equal(valid({ ...payload, entries: [{ ...entry, record: {recordId} }] }), true, recordId);
    const legacy = { ...payload, schema: 'fm-agentos-review.v1', entries: [{kind:'lane-message-annotation',text:'Fix',route:payload.route,version,region:null,target:{type:'record',recordId}}] };
    assert.equal(valid(legacy), true, `v1 ${recordId}`);
  }
  for (const recordId of ['state/main-session/demo.jsonl@0', 'state/../demo.jsonl@0:0', 'state/terminal-outcomes.jsonl@0:0', 'state/main-session/demo.jsonl@-1:0']) assert.equal(valid({...payload,entries:[{...entry,record:{recordId}}]}), false);
  const boundary = { selector: ".message-content > p", path: [0], offset: 22 };
  const text = { ...entry, tag: "text", target: { type: "text-range", text: "CI is green", selector: entry.selector, commonAncestorSelector: entry.selector, start: boundary, end: { ...boundary, offset: 33 }, prefix: "Merged the build fix; ", suffix: " on main." } };
  const noId = { ...entry, record: { source: "state/demo.status", at: "2026-01-01T00:00:00Z", lanes: ["demo"], sha256: "414bce7b19745178" } };
  assert.equal(valid({ ...payload, entries: [text, noId] }), true);
  for (const broken of [{ ...entry, extra: 1 }, { ...entry, selector: "x".repeat(513) }, { ...entry, record: { ...noId.record, recordId: entry.record.recordId } }, { ...noId, record: { ...noId.record, sha256: "invalid" } }, { ...text, target: { ...text.target, type: "unknown" } }, { ...entry, tag: "text" }, { ...text, target: { ...text.target, prefix: "x".repeat(33) } }]) assert.equal(valid({ ...payload, entries: [broken] }), false);
  assert.doesNotMatch(reviewStatusLine(payload), /PRIVATE EXCERPT/);
  assert.doesNotMatch(reviewStatusLine({ ...payload, entries: [text] }), /CI is green/);
});

test("mixed v1/v2 receipts retain same-ID reconciliation and annotation counts", async (t) => {
  const dir = await temp(t);
  const legacy = { ...payload, schema: "fm-agentos-review.v1", batchId: "00000000-0000-4000-8000-000000000001", entries: [{ kind: "annotation", text: "Fix", route: payload.route, version, region: { id: "card", label: "Card" } }] };
  for (const wire of [legacy, payload]) {
    await deliverLocalReview(wire, dir);
    assert.deepEqual((await reconcileLocalReview(wire, dir)).payload, wire);
    await deliverLocalReview(wire, dir);
  }
  assert.equal(await awaitingReviewCount(dir), 2);
});

test("review projection requires the request-id header; malformed blocks preserve raw body", async (t) => {
  const home = await temp(t);
  await mkdir(path.join(home, "data")); await mkdir(path.join(home, "inbox")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data", "projects.md"), "- Demo - Synthetic review fixture.\n");
  const body = formatReviewNote(payload);
  for (const [name, id, text] of [["review", `request_id=agentos-review:${batchId}\n`, body], ["ordinary", "", body], ["bad", `request_id=agentos-review:${batchId}\n`, "Quarterdeck review: truncated"]]) await writeFile(path.join(home, "inbox", `${name}.note`), `${id}at=2026-01-01T00:00:00Z\n--\n${text}`);
  const data = await loadFirstmateHome(home);
  const notes = data.lanes.flatMap((lane) => lane.messages);
  assert.ok(notes.find((note) => note.source === "inbox/review.note")?.review);
  assert.equal(notes.find((note) => note.source === "inbox/ordinary.note")?.review, undefined);
  assert.equal(notes.find((note) => note.source === "inbox/bad.note")?.review, null);
  assert.equal(notes.find((note) => note.source === "inbox/review.note")?.text, body);
});
