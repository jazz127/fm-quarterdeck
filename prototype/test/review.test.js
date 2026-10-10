import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, readdir, rm, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";
import { createServer } from "../server.js";
import { deliverReview, deliverLocalReview, reconcileLocalReview, reviewStatusLine, reviewVersion, awaitingReviewCount, localReviewStatus } from "../review.js";

const reviewClientScript = await readFile(new URL("../public/review-target.js", import.meta.url), "utf8") + "\n" + await readFile(new URL("../public/review-client.js", import.meta.url), "utf8");
const entry = { kind: "annotation", text: "Improve this card", route: "#overview", version: reviewVersion, region: { id: "project:abc/header:0", label: "Project" } };
const payload = { schema: "fm-agentos-review.v1", batchId: "123e4567-e89b-12d3-a456-426614174000", sessionId: "review-1", version: reviewVersion, route: "#overview", end: false, entries: [entry, { kind: "message", text: "And the menu", region: null, route: "#preferences", version: reviewVersion }] };
const wirePayload = ({ provenance, ...wire }) => wire;
async function fixture(t, options = {}) {
  const delivered = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-review-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer({ FM_LAVISH_REVIEW_URL: "http://127.0.0.1:49111/api/review", FM_LAVISH_REVIEW_SESSION: "review-1", ...options.env }, {
    reviewDeliver: async (body, endpoint) => { delivered.push({ body, endpoint: String(endpoint) }); if (options.fail) throw new Error("network error"); return { receiptId: "receipt-1" }; },
    localReviewDeliver: (body, statusPath) => options.localFail ? Promise.reject(new Error("disk error")) : deliverLocalReview(body, directory, statusPath),
    localReviewReceipt: (body) => reconcileLocalReview(body, directory),
    reviewCount: (receipts) => awaitingReviewCount(directory, receipts),
    reviewStatus: (batchId) => localReviewStatus(batchId, directory),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/review`, { method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, post, delivered, directory };
}

test("standalone rejects forged provenance and unknown fields at every payload level", async (t) => {
  const { post, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  const local = { ...payload, sessionId: "" };
  for (const forged of [
    { ...local, provenance: { commit: "forged" } }, { ...local, branch: "main" },
    { ...local, entries: [{ ...entry, provenance: { branch: "main" } }] },
    { ...local, entries: [{ ...entry, region: { ...entry.region, owner: "forged" } }] },
  ]) assert.equal((await post(forged)).status, 400);
  assert.equal((await post(local)).status, 200);
  const saved = JSON.parse(await readFile(path.join(directory, `${local.batchId}.json`), "utf8")).payload;
  assert.equal(saved.provenance.commit, reviewVersion);
  assert.equal(saved.provenance.branch, null, "unconfigured standalone does not claim a release branch");
});

test("lost local response reconciles original notes across revision changes without a second delivery", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "review-reconcile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = { ...payload, sessionId: "", version: "a".repeat(40), entries: payload.entries.map((entry) => ({ ...entry, version: "a".repeat(40) })) };
  const original = { ...old, provenance: { branch: "uat", commit: old.version, remoteCheckpoint: null, preview: "uat", receivedAt: "2026-01-01T00:00:00Z" } };
  await deliverLocalReview(original, directory);
  let delivered = 0;
  const newer = "b".repeat(40);
  const server = createServer({}, { revisionResolver: { initial: newer, snapshot: async () => newer },
    localReviewReceipt: (body) => reconcileLocalReview(body, directory),
    localReviewDeliver: async () => { delivered++; throw new Error("Retry must not deliver again"); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + "/api/review", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
  for (let i = 0; i < 2; i++) {
    const response = await post(old);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).receiptId, `local:${old.batchId}`);
  }
  assert.equal(delivered, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${old.batchId}.json`), "utf8")).payload, original);
  assert.equal((await post({ ...old, entries: [{ ...old.entries[0], text: "changed notes" }] })).status, 502);
  assert.equal((await post({ ...old, batchId: randomUUID() })).status, 400, "unaccepted old version is never delivered anew");
});

test("Work split review route accepts ordinary, Ctrl-send and end batches without widening route validation", async (t) => {
  const { post, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  for (const [route, end] of [["#overview", false], ["#work", false], ["#work", true]]) {
    const batchId = randomUUID();
    const body = { ...payload, sessionId: "", batchId, route, end, entries: [{ ...payload.entries[1], route }] };
    const response = await post(body);
    assert.equal(response.status, 200, `${route} ${end ? "Send & end" : "Send"}: ${await response.text()}`);
    assert.deepEqual(wirePayload(JSON.parse(await readFile(path.join(directory, `${batchId}.json`), "utf8")).payload), body);
  }
  for (const route of ["#work?unsafe=1", "#wrong", "#lanes/%23bad#fragment"]) {
    const response = await post({ ...payload, sessionId: "", batchId: randomUUID(), route, entries: [{ ...payload.entries[1], route }] });
    assert.equal(response.status, 400, `${route} must not be accepted`);
  }
});

test("local review writes a readable receipt without Lavish and retries idempotently", async (t) => {
  const { base, post, delivered, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_URL: "http://example.org/review" } });
  assert.deepEqual(await (await fetch(`${base}/api/review`)).json(), { ready: true, sessionId: "", version: reviewVersion, delivery: "local", intakeReady: false, awaitingReview: 0 });
  const local = { ...payload, sessionId: "", end: true };
  const response = await post(local);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { receiptId: `local:${local.batchId}`, delivery: "local" });
  assert.equal((await post(local)).status, 200);
  assert.equal((await post({ ...local, end: false })).status, 502);
  assert.equal(delivered.length, 0);
  assert.deepEqual(await readdir(directory), [`${local.batchId}.json`]);
  assert.deepEqual(wirePayload(JSON.parse(await readFile(path.join(directory, `${local.batchId}.json`), "utf8")).payload), local);
});

test("Fleet Chat message targets stay discriminated through receipt, retry and badge; malformed IDs and metadata are rejected", async (t) => {
  const { post, directory, base } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  const record = (recordId) => ({ kind: "lane-message-annotation", text: "Clarify this reply", route: "#lanes/alpha", version: reviewVersion,
    region: null, target: { type: "record", recordId } });
  const quoted = { kind: "lane-message-annotation", text: "Clarify this status", route: "#lanes/alpha", version: reviewVersion,
    region: null, target: { type: "quote", time: "Yesterday 12:30", text: "working: same update", lanes: ["Alpha", "General"] } };
  const local = { ...payload, sessionId: "", route: "#lanes/alpha", entries: [record("state/main-session/a.jsonl:1:0"), record("state/main-session/a.jsonl:2:0"), quoted, entry] };
  assert.equal((await post(local)).status, 200);
  assert.equal((await post(local)).status, 200);
  assert.deepEqual(wirePayload(JSON.parse(await readFile(path.join(directory, `${local.batchId}.json`), "utf8")).payload), local);
  assert.equal((await (await fetch(`${base}/api/review`)).json()).awaitingReview, 4);
  assert.equal((await post({ ...local, entries: [record("state/main-session/a.jsonl:3:0"), ...local.entries.slice(1)] })).status, 502);
  for (const target of ["", "../../credential?", "abc space", "a".repeat(1001)]) {
    assert.equal((await post({ ...local, batchId: randomUUID(), entries: [record(target)] })).status, 400);
  }
  for (const changed of [
    { ...record("x:1:0"), target: { type: "record", recordId: "x:1:0", sender: "Captain" } },
    { ...quoted, target: { ...quoted.target, recordId: "made-up" } },
    { ...quoted, target: { ...quoted.target, lanes: [] } },
    { ...record("x:1:0"), region: { id: "record:x", label: "message" } },
    { ...entry, target: { type: "record", recordId: "x:1:0" } },
  ]) assert.equal((await post({ ...local, batchId: randomUUID(), entries: [changed] })).status, 400);
  const status = reviewStatusLine({ ...local, entries: [{ ...quoted, target: { ...quoted.target, text: "password=private" } }] });
  assert.doesNotMatch(status, /password=private|working: same update/);
});

