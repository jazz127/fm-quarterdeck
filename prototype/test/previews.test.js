import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.js";
import { reviewVersion } from "../review.js";
import http from "node:http";
import { validateRegistry, previewPath, previewHealth, commitRelation } from "../previews.js";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const SHA = "a".repeat(40);
const entry = { id: "dev-demo", name: "Development: demo", branch: "dev/demo", commit: SHA, remoteCheckpoint: SHA, validation: "captured", checkout: null, port: null };
const main = { id: "main", name: "Main", branch: "main", commit: reviewVersion, remoteCheckpoint: reviewVersion, validation: "accepted" };
async function server(options, fn, env = {}) {
  const app = createServer(env, { previewRegistry: [main, entry], ...options });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${app.address().port}`, app); } finally { await app.shutdownPreviews(); await new Promise((resolve) => app.close(resolve)); }
}
test("registry is exact, tier-bound, ID-only, pre-provisioned and rejects launch text/paths/ports", () => {
  assert.deepEqual(validateRegistry([entry]), [entry]);
  for (const changed of [
    { id: "dev-../main" }, { branch: "main" }, { commit: "dev/demo" }, { remoteCheckpoint: "broken" }, { url: "http://127.0.0.1:4242" },
    { checkout: "../escape" }, { checkout: "/absolute" }, { checkout: "a//b" }, { checkout: "a/./b" },
    { command: "node" }, { argv: [] }, { port: 65536 }, { port: 80 }, { validation: "accepted-ish" },
  ]) assert.throws(() => validateRegistry([{ ...entry, ...changed }]));
  assert.throws(() => validateRegistry([entry, entry]));
  assert.throws(() => validateRegistry([{ ...main, checkout: "main" }]));
  assert.throws(() => validateRegistry([{ ...entry, remoteCheckpoint: null }]));
  assert.deepEqual(validateRegistry([{ id: "stg", name: "Staging", branch: "stg", commit: SHA, validation: "captured" }])[0].remoteCheckpoint, null);
  assert.deepEqual(previewPath("/preview/dev-demo/api/review"), { id: "dev-demo", pathname: "/api/review" });
  assert.equal(previewPath("/preview/refs/heads/main"), null);
});
test("read-only ancestry distinguishes all relationships and absent/unknown checkpoints", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "preview-relations-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "local");
  const local = git("rev-parse", "HEAD");
  git("switch", "-q", "--detach", base);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "remote");
  const remote = git("rev-parse", "HEAD");
  for (const [a, b, expected] of [[base, base, "equal"], [local, base, "local-ahead"], [base, local, "remote-ahead"], [local, remote, "diverged"], [local, null, "absent"], [local, SHA, "unknown"]])
    assert.equal(await commitRelation(a, b, cwd), expected);
  assert.equal(git("rev-parse", "HEAD"), remote); // comparison did not move any ref or checkout
});

test("health requires ok:true and exact full revision, mismatch has its own non-ready state", async () => {
  const runtime = { ...entry, url: "http://127.0.0.1:4242" };
  const probe = (version, ok = true) => async (url) => ({ ok: true, json: async () => url.endsWith("health") ? { service: "fm-quarterdeck", ok } : { version } });
  assert.equal((await previewHealth(runtime, probe("b".repeat(40)))).state, "revision-mismatch");
  assert.equal((await previewHealth(runtime, probe(SHA, false))).state, "failed");
  assert.equal((await previewHealth(runtime, probe(SHA))).health, "running");
});
test("selector lists exact stopped revisions without internals; write accepts only ID under exact origin", async () => server({}, async (base) => {
  const list = await (await fetch(`${base}/api/previews`)).json();
  assert.equal(list[1].commit, SHA); assert.equal(list[1].health, "stopped"); assert.equal(list[0].state, "ready");
  for (const field of ["url", "checkout", "port", "pid", "identity"]) assert.equal(list[1][field], undefined);
  const stopped = await fetch(`${base}/preview/dev-demo/#lanes/general`);
  assert.equal(stopped.status, 503); assert.match(await stopped.text(), /preview unavailable[\s\S]*preview-selector\.js/);
  assert.equal((await fetch(`${base}/preview/dev-unknown/`)).status, 404);
  const headers = { origin: base, "content-type": "application/json" };
  const post = (body, changed = {}) => fetch(`${base}/api/previews/select`, { method: "POST", headers: { ...headers, ...changed }, body: JSON.stringify(body) });
  for (const extra of [{ branch: "dev/demo" }, { commit: SHA }, { remoteCheckpoint: SHA }, { relation: "equal" }, { ref: "main" }, { path: "/tmp" }, { port: 43000 }, { command: "node" }, { destination: "crew" }]) assert.equal((await post({ id: entry.id, ...extra })).status, 400);
  assert.equal((await post({ id: "dev-unknown" })).status, 400);
  assert.equal((await post({ id: "main" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ id: "main" })).status, 200);
  assert.equal((await post({ id: entry.id })).status, 409);
  assert.equal((await fetch(`${base}/preview/main/api/health`)).status, 200);
}));

