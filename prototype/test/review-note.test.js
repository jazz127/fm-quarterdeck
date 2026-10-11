import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { formatReviewNote, parseReviewNote } from "../review-note.js";
import { validateReviewPayload, deliverLocalReview, reconcileLocalReview, awaitingReviewCount, reviewStatusLine } from "../review.js";
import { createServer, loadFirstmateHome } from "../server.js";

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
  for (const recordId of ['state/main-session/demo.jsonl@0:0', 'claude-main-session/demo.jsonl@124:0:block:1', 'main-pi-session/demo.jsonl:1:0', 'state/branch-outcomes.jsonl:1', 'state/branch-outcomes.jsonl@0', 'state/branch-outcomes.jsonl@124', 'state/terminal-outcomes.jsonl:1', 'state/terminal-outcomes.jsonl@0', 'state/terminal-outcomes.jsonl@124']) {
    assert.equal(valid({ ...payload, entries: [{ ...entry, record: {recordId} }] }), true, recordId);
    const legacy = { ...payload, schema: 'fm-agentos-review.v1', entries: [{kind:'lane-message-annotation',text:'Fix',route:payload.route,version,region:null,target:{type:'record',recordId}}] };
    assert.equal(valid(legacy), true, `v1 ${recordId}`);
  }
  for (const recordId of ['state/main-session/demo.jsonl@0', 'state/../demo.jsonl@0:0', 'state/terminal-outcomes.jsonl@0:0', 'state/main-session/demo.jsonl@-1:0']) assert.equal(valid({...payload,entries:[{...entry,record:{recordId}}]}), false);
  for (const source of ['state/branch-outcomes.jsonl', 'state/terminal-outcomes.jsonl']) {
    for (const suffix of [':0', '@-1', '@01', '@1.5', ':1:0', ':1:block:0', '@0:0', '@0:block:0', '@0:0:block:0']) {
      const recordId = source + suffix;
      assert.equal(valid({ ...payload, entries: [{ ...entry, record: { recordId } }] }), false, recordId);
      assert.equal(valid({ ...payload, schema: 'fm-agentos-review.v1', entries: [{ kind: 'lane-message-annotation', text: 'Fix', route: payload.route, version, region: null, target: { type: 'record', recordId } }] }), false, `v1 ${recordId}`);
      assert.equal(parseReviewNote(formatReviewNote({ ...payload, entries: [{ ...entry, record: { recordId } }] })), null, `structured note ${recordId}`);
    }
  }
  const boundary = { selector: ".message-content > p", path: [0], offset: 22 };
  const text = { ...entry, tag: "text", target: { type: "text-range", text: "CI is green", selector: entry.selector, commonAncestorSelector: entry.selector, start: boundary, end: { ...boundary, offset: 33 }, prefix: "Merged the build fix; ", suffix: " on main." } };
  const noId = { ...entry, record: { source: "state/demo.status", at: "2026-01-01T00:00:00Z", lanes: ["demo"], sha256: "414bce7b19745178" } };
  assert.equal(valid({ ...payload, entries: [text, noId] }), true);
  for (const broken of [{ ...entry, extra: 1 }, { ...entry, selector: "x".repeat(513) }, { ...entry, record: { ...noId.record, recordId: entry.record.recordId } }, { ...noId, record: { ...noId.record, sha256: "invalid" } }, { ...text, target: { ...text.target, type: "unknown" } }, { ...entry, tag: "text" }, { ...text, target: { ...text.target, prefix: "x".repeat(33) } }]) assert.equal(valid({ ...payload, entries: [broken] }), false);
  assert.doesNotMatch(reviewStatusLine(payload), /PRIVATE EXCERPT/);
  assert.doesNotMatch(reviewStatusLine({ ...payload, entries: [text] }), /CI is green/);
});

test("emitted outcome IDs and legacy anchors round-trip through review API receipts and notes", async (t) => {
  const root = await temp(t);
  const home = path.join(root, "home"), receipts = path.join(root, "receipts");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Demo - Synthetic outcomes.\n");
  const sources = ["state/branch-outcomes.jsonl", "state/terminal-outcomes.jsonl"];
  for (const source of sources) await writeFile(path.join(home, source), '{"epoch":1700000000,"summary":"é old"}\r\n{"epoch":1700000001,"summary":"newest"}\r\n');
  const notes = (await loadFirstmateHome(home)).lanes.flatMap(lane => lane.messages).filter(message => message.kind === "supervision");
  assert.deepEqual(notes.map(note => note.recordId).sort(), sources.flatMap(source => [`${source}@0`, `${source}@41`]).sort());
  const server = createServer({}, {
    revisionResolver: { initial: version, snapshot: async () => version },
    localReviewDeliver: body => deliverLocalReview(body, receipts),
    localReviewReceipt: body => reconcileLocalReview(body, receipts),
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const recordIds = [...notes.map(note => note.recordId), ...sources.flatMap(source => [`${source}:1`, `${source}:2`])];
  for (const recordId of recordIds) {
    for (const schema of ["fm-agentos-review.v1", "fm-agentos-review.v2"]) {
      const wire = { ...payload, schema, batchId: randomUUID(), entries: schema === "fm-agentos-review.v2"
        ? [{ ...entry, record: { recordId } }]
        : [{ kind: "lane-message-annotation", text: "Clarify this", route: payload.route, version, region: null, target: { type: "record", recordId } }] };
      const response = await fetch(`${base}/api/review`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(wire) });
      assert.equal(response.status, 200, `${schema} ${recordId}`);
      assert.deepEqual(await response.json(), { receiptId: `local:${wire.batchId}`, delivery: "local" });
      const saved = JSON.parse(await readFile(path.join(receipts, `${wire.batchId}.json`), "utf8")).payload;
      assert.deepEqual(saved.entries, wire.entries, "the durable receipt preserves the outcome anchor");
      assert.deepEqual((await reconcileLocalReview(wire, receipts)).payload, saved);
      if (schema === "fm-agentos-review.v2") assert.deepEqual(parseReviewNote(formatReviewNote(saved)).prompts, wire.entries, "structured inbox notes retain the accepted outcome anchor");
    }
  }
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