test("status follows a real local annotation receipt, not a send timer, notification, or reviewed ack", async (t) => {
  const { base, post, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  const local = { ...payload, sessionId: "", entries: [entry] };
  const url = `${base}/api/review/status?batchId=${local.batchId}`;
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(`${base}/api/review/status?batchId=../../secret`)).status, 400);
  assert.equal((await post(local)).status, 200);
  const read = async () => (await (await fetch(url)).json());
  assert.deepEqual(await read(), { receiptId: `local:${local.batchId}`, state: "accepted", intake: null });
  await writeFile(path.join(directory, `${local.batchId}.reviewed-ack.json`), JSON.stringify({ schema: "fm-agentos-reviewed-ack.v1", reviewed: [0] }));
  assert.equal((await read()).state, "accepted", "review acknowledgement does not claim completed handling");
  const file = path.join(directory, `${local.batchId}.status.json`);
  for (const state of ["received", "handling", "completed", "failed"]) {
    await writeFile(file, JSON.stringify({ schema: "fm-agentos-review-status.v1", receiptId: `local:${local.batchId}`, state, updatedAt: "2026-01-01T00:00:00Z" }));
    assert.equal((await read()).state, state);
  }
  await writeFile(file, JSON.stringify({ schema: "fm-agentos-review-status.v1", receiptId: "local:wrong", state: "completed", updatedAt: "2026-01-01T00:00:00Z" }));
  assert.notEqual((await fetch(url)).status, 200, "mismatched status must not be presented");
});

test("badge counts receipt-backed annotations only until supervisor confirms receipt, not reviewed acknowledgements or messages", async (t) => {
  const { base, post, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  const count = async () => (await (await fetch(`${base}/api/review`)).json()).awaitingReview;
  assert.equal(await count(), 0);
  const local = { ...payload, sessionId: "", entries: [payload.entries[1], ...Array(12).fill(entry)] };
  assert.equal((await post(local)).status, 200);
  assert.equal(await count(), 12);
  const ack = path.join(directory, `${local.batchId}.reviewed-ack.json`);
  await writeFile(ack, JSON.stringify({ schema: "fm-agentos-reviewed-ack.v1", reviewed: Array.from({ length: 11 }, (_, i) => i + 1) }));
  assert.equal(await count(), 12);
  const status = path.join(directory, `${local.batchId}.status.json`);
  await writeFile(status, JSON.stringify({ schema: "fm-agentos-review-status.v1", receiptId: `local:${local.batchId}`, state: "received", updatedAt: "2026-01-01T00:00:00Z" }));
  assert.equal(await count(), 0);
});

test("real receipt automatically enters the guarded inbox with a stable request ID and tracks acknowledgement", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-inbox-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "bin"));
  const script = path.join(home, "bin", "fm-inbox.sh");
  // The fake CLI must drain even empty stdin before exiting. Otherwise the
  // client's pipe can emit EPIPE when a fast ready/receipts response races end().
  await writeFile(script, `#!/bin/sh
case "$1" in
 ready) cat >/dev/null; echo '{"schema":"fm-primary-ready.v1","can_receive":true}' ;;
 note) cat > "${home}/body"; echo '{"schema":"fm-inbox-note.v1","id":"inbox-1","request_id":"'"$3"'","saved":true,"announced":true,"outcome":"created"}' ;;
 receipts) cat >/dev/null; if [ -e "${home}/handled" ]; then group=handled; else group=pending; fi; echo '{"schema":"fm-inbox-receipts.v1","pending":'"$(if [ "$group" = pending ]; then echo '[{"id":"inbox-1","request_id":"agentos-review:${payload.batchId}","announced":true}]'; else echo '[]'; fi)"',"handled":'"$(if [ "$group" = handled ]; then echo '[{"id":"inbox-1","request_id":"agentos-review:${payload.batchId}","acknowledged":true}]'; else echo '[]'; fi)"',"replies":[],"omitted":[]}' ;;
 announce) cat >/dev/null; echo '{"announced":true}' ;;
esac
`);
  await chmod(script, 0o700);
  const { base, post } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "", FM_HOME: home } });
  const local = { ...payload, sessionId: "", entries: [entry,
    { kind: "lane-message-annotation", text: "Address first turn", region: null, route: "#lanes/alpha", version: reviewVersion,
      target: { type: "record", recordId: "main-pi-session/a.jsonl:1:0" } },
    { kind: "lane-message-annotation", text: "Address no-ID status", region: null, route: "#lanes/alpha", version: reviewVersion,
      target: { type: "quote", time: "12:00", text: "working: repeated", lanes: ["Alpha"] } },
  ] };
  assert.equal((await post(local)).status, 200);
  const body = await readFile(path.join(home, "body"), "utf8");
  assert.match(body, /Improve this card.*$/m);
  assert.match(body, /project:abc\/header:0/);
  assert.match(body, /Lane Chat record main-pi-session\/a.jsonl:1:0/);
  assert.match(body, /Lane Chat message quote \{"time":"12:00","text":"working: repeated","lanes":\["Alpha"\]\}/);
  assert.equal((await (await fetch(`${base}/api/review/status?batchId=${local.batchId}`)).json()).state, "accepted");
  assert.equal((await (await fetch(`${base}/api/review`)).json()).awaitingReview, 3);
  await writeFile(path.join(home, "handled"), "yes");
  assert.equal((await (await fetch(`${base}/api/review/status?batchId=${local.batchId}`)).json()).state, "received");
  assert.equal((await (await fetch(`${base}/api/review`)).json()).awaitingReview, 0);
});

test("local send announces each note once after receipt; rejected sends stay silent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-review-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statusPath = path.join(directory, "supervisor.status");
  const { post, directory: receiptDir } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "", FM_REVIEW_STATUS_PATH: statusPath } });
  const local = { ...payload, sessionId: "", entries: [
    { ...entry, text: "Improve this card\nwith clearer spacing", region: { ...entry.region, label: "Project header" } },
    { ...payload.entries[1], text: "And the menu" },
  ] };
  assert.equal((await post({ ...local, version: "invalid" })).status, 400);
  await assert.rejects(readFile(statusPath, "utf8"), { code: "ENOENT" });
  assert.equal((await post(local)).status, 200);
  assert.deepEqual(wirePayload(JSON.parse(await readFile(path.join(receiptDir, `${local.batchId}.json`), "utf8")).payload), local);
  const line = await readFile(statusPath, "utf8");
  const note = JSON.parse(line.trim());
  assert.equal(note.batchId, local.batchId);
  assert.equal(note.route, "#overview");
  assert.deepEqual(note.notes, [
    { text: "Improve this card with clearer spacing", region: "Project header" },
    { text: "And the menu", region: "(message)" },
  ]);
  assert.equal(line.split("\n").length, 2);
  assert.equal((await post(local)).status, 200);
  assert.equal((await post({ ...local, end: true })).status, 502);
  assert.equal(await readFile(statusPath, "utf8"), line);
});