test("mismatched Main refuses its identity without silently substituting its remote checkpoint", async () => {
  const wrong = { ...main, remoteCheckpoint: SHA };
  const app = createServer({}, { previewRegistry: [wrong] });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const listed = await (await fetch(`${base}/api/previews`)).json();
    assert.equal(listed[0].state, "revision-mismatch");
    assert.equal(listed[0].remoteCheckpoint, SHA);
    assert.equal((await fetch(`${base}/preview/main/`)).status, 409);
    assert.equal((await fetch(`${base}/api/previews/select`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: '{"id":"main"}' })).status, 409);
  } finally { await app.shutdownPreviews(); await new Promise((resolve) => app.close(resolve)); }
});

test("registered UAT host has a truthful switch without registering Main or adopting staging", async () => {
  const uat = { id: "uat", name: "UAT", branch: "uat", commit: reviewVersion, remoteCheckpoint: null, validation: "accepted" };
  const stg = { id: "stg", name: "Staging", branch: "stg", commit: SHA, remoteCheckpoint: null, validation: "captured", checkout: "staging" };
  assert.throws(() => createServer({ FM_DEPLOYMENT_TIER: "uat" }, { previewRegistry: [{ ...uat, commit: SHA }, stg] }), /exact stable host revision/);
  assert.throws(() => createServer({ FM_DEPLOYMENT_TIER: "uat" }, { previewRegistry: [uat, main, stg] }), /exact stable host revision/);
  const app = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { previewRegistry: [uat, stg] });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const entries = await (await fetch(`${base}/api/previews`)).json();
    assert.deepEqual(entries.map((entry) => entry.id), ["uat", "stg"]);
    assert.equal(entries[0].state, "ready"); assert.equal(entries[0].relation, "absent");
    assert.equal(entries[1].state, "stopped");
    for (const route of ["/", "/preview/uat/"]) {
      const html = await (await fetch(base + route)).text();
      assert.match(html, /FM_PREVIEW_ID="uat"/); assert.match(html, /preview-selector\.js/);
      assert.doesNotMatch(html, /FM_PREVIEW_ID="main"|Active: Main/);
      assert.match(html, /id="review-message"[^>]*placeholder="Message firstmate"/);
      // The selector is a gateway asset even for a registered preview route.
      const servedSelector = await fetch(base + "/preview-selector.js");
      if (route !== "/") assert.equal((await fetch(base + "/preview/uat/preview-selector.js")).status, 404);
      assert.equal(servedSelector.status, 200);
      assert.match(await servedSelector.text(), /input\.placeholder = "Message firstmate"/);
    }
    const headers = { origin: base, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/previews/select`, { method: "POST", headers, body: '{"id":"uat"}' })).status, 200);
    assert.equal((await fetch(`${base}/api/previews/select`, { method: "POST", headers, body: '{"id":"main"}' })).status, 400);
    assert.equal((await fetch(`${base}/preview/uat/api/review`)).status, 200);
    assert.equal((await fetch(`${base}/preview/stg/`)).status, 503);
  } finally { await app.shutdownPreviews(); await new Promise((resolve) => app.close(resolve)); }
});

test("lifecycle exact HTTPS origin does not trust arbitrary tailnet hosts or forwarded headers", async () => server({}, async (base) => {
  const post = (host, origin, extra = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/previews/select`, { method: "POST", headers: { host, origin, "content-type": "application/json", ...extra } }, (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode })); });
    request.on("error", reject); request.end('{"id":"main"}');
  });
  assert.equal((await post("review.example.ts.net", "https://review.example.ts.net")).status, 200);
  assert.equal((await post("evil.example.ts.net", "https://evil.example.ts.net", { "x-forwarded-host": "review.example.ts.net" })).status, 403);
  assert.equal((await post("review.example.ts.net", "http://review.example.ts.net")).status, 403);
}, { FM_REVIEW_ALLOWED_ORIGIN: "https://review.example.ts.net" }));