test("supervisor note stays bounded and does not include session or credential-like text", () => {
  const long = { ...entry, text: `password=not-for-status ${"x".repeat(4000)}`, region: { ...entry.region, label: "secret value" } };
  const line = reviewStatusLine({ ...payload, entries: Array(30).fill({ ...long, text: "\\".repeat(4000), region: { ...entry.region, label: "\\".repeat(300) } }) });
  assert.ok(line.length < 8192);
  const redacted = reviewStatusLine({ ...payload, entries: [long] });
  assert.doesNotMatch(redacted, /not-for-status|sessionId|review-1/);
  assert.match(redacted, /redacted: possible credential/);
});

test("failed local delivery does not confirm a receipt", async (t) => {
  const { post } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" }, localFail: true });
  assert.equal((await post({ ...payload, sessionId: "" })).status, 502);
});

test("review bridge forwards structured annotations/messages and end without changing route", async (t) => {
  const { base, post, delivered } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/api/review`)).json(), { ready: true, sessionId: "review-1", version: reviewVersion, delivery: "lavish", intakeReady: false, awaitingReview: null });
  const response = await post(payload);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { receiptId: "receipt-1" });
  assert.deepEqual(wirePayload(delivered[0].body), payload); assert.equal(delivered[0].body.provenance.commit, reviewVersion); assert.equal(delivered[0].endpoint, "http://127.0.0.1:49111/api/review");
  assert.equal((await post({ ...payload, end: true })).status, 200);
  assert.equal(delivered[1].body.end, true);
});

test("Serve review POST requires an explicitly configured exact HTTPS Host and Origin", async (t) => {
  const allowed = "https://device.example.test";
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-serve-status-"));
  t.after(() => rm(statusDir, { recursive: true, force: true }));
  const statusPath = path.join(statusDir, "review.status");
  const { base, directory } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "", FM_REVIEW_ALLOWED_ORIGIN: allowed, FM_REVIEW_STATUS_PATH: statusPath } });
  const local = { ...payload, sessionId: "" };
  // Node fetch replaces the Host header; use a raw HTTP client to model Serve's Host.
  const send = (host, origin, extra = {}) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/review`, { method: "POST", headers: { host, origin, "content-type": "application/json", ...extra } }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(local));
  });
  const denied = [
    ["device.example.test", "http://device.example.test"],
    ["device.example.test:443", allowed],
    ["device.example.test", `${allowed}:443`],
    ["device.example.test", `${allowed}/`],
    ["device.example.test", "https://user@device.example.test"],
    ["other.example.test", "https://other.example.test"],
    ["device.example.test.evil.test", "https://device.example.test.evil.test"],
    ["evil-device.example.test", "https://evil-device.example.test"],
    ["device.example.test", "https://other.example.test"],
    ["other.example.test", allowed],
    ["127.0.0.1", allowed],
  ];
  for (const [host, origin] of denied) assert.equal((await send(host, origin)).status, 403, `${host} / ${origin}`);
  assert.equal((await send("other.example.test", "https://other.example.test", {
    "x-forwarded-host": "device.example.test", "x-forwarded-proto": "https", forwarded: "host=device.example.test;proto=https",
  })).status, 403);
  await assert.rejects(readFile(statusPath, "utf8"), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await send("device.example.test", allowed)).status, 200);
  assert.equal((await send("device.example.test", allowed)).status, 200);
  assert.equal((await send(new URL(base).host, base)).status, 200, "localhost behavior is unchanged");
  assert.deepEqual(wirePayload(JSON.parse(await readFile(path.join(directory, `${local.batchId}.json`), "utf8")).payload), local);
  assert.equal((await readFile(statusPath, "utf8")).trim().split("\n").length, 1, "retry and localhost send do not duplicate status");
});

test("without an allowlist the Serve origin remains forbidden; malformed allowlist entries fail closed", async (t) => {
  const { base } = await fixture(t, { env: { FM_LAVISH_REVIEW_SESSION: "" } });
  assert.equal((await fetch(`${base}/api/review`, { method: "POST", headers: { host: "device.example.test", origin: "https://device.example.test", "content-type": "application/json" }, body: JSON.stringify({ ...payload, sessionId: "" }) })).status, 403);
  for (const origin of ["http://device.example.test", "https://*.ts.net", "https://device.example.test:443", "https://user@device.example.test", "https://device.example.test/", "https://device.example.test.evil.test/path"]) {
    assert.throws(() => createServer({ FM_REVIEW_ALLOWED_ORIGIN: origin }), /FM_REVIEW_ALLOWED_ORIGIN/, origin);
  }
});

test("review rejects cross-origin, stale version, malformed body, oversized body, and missing receipt", async (t) => {
  const { post, delivered } = await fixture(t, { fail: true });
  assert.equal((await post(payload, { origin: "http://attacker.test" })).status, 403);
  assert.equal((await post({ ...payload, version: "stale" })).status, 400);
  assert.equal((await post({ ...payload, entries: [{ ...entry, region: { id: "..\\secret", label: "Bad" } }] })).status, 400);
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("a".repeat(150001))).status, 413);
  assert.equal(delivered.length, 0);
  assert.equal((await post(payload)).status, 502);
  assert.equal(delivered.length, 1);
});

test("Lavish adapter only accepts receipt-confirmed delivery and never follows redirects", async () => {
  const calls = [];
  const endpoint = new URL("http://localhost:4321/review");
  await assert.rejects(() => deliverReview(payload, endpoint, async (_url, init) => {
    calls.push(init);
    return { ok: true, json: async () => ({ ok: true }) };
  }), /receipt/);
  assert.equal(calls[0].redirect, "error");
  assert.equal(JSON.parse(calls[0].body).batchId, payload.batchId);
});

test("local Send uses an unqueued draft and keeps a failed send available to retry", async () => {
  const script = reviewClientScript;
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", hidden: id === "review-annotation", disabled: false, style: {}, scrollHeight: 40, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  const context = {
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {} },
    location: { hash: "#overview" }, crypto: { randomUUID: () => payload.batchId },
    fetch: async (_url, options) => options?.method === "POST" ? (attempts.push(JSON.parse(options.body)), { ok: false, json: async () => ({ error: "disk error" }) }) : { ok: true, json: async () => ({ ready: true, delivery: "local", sessionId: "", version: reviewVersion }) },
  };
  const attempts = [];
  vm.createContext(context);
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext("config.ready", context), true);
  assert.equal(element("review-send").disabled, true);
  element("review-message").value = "Please improve this card";
  element("review-message").listeners.input();
  assert.equal(element("review-send").disabled, false);
  assert.equal(element("review-end").disabled, false);
  element("review-send").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].sessionId, "");
  assert.equal(attempts[0].entries[0].prompt, "Please improve this card");
  assert.equal(element("review-send").disabled, false, "Send can retry a failed batch without a fresh draft");
  assert.equal(element("review-end").disabled, false, "Send & end can drain a failed board");
  assert.match(element("review-state").textContent, /disk error/);
  element("review-end").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].batchId, attempts[0].batchId);
});

test("retained old-page annotation requires explicit target review while retries preserve the original identity", async () => {
  const script = reviewClientScript;
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let current = "old-revision";
  const posts = [];
  const nodes = new Map();
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: "", textContent: "", hidden: id === "review-panel", disabled: false, style: {}, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
      requestSubmit() { this.listeners.submit({ preventDefault() {} }); },
    });
    return nodes.get(id);
  }
  let uuid = 0;
  const context = vm.createContext({
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {} }, location: { hash: "#overview" }, crypto: { randomUUID: () => `00000000-0000-0000-0000-${String(++uuid).padStart(12, "0")}` }, sessionStorage: storage,
    fetch: async (_url, options) => {
      if (options?.method !== "POST") return { ok: true, json: async () => ({ ready: true, version: current, sessionId: "", delivery: "local" }) };
      const body = JSON.parse(options.body); posts.push(body);
      return body.version !== current || body.entries.some((entry) => entry.version !== current)
        ? { ok: false, status: 400, json: async () => ({ error: "Invalid review payload or version" }) }
        : { ok: true, status: 200, json: async () => ({ receiptId: "synthetic-receipt", delivery: "local" }) };
    },
  });
  vm.runInContext(script, context);
  await new Promise(setImmediate);
  element("review-message").value = "Synthetic non-private retained-page annotation";
  vm.runInContext('selected = { id: "project:sample", label: "Project", route: "#overview", version: config.version };', context);
  element("review-form").listeners.submit({ preventDefault() {} });
  current = "new-revision"; // Serve switches while the page remains open.
  element("review-send").listeners.click();
  await new Promise(setImmediate);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].version, "old-revision");
  assert.equal(posts[0].entries[0].tag, "element");
  assert.equal(element("review-count").textContent, "");
  assert.match(element("review-state").textContent, /Preview updated.*Unconfirmed deliveries retain their original IDs/);
  assert.equal(vm.runInContext("retryBatches[0].payload.version", context), "old-revision");
  assert.equal(vm.runInContext("retryBatches[0].id", context), posts[0].batchId, "uncertain identity is preserved");
  await vm.runInContext("submitBatch(retryBatches[0])", context);
  await new Promise(setImmediate);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].batchId, posts[0].batchId);
  assert.equal(posts[1].version, "old-revision");
  assert.match(element("review-state").textContent, /retain.*original IDs|same batch ID/);
  assert.equal(element("review-count").textContent, "");
});

test("queued local batch enables both Send actions while an empty queue stays disabled", async () => {
  const script = reviewClientScript;
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", hidden: id === "review-annotation", disabled: false, style: {}, scrollHeight: 40, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  const context = {
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {} },
    location: { hash: "#overview" }, crypto: { randomUUID: () => payload.batchId },
    fetch: async (_url, options) => options?.method === "POST"
      ? { ok: true, json: async () => ({ receiptId: `local:${payload.batchId}`, delivery: "local" }) }
      : { ok: true, json: async () => ({ ready: true, delivery: "local", sessionId: "", version: reviewVersion }) },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element("review-send").disabled, true);
  assert.equal(element("review-end").disabled, true);
  element("review-message").value = "Queued note";
  element("review-form").listeners.submit({ preventDefault() {} });
  assert.equal(element("review-message").value, "");
  assert.equal(vm.runInContext("queue.length", context), 1);
  assert.equal(element("review-send").disabled, false);
  assert.equal(element("review-end").disabled, false);
  element("review-send").listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext("queue.length", context), 0);
  assert.equal(element("review-send").disabled, true);
  assert.equal(element("review-end").disabled, true);
});

async function composeBoard() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", hidden: id === "review-annotation", disabled: false, style: {}, scrollHeight: 40, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  const posts = [];
  let uuid = 0;
  const calls = [];
  const callSends = [];
  const context = vm.createContext({
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {}, quarterdeckCallQueue: { list: () => calls, send: async () => { callSends.push(calls.length); calls.length = 0; return true; }, remove() {} } },
    location: { hash: "#overview" }, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    fetch: async (_url, options) => {
      if (options?.method !== "POST") return { ok: true, json: async () => ({ ready: true, delivery: "local", sessionId: "", version: reviewVersion }) };
      posts.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ receiptId: "local:compose", delivery: "local" }) };
    },
  });
  vm.runInContext(reviewClientScript, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext("config.ready", context), true);
  const queue = (text) => {
    element("review-message").value = text;
    element("review-message").listeners.input();
    element("review-form").listeners.submit({ preventDefault() {} });
  };
  const send = () => element("review-send").listeners.click();
  return { element, posts, calls, callSends, queue, send, context };
}

test("Send batch includes compose text with queued notes, sends either alone, and does nothing when both are empty", async () => {
  const both = await composeBoard();
  both.queue("Queued note");
  assert.equal(both.element("review-message").value, "");
  both.element("review-message").value = "Typed note";
  both.element("review-message").listeners.input();
  await both.send();
  assert.deepEqual(both.posts[0].entries.map((entry) => entry.prompt), ["Queued note", "Typed note"], "queued notes and typed text go together");
  assert.equal(both.element("review-message").value, "", "the compose box clears after Send batch");

  const typed = await composeBoard();
  typed.element("review-message").value = "Only typed";
  typed.element("review-message").listeners.input();
  await typed.send();
  assert.deepEqual(typed.posts[0].entries.map((entry) => entry.prompt), ["Only typed"], "typed text alone is sent");
  assert.equal(typed.element("review-message").value, "");

  const queued = await composeBoard();
  queued.queue("Only queued");
  await queued.send();
  assert.deepEqual(queued.posts[0].entries.map((entry) => entry.prompt), ["Only queued"], "a queued note is unchanged when the box is empty");
  assert.equal(queued.posts.length, 1);

  const empty = await composeBoard();
  assert.equal(empty.element("review-send").disabled, true);
  await empty.send();
  empty.element("review-message").value = "   ";
  empty.element("review-message").listeners.input();
  await empty.send();
  assert.deepEqual(empty.posts, [], "an empty compose box and an empty queue do not send");
  assert.equal(empty.element("review-message").value, "   ");
});

test("Send batch does not send compose text again when that text was already queued", async () => {
  const stale = await composeBoard();
  stale.queue("Same note");
  stale.element("review-message").value = "Same note";
  await stale.send();
  assert.deepEqual(stale.posts[0].entries.map((entry) => entry.prompt), ["Same note"], "a draft Queue already took is not added twice");
  assert.equal(stale.element("review-message").value, "");

  const retyped = await composeBoard();
  retyped.queue("Same note");
  retyped.element("review-message").value = "Same note";
  retyped.element("review-message").listeners.input();
  await retyped.send();
  assert.deepEqual(retyped.posts[0].entries.map((entry) => entry.prompt), ["Same note", "Same note"], "typing the same words again is a new note");

  const shortcut = await composeBoard();
  shortcut.queue("Queued note");
  shortcut.element("review-message").value = "Typed note";
  shortcut.element("review-message").listeners.input();
  shortcut.element("review-message").listeners.keydown({ key: "Enter", ctrlKey: true, isComposing: false, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shortcut.posts[0].entries.map((entry) => entry.prompt), ["Queued note", "Typed note"], "Ctrl+Enter sends the draft once");

  const card = await composeBoard();
  card.calls.push({ key: "decision:alpha-call", label: "Decision alpha-call", text: "Tuesday", phase: "confirm" });
  card.element("review-message").value = "With the card";
  card.element("review-message").listeners.input();
  card.element("review-count").textContent = "";
  card.context.window.quarterdeckReviewQueue.refresh();
  await card.send();
  assert.deepEqual(card.callSends, [1], "a queued card answer still uses its own sender");
  assert.deepEqual(card.posts[0].entries.map((entry) => entry.prompt), ["With the card"]);

  const full = await composeBoard();
  for (let index = 0; index < 30; index += 1) full.queue(`Note ${index}`);
  full.element("review-message").value = "Stays in the box";
  full.element("review-message").listeners.input();
  await full.send();
  assert.equal(full.posts.length, 1);
  assert.equal(full.posts[0].entries.length, 30, "a full board still sends");
  assert.equal(full.element("review-message").value, "Stays in the box", "a draft past the board cap stays in the box");
});

test("queued Captain's Call answers count in the review queue and Send batch sends them through their own route first", async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", hidden: id === "review-annotation", disabled: false, style: {}, scrollHeight: 40, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  let calls = [
    { key: "decision:alpha-call", label: "Decision alpha-call", text: "Tuesday", phase: "confirm" },
    { key: "merge:beta-merge", label: "Merge beta-merge", text: "merge", phase: "confirm" },
  ];
  const sends = [];
  const posts = [];
  const context = {
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {}, quarterdeckCallQueue: { list: () => calls, send: async () => { sends.push(calls.length); calls = []; return true; }, remove() {} } },
    location: { hash: "#overview" }, crypto: { randomUUID: () => "batch-1" },
    fetch: async (url, options) => { if (options?.method === "POST") posts.push(url); return options?.method === "POST"
      ? { ok: true, json: async () => ({ receiptId: "local:batch-1", delivery: "local" }) }
      : { ok: true, json: async () => ({ ready: true, delivery: "local", sessionId: "", version: reviewVersion }) }; },
  };
  vm.createContext(context);
  vm.runInContext(reviewClientScript, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof context.window.quarterdeckReviewQueue.refresh, "function");
  assert.equal(element("review-count").textContent, "· 2 queued", "every queued answer counts with the notes");
  assert.equal(element("review-send").disabled, false, "queued answers alone enable Send batch");
  element("review-send").listeners.click();
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends, [2], "Send batch sends every queued card answer");
  assert.deepEqual(posts, [], "answers never travel as review annotations");
  assert.match(element("review-state").textContent, /^Sent 2 Captain's Call answers;/);
  assert.equal(element("review-count").textContent, "");
  assert.equal(element("review-send").disabled, true);
  assert.equal(typeof context.window.quarterdeckReviewQueue.sendCallAnswers, "function");
  assert.equal(context.window.quarterdeckReviewQueue.sending(), false);
});