test("gateway preserves deep links and separate signed schemas; request, stream and delivery hold a lease", async () => {
  let active = 0, completed = 0, deliverDone, quotaRequests = 0;
  const runtime = http.createServer((request, response) => {
    if (request.url === "/api/quota") quotaRequests++;
    if (request.url === "/") { response.setHeader("content-type", "text/html"); response.end('<html><head></head><body><script src="/app.js"></script></body></html>'); }
    else if (request.url === "/api/dev-reload") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: connected\n\n"); }
    else { response.setHeader("content-type", "application/json"); response.end('{"source":"isolated"}'); }
  });
  await new Promise((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  const attributed = [];
  const lifecycleFactory = () => ({ ready: Promise.resolve(), close: async () => {}, list: () => [],
    acquire() { active++; return (used) => { active--; if (used) completed++; }; }, verify: async () => true,
    runtime: () => ({ ...entry, url: `http://127.0.0.1:${runtime.address().port}` }) });
  try { await server({ lifecycleFactory,
    quotaReader: async () => { assert.equal(active, 1); return { source: "stable-shared-quota" }; },
    localReviewDeliver: async (payload) => { attributed.push(payload); assert.equal(active, 1); return { receiptId: "local:test" }; },
    chatDeliver: async (payload) => { attributed.push(payload); assert.equal(active, 1); await new Promise((r) => { deliverDone = r; }); return { receiptId: "chat:test" }; },
  }, async (base) => {
    const headers = { origin: base, "content-type": "application/json" };
    const html = await (await fetch(`${base}/preview/dev-demo/#lanes/general`)).text();
    assert.match(html, /preview-selector\.js/); assert.match(html, /preview\/dev-demo\/app\.js/); assert.match(html, /FM_PREVIEW_ID/);
    assert.deepEqual(await (await fetch(`${base}/preview/dev-demo/api/dashboard`)).json(), { source: "isolated" });
    assert.equal(active, 0); assert.equal(completed, 2);
    assert.deepEqual(await (await fetch(`${base}/preview/dev-demo/api/quota`)).json(), { source: "stable-shared-quota" });
    assert.equal(quotaRequests, 0); assert.equal(active, 0); assert.equal(completed, 3);
    const batch = { schema: "fm-agentos-review.v1", batchId: "11111111-1111-4111-8111-111111111111", sessionId: "", version: SHA,
      route: "#lanes/general", end: false, entries: [{ kind: "annotation", text: "Check", route: "#lanes/general", version: SHA, region: { id: "project:abc", label: "Card" } }] };
    const review = (body) => fetch(`${base}/preview/dev-demo/api/review`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await review({ ...batch, branch: "main" })).status, 400);
    assert.equal((await review({ ...batch, version: "b".repeat(40) })).status, 400);
    assert.equal((await review(batch)).status, 200);
    assert.equal(attributed[0].provenance.branch, "dev/demo"); assert.equal(attributed[0].provenance.commit, SHA);
    assert.equal(attributed[0].provenance.remoteCheckpoint, SHA);
    assert.ok(Date.parse(attributed[0].provenance.receivedAt)); assert.ok(Date.parse(attributed[0].provenance.dataReadAt));
    const chat = { schema: "fm-agentos-chat.v1", messageId: "11111111-1111-4111-8111-111111111111", route: "#lanes/general", text: "Hello",
      viewContext: { schema: "fm-agentos-chat-view.v1", capturedAt: "2026-01-01T00:00:00Z", route: "#lanes/general",
        served: { branch: "dev/demo", commit: SHA }, lanes: [{ id: "general", name: "General" }],
        filters: { kinds: ["captain"], search: "", searchTruncated: false, session: "", diskSession: "", page: 0 },
        visible: { first: { id: "old:1", at: "2025-01-01T00:00:00Z" }, last: { id: "old:1", at: "2025-01-01T00:00:00Z" }, focused: null } } };
    assert.equal((await fetch(`${base}/preview/dev-demo/api/chat`, { method: "POST", headers, body: JSON.stringify({ ...chat, destination: "crew" }) })).status, 400);
    const delivery = fetch(`${base}/preview/dev-demo/api/chat`, { method: "POST", headers, body: JSON.stringify(chat) });
    while (!deliverDone) await new Promise((r) => setTimeout(r, 5));
    assert.equal(active, 1); deliverDone(); assert.equal((await delivery).status, 200); assert.equal(active, 0);
    assert.equal(attributed[1].destination, "primary-firstmate"); assert.equal(attributed[1].provenance.commit, SHA);
    assert.equal(attributed[1].text, "Hello"); assert.equal(attributed[1].viewContext.visible.last.id, "old:1");
    assert.deepEqual(await (await fetch(`${base}/preview/dev-demo/api/chat`, { method: "POST", headers, body: JSON.stringify(chat) })).json(), { receiptId: "chat:test", contextAttached: true });
    assert.equal(attributed.length, 2, "retry must not deliver twice");
    assert.equal((await fetch(`${base}/preview/dev-demo/api/chat`, { method: "POST", headers, body: JSON.stringify({ ...chat, text: "changed" }) })).status, 409);
    for (const viewContext of [null, { ...chat.viewContext, lanes: [{ id: "secret", name: "x".repeat(7000) }] },
      { ...chat.viewContext, served: { branch: "main", commit: SHA } }, { ...chat.viewContext, visible: { first: { id: "bad", at: "not a date" }, last: null, focused: null } }]) {
      assert.equal((await fetch(`${base}/preview/dev-demo/api/chat`, { method: "POST", headers, body: JSON.stringify({ ...chat, messageId: "22222222-2222-4222-8222-222222222222", viewContext }) })).status, 400);
    }
    assert.equal(attributed[1].provenance.remoteCheckpoint, SHA);
    const abort = new AbortController();
    await fetch(`${base}/preview/dev-demo/api/dev-reload`, { signal: abort.signal });
    assert.equal(active, 1); abort.abort();
    const until = Date.now() + 2000; while (active && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(active, 0);
  }); } finally { await new Promise((resolve) => runtime.close(resolve)); }
});