test("Send queued and Send batch share one sender, and a second call does not send again", async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, value: "", textContent: "", hidden: id === "review-annotation", disabled: false, style: {}, scrollHeight: 40, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() {}, append() {},
    });
    return elements.get(id);
  }
  let calls = [{ key: "decision:alpha-call", label: "Decision alpha-call", text: "Tuesday", phase: "confirm" }];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sends = [];
  const refreshes = [];
  const context = {
    document: { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
    window: { addEventListener() {}, quarterdeckCallQueue: {
      list: () => calls,
      send: async () => { sends.push(calls.length); await gate; calls = []; return true; },
      remove() {},
      refresh: () => refreshes.push("refresh"),
    } },
    location: { hash: "#overview" }, crypto: { randomUUID: () => "batch-1" },
    fetch: async (_url, options) => options?.method === "POST"
      ? { ok: true, json: async () => ({ receiptId: "local:batch-1", delivery: "local" }) }
      : { ok: true, json: async () => ({ ready: true, delivery: "local", sessionId: "", version: reviewVersion }) },
  };
  vm.createContext(context);
  vm.runInContext(reviewClientScript, context);
  await new Promise((resolve) => setImmediate(resolve));
  const sender = context.window.quarterdeckReviewQueue.sendCallAnswers;
  assert.equal(typeof sender, "function");
  const first = sender();
  const second = sender();
  element("review-send").listeners.click();
  assert.equal(context.window.quarterdeckReviewQueue.sending(), true);
  assert.equal(await second, false, "an in-flight send does not start another");
  release();
  assert.equal(await first, true);
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sends, [1], "Send batch and Send queued share one in-flight sender");
  assert.deepEqual(refreshes, ["refresh"]);
  assert.equal(context.window.quarterdeckReviewQueue.sending(), false);
  assert.match(element("review-state").textContent, /^Sent 1 Captain's Call answer;/);
});

test("native review stays available with panel hidden and click precedence toggle", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const script = reviewClientScript;
  assert.match(html, /id="review-panel"[^>]+hidden/);
  assert.match(html, /id="review-toggle"[^>]+type="checkbox" aria-label="Annotation mode off/);
  assert.match(script, /let annotateByDefault = false;/);
  assert.match(html, /id="review-panel-toggle"[^>]+aria-controls="review-panel"/);
  assert.doesNotMatch(html, /id="review-panel-toggle"[^>]+hidden/);
  assert.match(html, /id="review-send"/);
  assert.match(html, /id="review-end"/);
  assert.match(script, /annotateByDefault === event\.altKey/);
  assert.match(script, /event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);\s*if \(!regionFor\(event\.target\)\) return;\s*selectRegion/);
  assert.doesNotMatch(script, /active = false/);
  assert.match(script, /entry\.region/);
  assert.match(html, /Enter: queue · Shift\+Enter: new line · Ctrl\/Cmd\+Enter: send/);
  assert.match(html, /Queue message \(Enter\)/);
  assert.match(html, /data-hint="Ctrl\/Cmd\+Enter">Send batch/);
});

// Minimal DOM with real ancestry and event listeners: catches a control being
// silently relabeled as the broad sidebar's "Conversation lanes" region.
test("annotation addresses the clicked control, never its enclosing sidebar", async () => {
  const script = reviewClientScript;
  const nodes = new Map();
  function node(tag, id = "", text = "", parent = null) {
    const listeners = new Map();
    const attrs = new Map();
    const n = { tagName: tag.toUpperCase(), id, textContent: text, parentElement: parent, children: [], dataset: {}, style: {}, hidden: false, isConnected: true, value: "",
      getAttribute: (key) => attrs.get(key) || null, setAttribute: (key, value) => attrs.set(key, value),
      matches: (selector) => selector.split(", ").includes(tag),
      closest(selector) { for (let p = this; p; p = p.parentElement) if (selector.split(", ").some((part) => part === `.${p.className}` || part === "[id]" && p.id || part === "[data-review-id]" && p.dataset.reviewId || part === "[aria-label]" && p.getAttribute("aria-label") || part === p.tagName.toLowerCase())) return p; return null; },
      contains(other) { for (let p = other; p; p = p.parentElement) if (p === this) return true; return false; },
      addEventListener(type, fn) { listeners.set(type, fn); }, dispatch(type, event) { listeners.get(type)?.(event); },
      focus() { this.focused = true; }, replaceChildren() {}, append() {}, requestSubmit() { this.dispatch("submit", { preventDefault() {} }); }, getBoundingClientRect: () => ({ left: 1, top: 2, width: 20, height: 10 }),
    };
    if (parent) parent.children.push(n);
    if (id) nodes.set(id, n);
    return n;
  }
  const sidebar = node("aside", "review-sidebar-region"); sidebar.className = "lane-list";
  sidebar.setAttribute("aria-label", "Conversation lanes");
  const footer = node("footer", "", "", sidebar);
  const quota = node("section", "sidebar-quota", "", sidebar);
  quota.setAttribute("aria-label", "Subscription quota snapshot");
  const strip = node("div", "quota-strip", "", quota);
  strip.setAttribute("aria-label", "Quota snapshot");
  const quotaLink = node("a", "", "", strip);
  quotaLink.setAttribute("aria-label", "agy · 5h: 42% remaining. Open Quota page");
  const quotaBar = node("i", "", "", quotaLink);
  const control = node("button", "refresh", "Refresh data", footer);
  const icon = node("span", "", "", control);
  const nav = node("nav", "", "", sidebar);
  const tab = node("button", "", "", nav);
  const tabLabel = node("span", "", "Overview", tab);
  const content = node("article", "", "Card", sidebar);
  for (const id of ["review-annotation", "review-toggle", "review-panel", "review-panel-toggle", "review-message", "review-count", "review-awaiting", "review-inline-summary", "review-history", "review-history-summary", "review-target", "review-queue", "review-context", "review-send", "review-end", "review-pick", "review-thread", "review-phone-thread", "review-sent", "review-sent-list", "review-sent-summary", "review-sent-count", "review-queued-count", "review-state", "review-close", "review-form-close", "review-form"]) if (!nodes.has(id)) node("button", id);
  const documentListeners = new Map();
  const document = { body: { append() {} }, createElement: () => node("div"), getElementById: (id) => nodes.get(id), querySelector: () => ({ textContent: "" }), addEventListener: (type, fn) => documentListeners.set(type, fn) };
  const sent = [];
  const context = vm.createContext({ document, window: { addEventListener() {} }, setTimeout, location: { hash: "#overview" }, fetch: (_url, options) => {
    if (options?.method !== "POST") return Promise.resolve({ ok: true, json: async () => ({ ready: true, version: reviewVersion, delivery: "local", sessionId: "", awaitingReview: 0 }) });
    sent.push(JSON.parse(options.body));
    return Promise.resolve({ ok: true, json: async () => ({ receiptId: "test-receipt" }) });
  }, crypto: { randomUUID: () => "test" } });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext("annotateByDefault", context), false, "ordinary content clicks interact by default");
  vm.runInContext("annotateByDefault = true", context);
  const badgeState = vm.runInContext("showAwaitingReview", context);
  badgeState(0);
  assert.equal(nodes.get("review-awaiting").hidden, true);
  badgeState(1);
  assert.equal(nodes.get("review-awaiting").textContent, 1);
  assert.match(nodes.get("review-panel-toggle").getAttribute("aria-label"), /1 annotation awaiting Firstmate receipt/);
  badgeState(12);
  assert.equal(nodes.get("review-awaiting").textContent, 12);
  assert.match(nodes.get("review-panel-toggle").getAttribute("aria-label"), /12 annotations awaiting Firstmate receipt/);
  const region = vm.runInContext("regionFor", context)(icon);
  assert.equal(region.label, "Refresh data");
  assert.equal(vm.runInContext("label", context)({ getAttribute: () => null, matches: () => false, children: [{}], querySelector: () => ({ textContent: "Alpha" }), tagName: "ARTICLE" }), "Alpha", "a content-card annotation uses its heading, not ARTICLE");
  assert.equal(region.id, "refresh");
  assert.equal(vm.runInContext("regionFor", context)(sidebar), null);
  // Alt-click on the nested icon selects the button, not the sidebar or icon.
  documentListeners.get("click")({ target: content, button: 0, detail: 1, altKey: false, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating Card/);
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating Card/, "Alt-click interacts when annotation mode is on");
  vm.runInContext("annotateByDefault = false", context);
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating Refresh data/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(nodes.get("review-message").focused, true);
  assert.doesNotMatch(nodes.get("review-target").textContent, /Conversation lanes/);
  const gesture = node("label", "", "", footer); gesture.className = "review-gesture";
  gesture.setAttribute("aria-label", "Alt-click annotation control");
  const checkbox = nodes.get("review-toggle"); checkbox.parentElement = gesture; gesture.children.push(checkbox);
  const gestureText = node("span", "", "Alt-click to annotate", gesture);
  assert.equal(vm.runInContext("regionFor", context)(gestureText).label, "Alt-click annotation control");
  assert.equal(vm.runInContext("regionFor", context)(quotaBar).label, "agy · 5h: 42% remaining. Open Quota page");
  assert.equal(vm.runInContext("regionFor", context)(strip).label, "Quota snapshot");
  let interceptedLabel = false;
  documentListeners.get("click")({ target: gestureText, button: 0, detail: 1, altKey: false, preventDefault() { interceptedLabel = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.equal(interceptedLabel, false); // label remains a usable checkbox on ordinary click
  documentListeners.get("click")({ target: gestureText, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating Alt-click annotation control/);
  documentListeners.get("click")({ target: quotaBar, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating agy · 5h/);
  documentListeners.get("click")({ target: strip, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.match(nodes.get("review-target").textContent, /Annotating Quota snapshot/);
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  checkbox.checked = true;
  checkbox.dispatch("change", { target: checkbox });
  assert.equal(checkbox.checked, true);
  let intercepted = false;
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: false, preventDefault() { intercepted = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.equal(intercepted, true); // checked: even controls are captured, not activated
  documentListeners.get("click")({ target: tabLabel, button: 0, detail: 1, altKey: false, preventDefault() { intercepted = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.equal(intercepted, true); // navigation is captured through nested spans too
  intercepted = false;
  documentListeners.get("click")({ target: content, button: 0, detail: 1, altKey: false, preventDefault() { intercepted = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.equal(intercepted, true); // non-control content is annotated
  intercepted = false;
  checkbox.checked = false;
  checkbox.dispatch("change", { target: checkbox });
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: true, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  checkbox.checked = true;
  checkbox.dispatch("change", { target: checkbox });
  documentListeners.get("click")({ target: icon, button: 0, detail: 1, altKey: true, preventDefault() { intercepted = true; }, stopPropagation() {}, stopImmediatePropagation() {} });
  assert.equal(intercepted, false); // Alt-click interacts when checked
  // Regression: annotation click mode owns every click, including non-interactive
  // areas with no annotatable region; none may reach the page underneath.
  assert.equal(vm.runInContext("regionFor", context)(sidebar), null);
  intercepted = false;
  let stopped = false;
  documentListeners.get("click")({ target: sidebar, button: 0, detail: 1, altKey: false, preventDefault() { intercepted = true; }, stopPropagation() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(intercepted && stopped, true, "click on a non-annotatable area is still captured in annotation mode");
  assert.match(nodes.get("review-toggle").getAttribute("aria-label"), /Annotation mode on/);
  const message = nodes.get("review-message");
  let prevented = false;
  message.value = "first note";
  message.dispatch("keydown", { key: "Enter", shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false); // browser inserts the new line
  message.dispatch("keydown", { key: "Enter", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(vm.runInContext("queue.length", context), 1);
  assert.equal(nodes.get("review-count").textContent, "· 1 queued");
  assert.match(nodes.get("review-panel-toggle").getAttribute("aria-label"), /0 annotations awaiting Firstmate receipt; 1 note queued locally/);
  badgeState(12);
  assert.match(nodes.get("review-panel-toggle").getAttribute("aria-label"), /12 annotations awaiting Firstmate receipt; 1 note queued locally/);
  assert.match(nodes.get("review-toggle").getAttribute("aria-label"), /Annotation mode on: tap or click content to annotate/);
  assert.equal(vm.runInContext("queue[0].label || queue[0].text", context), "Refresh data");
  let rerenders = 0;
  nodes.get("review-thread").replaceChildren = () => { rerenders++; };
  documentListeners.get("pointerover")({ target: content, pointerType: "mouse" });
  assert.equal(nodes.get("review-pick").hidden, false);
  documentListeners.get("pointerover")({ target: content, pointerType: "touch" });
  assert.equal(rerenders, 0, "hover and touch must not rebuild the open conversation");
  vm.runInContext('config.ready = true', context);
  message.value = "second note";
  message.dispatch("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].entries.map((e) => e.prompt), ["first note", "second note"]);
  await new Promise(setImmediate);
  assert.equal(vm.runInContext("queue.length", context), 0);
  assert.equal(vm.runInContext("pending", context), false);
  assert.equal(vm.runInContext("config.ready", context), true);
  message.value = "third note";
  message.dispatch("keydown", { key: "Enter", metaKey: true, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].entries[0].prompt, "third note");
});

test("review draft, queue, open panel and retry ID survive a document reload", async () => {
  const script = reviewClientScript;
  const values = new Map();
  let currentVersion = reviewVersion;
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  function page() {
    const elements = new Map();
    function element(id) {
      if (!elements.has(id)) elements.set(id, {
        id, value: "", textContent: "", hidden: id === "review-panel", listeners: {}, style: {}, isConnected: true,
        addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(key, value) { this[key] = value; },
        focus() { this.focused = true; }, replaceChildren() {}, append() {},
        requestSubmit() { this.listeners.submit({ preventDefault() {} }); },
      });
      return elements.get(id);
    }
    const document = { body: { append() {} }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener() {}, createElement: () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {} }) };
    const context = vm.createContext({ document, window: { addEventListener() {} }, setTimeout, sessionStorage: storage,
      location: { hash: "#overview" }, crypto: { randomUUID: () => payload.batchId },
      fetch: async () => ({ ok: true, json: async () => ({ ready: true, version: currentVersion, delivery: "local", sessionId: "" }) }),
    });
    vm.runInContext(script, context);
    return { element, context };
  }
  const first = page();
  first.element("review-panel-toggle").listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(first.element("review-message").focused, true, "review-chat opening focuses the textarea after click");
  first.element("review-message").value = "queued note";
  first.element("review-message").listeners.input();
  first.element("review-form").listeners.submit({ preventDefault() {} });
  first.element("review-message").value = "unsent follow-up";
  first.element("review-message").listeners.input();
  vm.runInContext('batchId = "retry-this-batch"; update()', first.context);

  const restored = page();
  assert.equal(restored.element("review-panel").hidden, false);
  assert.equal(restored.element("review-panel-toggle")["aria-expanded"], "true");
  assert.equal(restored.element("review-count").textContent, "· 1 queued");
  assert.equal(restored.element("review-message").value, "unsent follow-up");
  assert.equal(vm.runInContext("queue[0].prompt", restored.context), "queued note");
  assert.equal(vm.runInContext("batchId", restored.context), "retry-this-batch");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(restored.element("review-message").focused, true);
  currentVersion = "new-preview-revision";
  const updated = page();
  await new Promise(setImmediate);
  assert.equal(vm.runInContext("queue[0].version", updated.context), currentVersion);
  assert.equal(vm.runInContext("batchId", updated.context), null, "old retry ID cannot be used with updated content");
  assert.equal(updated.element("review-message").value, "unsent follow-up");
  assert.match(updated.element("review-state").textContent, /Preview updated.*Check unsent annotation targets/);
});

test("review conversation notes: long notes are collapsed by default and expandable", async () => {
  const script = reviewClientScript;
  function createTestNode(tag) {
    const listeners = new Map();
    const children = [];
    return {
      tagName: tag.toUpperCase(),
      className: "",
      textContent: "",
      value: "",
      children,
      style: {},
      title: "",
      open: false,
      listeners,
      addEventListener(type, fn) { listeners.set(type, fn); },
      append(...items) { children.push(...items); },
      replaceChildren(...items) { children.length = 0; children.push(...items); },
      focus() { this.focused = true; },
      setAttribute(k, v) { this[k] = v; },
    };
  }
  const elements = new Map();
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, createTestNode(id));
    return elements.get(id);
  }
  const thread = getElement("review-thread");
  const sentList = getElement("review-sent-list");
  const context = vm.createContext({
    document: {
      body: { append() {} },
      getElementById: getElement,
      querySelector: () => ({ textContent: "" }),
      addEventListener() {},
      createElement: createTestNode,
    },
    window: { addEventListener() {} },
    setTimeout,
    sessionStorage: { getItem: () => null, setItem: () => {} },
    location: { hash: "#overview" },
    crypto: { randomUUID: () => "test-uuid" },
    fetch: async () => ({ ok: true, json: async () => ({ ready: true, version: reviewVersion, delivery: "local", sessionId: "" }) }),
  });
  vm.runInContext(script, context);

  // Queue a short note and a long note
  const shortText = "Short note";
  const longText = "This is a very long note that exceeds the threshold of one hundred characters and describes detailed feedback about the layout and badge behavior in the annotation view.";

  vm.runInContext(`
    queue = [
      { kind: "annotation", text: ${JSON.stringify(shortText)}, route: "#overview", version: "${reviewVersion}", region: { id: "btn-1", label: "Button 1" } },
      { kind: "annotation", text: ${JSON.stringify(longText)}, route: "#overview", version: "${reviewVersion}", region: { id: "btn-2", label: "Button 2" } }
    ];
    update();
  `, context);

  // Queued notes are listed directly in the always-visible Queued section.
  assert.equal(thread.children.length, 2);
  assert.equal(getElement("review-queued-count").textContent, "2");
  assert.equal(getElement("review-sent-count").textContent, "0");
  const card1 = thread.children[0];
  const card1Details = card1.children.find((c) => c.className === "review-note-details");
  assert.equal(card1Details, undefined, "Short note must not use details disclosure");
  const card1Text = card1.children.find((c) => c.className === "review-note-text");
  assert.equal(card1Text.textContent, shortText);

  // Card 2 (long note): uses details disclosure, collapsed by default
  const card2 = thread.children[1];
  const card2Header = card2.children.find((c) => c.className === "review-note-header");
  const card2Details = card2.children.find((c) => c.className === "review-note-details");
  assert.ok(card2Details, "Long note must use details disclosure");
  assert.equal(card2Details.open, false, "Long note must be collapsed by default");

  // Summary has a preview; the accessible expand button lives in the note header.
  const summary = card2Details.children.find((c) => c.className === "review-note-summary");
  assert.ok(summary);
  const toggle = card2Header.children.find((c) => c.className === "review-note-toggle");
  assert.equal(toggle.textContent, "Expand");

  // Full text is contained inside details
  const fullText = card2Details.children.find((c) => c.className.includes("review-note-full"));
  assert.equal(fullText.textContent, longText);

  // Clicking the button toggles the long note for pointer and keyboard activation.
  toggle.listeners.get("click")();
  assert.equal(card2Details.open, true, "Expand reveals the long note");
  assert.equal(toggle.textContent, "Collapse");
  toggle.listeners.get("click")();
  assert.equal(card2Details.open, false, "Collapse hides the long note");
  assert.equal(toggle.textContent, "Expand");

  vm.runInContext('inFlight = { id: "batch-1", payload: { entries: queue.splice(0) } }; update()', context);
  assert.equal(thread.children[0].children[0].children[0].textContent, "Pending · batching batch · 2 notes");
  assert.equal(thread.children[0].children[0].children[1].textContent, "Sending · 2 notes");
  assert.equal(thread.children[0].children[0].title, "Pending · batching batch · 2 notes");
  assert.equal(thread.children[0].children.filter((child) => child.tagName === "ARTICLE").length, 2);
  vm.runInContext('retryBatches = [inFlight]; inFlight = null; update()', context);
  assert.equal(thread.children[0].children[0].children[0].textContent, "Retry needed batch · 2 notes");
  assert.equal(thread.children[0].children[0].children[1].textContent, "Retry · 2 notes");
  vm.runInContext('sent.push({ id: "batch-1", receiptId: "receipt-1", entries: retryBatches.pop().payload.entries }); update()', context);
  assert.equal(sentList.children.length, 1);
  assert.equal(thread.children.length, 0, "sent batches leave the Queued section");
  assert.equal(getElement("review-sent-count").textContent, "1");
  assert.equal(getElement("review-queued-count").textContent, "0");
  const batch = sentList.children[0];
  assert.equal(batch.className, "review-batch");
  assert.equal(batch.open, false);
  const fullHeader = "Accepted durably · Firstmate intake not yet confirmed · 2 notes · receipt receipt-1";
  assert.equal(batch.children[0].children[0].className, "review-batch-full");
  assert.equal(batch.children[0].children[0].textContent, fullHeader);
  assert.equal(batch.children[0].title, fullHeader);
  assert.equal(batch.children[0].children[1].className, "review-batch-label");
  assert.equal(batch.children[0].children[1].textContent, "Accepted · 2 notes");
  assert.equal(batch.children[0].children[1]["aria-hidden"], "true");
  vm.runInContext(await readFile(new URL("../public/call-lifecycle.js", import.meta.url), "utf8"), context);
  vm.runInContext(`sent[0].state = "accepted"; sent[0].intake = "accepted"; sent[0].announced = true; update();`, context);
  const phrase = context.window.callLifecycle.sentLabel("pending");
  for (const listId of ["review-sent-list", "review-phone-thread"]) {
    const header = getElement(listId).children[0].children[0];
    const expanded = header.children[0].textContent;
    const collapsed = header.children[1].textContent;
    assert.equal(header.children[0].className, "review-batch-full");
    assert.equal(header.children[1].className, "review-batch-label");
    assert.equal(collapsed, `${phrase} · 2 notes`);
    assert.equal(expanded, `${phrase} · 2 notes · receipt receipt-1`);
    assert.ok(expanded.startsWith(collapsed), `${listId} expanded label continues the collapsed label`);
    assert.doesNotMatch(`${collapsed}\n${expanded}`, /Queued|Accepted durably/);
  }
  const pendingMeta = batch.children[0].children[2];
  assert.equal(pendingMeta.className, "review-batch-meta");
  assert.equal(pendingMeta.children.length, 1, "a sent batch without a time still shows its id");
  assert.equal(pendingMeta.children[0].className, "review-batch-id");
  assert.equal(pendingMeta.children[0].textContent, "batch-1");
  assert.equal(pendingMeta.children[0].title, "batch-1");
  assert.equal(pendingMeta.children[0]["aria-label"], "Copy batch id batch-1");
  assert.doesNotMatch(fullHeader, /Received by supervisor/);
  assert.equal(batch.children.filter((child) => child.tagName === "ARTICLE").length, 2);
  batch.open = true;
  batch.listeners.get("toggle")();
  vm.runInContext('update()', context);
  assert.equal(sentList.children[0].open, true, "Batch stays expanded across rerenders");
  const sentLong = sentList.children[0].children[2];
  const sentDetails = sentLong.children.find((child) => child.className === "review-note-details");
  assert.equal(sentDetails.open, false);
  sentDetails.open = true;
  sentDetails.listeners.get("toggle")();
  vm.runInContext('update()', context);
  assert.equal(sentList.children[0].children[2].children.find((child) => child.className === "review-note-details").open, true);
  sentList.children[0].open = false;
  sentList.children[0].listeners.get("toggle")();
  vm.runInContext('update()', context);
  assert.equal(sentList.children[0].open, false, "Entire batch collapses together");

  context.copied = "";
  context.navigator = { clipboard: { writeText(text) { context.copied = text; return Promise.resolve(); } } };
  vm.runInContext('sent[0].sentAt = "2026-03-04T15:07:00.000Z"; update()', context);
  const sentSummary = sentList.children[0].children[0];
  assert.equal(sentSummary.children[0].className, "review-batch-full");
  assert.equal(sentSummary.children[1].className, "review-batch-label");
  const meta = sentSummary.children[2];
  assert.equal(meta.className, "review-batch-meta");
  const time = meta.children.find((child) => child.tagName === "TIME");
  const code = meta.children.find((child) => child.className === "review-batch-id");
  assert.equal(time.datetime, "2026-03-04T15:07:00.000Z");
  assert.match(time.title, /ago$/);
  assert.ok(time.textContent.length > 0 && time.textContent.length < 24);
  assert.equal(code.textContent, "batch-1");
  const copyEvent = { preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  code.listeners.get("click")(copyEvent);
  assert.equal(context.copied, "batch-1");
  assert.equal(copyEvent.stopped, true);
  assert.equal(copyEvent.defaultPrevented, true);
  const sentCard = sentList.children[0].children.find((child) => child.tagName === "ARTICLE");
  const messageCopy = sentCard.children.find((child) => child.className === "review-note-copy");
  assert.equal(messageCopy.textContent, "Copy");
  assert.equal(messageCopy["aria-label"], "Copy message and batch details");
  assert.equal(sentCard.children.find((child) => child.className === "review-note-header").children.some((child) => child.className === "review-note-copy"), false);
  context.copied = "";
  messageCopy.listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageCopy.textContent, "Copied");
  const copiedPhrase = context.window.callLifecycle.sentLabel("pending");
  assert.match(context.copied, new RegExp(`^Short note\\n\\n${copiedPhrase} · 2 notes · receipt receipt-1\\nbatch-1\\n2026-03-04T15:07:00\\.000Z · `));

  vm.runInContext(`window.quarterdeckCallQueue = { list: () => [{ key: "decision:alpha-call", label: "Alpha", text: "Tuesday", phase: "confirm" }] }; update()`, context);
  const callSummary = getElement("review-phone-thread").children.map((child) => child.children[0]).find((summary) => summary.children[1].textContent.startsWith("Call answers"));
  assert.equal(callSummary.children[1].textContent, "Call answers · 1");
  assert.equal(callSummary.children.length, 2, "the call-answer group is not given a fake batch id");
  const callCard = getElement("review-thread").children.find((child) => child.className === "review-call-answer");
  const callCopy = callCard.children.find((child) => child.className === "review-note-copy");
  const callRemove = callCard.children.find((child) => child.className === "review-note-header").children.find((child) => child.textContent === "Remove");
  assert.equal(callRemove.tagName, "BUTTON");
  context.copied = "";
  callCopy.listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.copied, "Tuesday\n\nQueued Captain's Call answers · 1");

  vm.runInContext(`
    window.quarterdeckCallQueue = { list: () => [] };
    batchId = "abcdef12-3456-7890-abcd-ef1234567890";
    queue = [{ kind: "annotation", text: "Short note", route: "#overview", version: "${reviewVersion}", region: { id: "btn-1", label: "Button 1" } }];
    update();
  `, context);
  const queuedSummary = getElement("review-phone-thread").children.map((child) => child.children[0]).find((summary) => summary.children[1].textContent === "Queued · 1 note");
  assert.equal(queuedSummary.children[1].textContent, "Queued · 1 note");
  const queuedId = queuedSummary.children[2].children.find((child) => child.className === "review-batch-id");
  assert.equal(queuedId.textContent, "abcdef1");
  assert.equal(queuedId.title, "abcdef12-3456-7890-abcd-ef1234567890");
  assert.equal(queuedSummary.children[2].children.some((child) => child.tagName === "TIME"), false, "queued batches have no sent time");
  const queuedCard = getElement("review-thread").children.find((child) => child.tagName === "ARTICLE");
  context.copied = "";
  queuedCard.children.find((child) => child.className === "review-note-copy").listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.copied, "Short note\n\nQueued batch · 1 note\nabcdef12-3456-7890-abcd-ef1234567890");
});
