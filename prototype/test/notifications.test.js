import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createECDH } from "node:crypto";
import http from "node:http";
import { EventEmitter } from "node:events";
import { createNotificationService, eligibleView, filedIdentity, notificationConfiguration, retryDelay } from "../notifications.js";
import { createNotificationOwner, digest, notificationPaths, privateJson } from "../notification-state.js";
import { createPushProvider, publicIPv4, pushEndpoint, validSubscription } from "../push-provider.js";
import { createServer } from "../server.js";
import { createCallSource } from "../chat-asks.js";
import { createProcrastinationStore } from "../call-procrastination.js";
import { createInboxBatcher } from "../inbox-batcher.js";
import { answerEnvelope, formatAnswerNote } from "../bearings-answer.js";

const device = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.alloc(32, 1));
const subscription = (n = 1) => ({ endpoint: `https://fcm.googleapis.com/wp/synthetic-${n}`, expirationTime: null, keys: { auth: Buffer.alloc(16, 1).toString("base64url"), p256dh: key.getPublicKey().toString("base64url") } });
const card = (task = "example-call", owner = "(main)", type = "decision") => ({ key: `${type}:${task}`, task, owner, type, clock: { at: null }, answer: { question: task, options: [] } });
const initialNow = Date.parse("2030-01-01T00:00:00Z");
const model = (cards, now = initialNow) => ({ state: "ready", stale: false, observedAt: new Date(now).toISOString(), cards, coverage: {}, omitted: [] });
const input = (cards, now = initialNow) => ({ available: true, checkedAt: new Date(now).toISOString(), model: model(cards, now), receipts: { pending: [], handled: [], replies: [] }, pending: [], procrastination: { until: {} } });
async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "qd-push-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const paths = notificationPaths({ FM_QUARTERDECK_STATE_PATH: path.join(temp, "state.json") });
  const binding = digest("synthetic-installation"), owner = createNotificationOwner(paths, binding);
  let now = initialNow, evidence = input([card("old-call")]), validRevision = true, sends = [], providerResult = { statusCode: 201 };
  const listeners = new Set(), intervals = new Set();
  const source = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const configuration = { origin: "https://dashboard.example.invalid", paths, binding, publicKey: key.getPublicKey().toString("base64url"), provider: async (sub, payload, options) => { sends.push({ sub, payload, options: { ttl: options.ttl, topic: options.topic } }); if (providerResult instanceof Error) throw providerResult; return providerResult; } };
  const timers = { setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn) };
  const build = (options = {}) => createNotificationService({ configuration, source, timers, evidence: async () => evidence, initializeEvidence: async () => {}, revision: async () => validRevision, now: () => now, random: () => 0, ...options });
  let service = build();
  t.after(() => service.close());
  return { owner, paths, configuration, source, timers, sends, listeners, intervals, get service() { return service; }, setEvidence(value) { evidence = value; }, cards(cards) { evidence = input(cards, now); }, revision(value) { validRevision = value; }, advance(ms) { now += ms; }, get now() { return now; }, result(value) { providerResult = value; }, async restart(options) { service.close(); service = build(options); await service.ready; await service.tick(); return service; } };
}

test("fresh enrollment baselines old calls, allocates one per producer/task, persists dedupe and destination repair", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.status(device())).state, "not-enabled");
  await f.service.enroll(device(), subscription());
  assert.equal(f.sends.length, 0); assert.equal(f.listeners.size, 1); assert.equal(f.intervals.size, 1);
  f.cards([card("old-call"), card("new-call")]); await f.service.tick();
  assert.equal(f.sends.length, 1);
  const original = f.sends[0];
  assert.deepEqual(Object.keys(original.payload).sort(), ["body", "destination", "event", "title"]);
  assert.equal(original.options.ttl, 900); assert.equal(original.options.topic.length, 32);
  assert.ok(!JSON.stringify(original.payload).includes("new-call"));
  f.cards([card("new-call", "(main)", "merge"), { ...card("new-call"), summary: "Edited summary", rev: "changed" }]); await f.service.tick();
  await f.restart(); assert.equal(f.sends.length, 1);
  await f.service.disable(device()); assert.equal((await f.owner.read()).subscriptions[device()].subscription, null); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  f.cards([card("new-call"), card("idle-call")]); await f.service.enroll(device(), subscription(2));
  assert.equal(f.sends.length, 1, "reenrollment baselines unseen idle calls");
  f.cards([card("new-call", "other-owner")]); await f.service.tick(); assert.equal(f.sends.length, 2);
  const saved = await f.owner.read(); assert.equal(Object.keys(saved.events).length, 2);
  assert.equal((await f.service.status(device())).accepted, 2, "acceptance is distinct from display/read");
  assert.equal((await (await import("node:fs/promises")).stat(f.paths.state)).mode & 0o777, 0o600);
});

test("a first-seen closed hold stays suppressed through restart and rehold", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  const evidence = input([], f.now);
  evidence.model.holds = [{ source: "data/backlog.md", task: "closed-before-card", closed: true, open: false }];
  f.setEvidence(evidence); await f.service.tick();
  await f.restart();
  f.cards([card("closed-before-card", "(main)", "merge")]); await f.service.tick();
  assert.equal(f.sends.length, 0, "positive closure prevents a reopened episode from alerting");
  const state = await f.owner.read();
  assert.equal(state.seen[filedIdentity(card("closed-before-card"))].disposition, "suppressed");
  assert.equal(Object.keys(state.events).length, 0);
});

test("new device baselines current calls without replaying queued events", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.result(new Error("uncertain")); f.cards([card("new-call")]); await f.service.tick();
  await f.service.enroll(device(2), subscription(2));
  const state = await f.owner.read(); assert.equal(Object.keys(state.outbox).length, 1);
  assert.ok(state.subscriptions[device(2)].baseline);
  f.advance(6000); await f.restart();
  assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[1].payload, f.sends[0].payload);
});

for (const suppression of ["answer", "queued", "pending", "parked", "replied"]) test(`fresh ${suppression} evidence suppresses and cancels unsent work permanently`, async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.result(new Error("uncertain")); f.cards([card("new-call")]); await f.service.tick();
  const evidence = input([card("new-call")], f.now);
  if (suppression === "answer") evidence.model.cards[0].answered = true;
  if (suppression === "queued") evidence.pending = [{ key: "decision:new-call" }];
  if (suppression === "parked") evidence.procrastination.until["merge:new-call"] = new Date(f.now + 60000).toISOString();
  if (suppression === "replied") evidence.model.cards[0].sentReceipt = "replied";
  if (suppression === "pending") evidence.receipts.pending = [{ request_id: "quarterdeck-call:synthetic", body: formatAnswerNote(answerEnvelope({ card: card("new-call", "(main)", "merge"), selection: "", note: "Synthetic answer" })) }];
  f.setEvidence(evidence); f.advance(6000); await f.service.tick();
  assert.equal(f.sends.length, 1); assert.equal(Object.values((await f.owner.read()).outbox)[0].state, "cancelled");
  f.cards([card("new-call")]); await f.restart(); assert.equal(f.sends.length, 1);
  f.cards([card("second-call")]); const suppressed = input([card("second-call")], f.now); suppressed.pending = [{ key: "decision:second-call" }]; f.setEvidence(suppressed); await f.service.tick();
  assert.equal(Object.values((await f.owner.read()).seen).find((entry) => entry.key === "decision:second-call").disposition, "suppressed");
  f.cards([card("second-call")]); await f.service.tick(); assert.equal(f.sends.length, 1);
});

test("unavailable/stale/absent inputs postpone, chat-only and unknown owners never count", async (t) => {
  const f = await fixture(t); f.setEvidence({ available: false });
  assert.equal((await f.service.enroll(device(), subscription())).state, "waiting-for-baseline");
  f.cards([card("old-call")]); await f.service.tick();
  f.setEvidence({ ...input([card("new-call")]), available: false }); await f.service.tick();
  f.setEvidence({ ...input([card("new-call")]), model: { ...model([card("new-call")]), state: "stale", stale: true } }); await f.service.tick();
  assert.equal(f.sends.length, 0);
  f.cards([card("new-call"), { key: "chat:123", type: "chat", task: "chat", owner: "(main)" }, card("unknown-call", null)]); await f.service.tick();
  assert.equal(f.sends.length, 1);
  f.cards([]); await f.service.tick(); f.cards([card("new-call")]); await f.service.tick(); assert.equal(f.sends.length, 1);
});

test("suppression is rechecked before provider call, and changed revision stops background demand", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  let reads = 0;
  await f.restart({ evidence: async () => { reads++; const result = input([card("new-call")], f.now); if (reads > 1) result.pending = [{ key: "decision:new-call" }]; return result; } });
  assert.equal(f.sends.length, 0); assert.equal(Object.values((await f.owner.read()).outbox)[0].state, "cancelled");
  f.revision(false); await f.service.tick(); assert.equal(f.listeners.size, 0); assert.equal(f.intervals.size, 0);
  assert.equal((await f.service.status(device())).state, "revision-unavailable");
});

test("provider retries keep identity and payload, respect delay/expiry, revoke and bound attempts", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.result({ statusCode: 429, retryAfter: "60" }); f.cards([card("retry-call")]); await f.service.tick();
  f.advance(59000); f.cards([card("retry-call")]); await f.service.tick(); assert.equal(f.sends.length, 1);
  f.advance(1000); f.result({ statusCode: 410 }); await f.restart();
  assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[0].payload, f.sends[1].payload); assert.equal(f.sends[1].options.ttl, 840);
  assert.equal((await f.service.status(device())).subscribed, false); assert.equal(f.listeners.size, 0);
  await f.service.enroll(device(), subscription(2)); f.result(new Error("uncertain")); f.cards([card("expiry-call")]); await f.service.tick();
  f.advance(900001); f.cards([card("expiry-call")]); await f.restart();
  assert.equal(f.sends.length, 3); assert.ok(Object.values((await f.owner.read()).outbox).some((item) => item.state === "expired"));
  f.cards([card("bounded-call")]); await f.service.tick();
  for (let n = 0; n < 8; n++) { f.advance(125000); f.cards([card("bounded-call")]); await f.service.tick(); }
  assert.equal(f.sends.filter((send) => send.payload.event === f.sends[3].payload.event).length, 5);
  assert.equal(retryDelay("120", 1, f.now, () => 0), 120000);
});

test("ambiguous in-flight restart waits its durable lease and retries the same event", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.result(new Error("lost receipt")); f.cards([card("new-call")]); await f.service.tick();
  await f.owner.update((state) => { const item = Object.values(state.outbox)[0]; item.state = "sending"; item.nextAt = f.now + 30000; });
  await f.restart(); assert.equal(f.sends.length, 1);
  f.advance(30000); f.cards([card("new-call")]); await f.service.tick(); assert.equal(f.sends.length, 2); assert.deepEqual(f.sends[0].payload, f.sends[1].payload);
});

test("durable state fails closed on lost/corrupt/unsafe owners and exclusive locks", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  const original = await readFile(f.paths.state);
  await unlink(f.paths.state); await f.restart(); assert.equal((await f.service.status(device())).state, "needs-repair"); assert.equal(f.listeners.size, 0);
  await writeFile(f.paths.state, original, { mode: 0o600 });
  await chmod(f.paths.state, 0o644); await assert.rejects(f.owner.read()); await chmod(f.paths.state, 0o600);
  await writeFile(f.paths.state, "bad"); await assert.rejects(f.owner.read());
  await writeFile(f.paths.state, original);
  await writeFile(`${f.paths.state}.lock`, "", { mode: 0o600 }); await assert.rejects(f.owner.update(() => {})); await unlink(`${f.paths.state}.lock`);
  await unlink(f.paths.state); await symlink(f.paths.keys, f.paths.state); await assert.rejects(f.owner.read());
});

test("capacity fails visibly and never prunes durable identities", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  await f.owner.update((state) => { for (let n = 0; n < 9999; n++) state.seen[digest(n)] = { key: `decision:old-${n}`, disposition: "baseline", detectedAt: f.now }; });
  f.cards([card("one-too-many")]); await f.service.tick(); assert.equal((await f.service.status(device())).state, "needs-repair");
  assert.equal(Object.keys((await f.owner.read()).seen).length, 10000); assert.equal(f.sends.length, 0);
});

test("supported endpoints reject arbitrary URLs/keys and private IPv4 addresses", () => {
  assert.ok(validSubscription(subscription())); assert.ok(pushEndpoint("https://web.push.apple.com/synthetic/path"));
  for (const url of ["https://localhost/wp/a", "http://fcm.googleapis.com/wp/a", "https://fcm.googleapis.com:443/wp/a", "https://fcm.googleapis.com.evil.invalid/wp/a", "https://fcm.googleapis.com/wp/a?x=1", "https://u@fcm.googleapis.com/wp/a", "https://fcm.googleapis.com/wp/a#x", "https://fcm.googleapis.com/wp/../a", "https://fcm.googleapis.com/", "https://push.apple.com//path"]) assert.equal(pushEndpoint(url), null, url);
  assert.ok(!validSubscription({ ...subscription(), arbitrary: "text" }));
  assert.ok(!validSubscription({ ...subscription(), keys: { ...subscription().keys, auth: "bad" } }));
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.1.2", "192.0.2.1", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("8.8.8.8"), true);
});

test("transport pins public DNS, encrypts with the library, rejects redirects and bounds responses", async () => {
  const vapid = { subject: "mailto:operator@example.invalid", publicKey: key.getPublicKey().toString("base64url"), privateKey: Buffer.alloc(32, 1).toString("base64url") };
  let requests = 0, captured;
  const request = (url, options, callback) => {
    requests++; captured = { url, options }; const req = new EventEmitter();
    req.destroy = (error) => { req.emit("error", error); req.emit("close"); };
    req.end = (body) => { captured.body = body; queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 302; response.headers = { location: "https://localhost/" }; callback(response); response.emit("end"); req.emit("close"); }); };
    return req;
  };
  await assert.rejects(createPushProvider(vapid, { resolve: async () => [{ address: "127.0.0.1", family: 4 }], request })(subscription(), {}, { ttl: 900, topic: "test" })); assert.equal(requests, 0);
  const send = createPushProvider(vapid, { resolve: async () => [{ address: "8.8.8.8", family: 4 }], request });
  assert.equal((await send(subscription(), { body: "Generic alert" }, { ttl: 900, topic: "test" })).statusCode, 302); assert.equal(requests, 1, "redirect was not followed");
  assert.equal(captured.options.agent, false); assert.equal(captured.options.headers["Content-Encoding"], "aes128gcm"); assert.ok(!captured.body.includes("Generic alert"));
  captured.options.lookup("fcm.googleapis.com", {}, (err, ip) => { assert.equal(err, null); assert.equal(ip, "8.8.8.8"); });
});

test("configuration is disabled without opt-in and rejects preview, unsafe origin/state/key ownership", async (t) => {
  const f = await fixture(t), home = path.join(path.dirname(f.paths.state), "home"); await mkdir(home);
  const env = { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(path.dirname(f.paths.state), "state.json"), FM_QUARTERDECK_PUSH_ORIGIN: "https://dashboard.example.invalid" };
  assert.equal(await notificationConfiguration(env), null);
  env.FM_QUARTERDECK_PUSH_ENABLED = "1";
  await assert.rejects(notificationConfiguration(env));
  await writeFile(f.paths.keys, JSON.stringify({ subject: "mailto:operator@example.invalid", publicKey: key.getPublicKey().toString("base64url"), privateKey: Buffer.alloc(32, 1).toString("base64url") }), { mode: 0o600 });
  assert.ok(await notificationConfiguration(env));
  for (const extra of [{ FM_PREVIEW_GENERATION: "synthetic" }, { FM_PREVIEW_COMMIT: "a".repeat(40) }, { FM_DEPLOYMENT_TIER: "uat" }, { FM_DEV: "1" }, { FM_QUARTERDECK_PUSH_ORIGIN: "https://dashboard.example.invalid/" }, { FM_QUARTERDECK_STATE_PATH: path.join(home, "state.json") }]) await assert.rejects(notificationConfiguration({ ...env, ...extra }));
  await chmod(f.paths.keys, 0o644); await assert.rejects(notificationConfiguration(env));
});

test("receipt failures remain explicit; strict pending and parked evidence never turn corruption into empty truth", async (t) => {
  const f = await fixture(t); let failed = false;
  const source = createCallSource({ home: "/synthetic", hub: { current: () => model([card()]) }, chat: { asks: () => [], view: () => ({ state: "ready", sources: [] }) }, receipts: async () => { if (failed) throw new Error("unavailable"); return { pending: [], handled: [], replies: [] }; } });
  assert.equal((await source.notificationEvidence()).available, true); failed = true; assert.equal((await source.notificationEvidence()).available, false);
  const env = { FM_QUARTERDECK_STATE_PATH: path.join(path.dirname(f.paths.state), "state.json") }, parked = createProcrastinationStore(env);
  await assert.rejects(parked.evidence()); await parked.initializeEvidence(); assert.deepEqual((await parked.evidence()).until, {});
  await writeFile(parked.file, "malformed"); await assert.rejects(parked.evidence()); await assert.rejects(parked.initializeEvidence());
  assert.deepEqual((await parked.read()).until, {}, "legacy UI fallback remains available");
  const batcher = createInboxBatcher({ home: "/synthetic", statePath: env.FM_QUARTERDECK_STATE_PATH }); t.after(() => batcher.close());
  await assert.rejects(batcher.pending({ strict: true })); await batcher.initializeEvidence(); assert.deepEqual(await batcher.pending({ strict: true }), []);
});

test("HTTP exact origin/host/schema/rate/revision boundaries keep subscription material private", async (t) => {
  const f = await fixture(t), origin = f.configuration.origin;
  let revision = "a".repeat(40);
  const server = createServer({ FM_QUARTERDECK_PUSH_ORIGIN: origin, FM_QUARTERDECK_STATE_PATH: path.join(path.dirname(f.paths.state), "state.json") }, {
    revisionResolver: { initial: revision, snapshot: async () => revision }, bearingsSource: { close() {} },
    notificationOptions: { configuration: f.configuration, source: f.source, evidence: async () => input([card()], f.now), initializeEvidence: async () => {}, timers: f.timers, now: () => f.now },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (operation, body = { id: device() }, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/notifications/${operation}`, { method: "POST", headers: { host: "dashboard.example.invalid", origin, "content-type": "application/json", ...headers } }, (response) => {
      let text = ""; response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text: async () => text, headers: { get: (key) => response.headers[key] } }));
    }); request.on("error", reject); request.end(JSON.stringify(body));
  });
  assert.equal((await post("status", undefined, { origin: "https://other.example.invalid" })).status, 403);
  assert.equal((await post("status", undefined, { host: "other.example.invalid" })).status, 403);
  assert.equal((await post("status", { id: device(), text: "arbitrary" })).status, 400);
  assert.equal((await post("send")).status, 400);
  assert.equal((await post("enroll", { id: device(), subscription: subscription() })).status, 200);
  const response = await post("status"); assert.equal(response.status, 200); const text = await response.text();
  assert.ok(!text.includes("fcm.googleapis.com")); assert.ok(!text.includes(subscription().keys.auth)); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/notifications-worker.js`)).status, 403);
  assert.equal((await post("disable")).status, 200);
  for (let n = 0; n < 30; n++) await post("status"); assert.equal((await post("status")).status, 429);
  revision = "b".repeat(40); assert.equal((await post("status")).status, 503);
});

 test("positive local resolution cancels unsent work; absent and stale receipt evidence never renew identity", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.result(new Error("unknown")); f.cards([card("resolved-call")]); await f.service.tick();
  f.advance(6000); f.cards([]); await f.service.tick(); assert.equal(Object.values((await f.owner.read()).outbox)[0].state, "retry");
  const evidence = input([], f.now); evidence.model.holds = [{ source: "data/backlog.md", task: "resolved-call", closed: true, open: false }];
  f.setEvidence(evidence); await f.service.tick(); assert.equal(Object.values((await f.owner.read()).outbox)[0].state, "cancelled");
  f.cards([card("resolved-call")]); await f.service.tick(); assert.equal(f.sends.length, 1);
  const stale = input([card("new-call")], f.now); stale.checkedAt = new Date(f.now - 16000).toISOString();
  assert.equal(eligibleView(stale, f.now), null);
});

test("final transport guard prevents sends after DNS when permission evidence or revision changes", async (t) => {
  const f = await fixture(t); await f.service.enroll(device(), subscription());
  f.configuration.provider = async (_subscription, _payload, options) => {
    f.setEvidence({ ...input([card("race-call")], f.now), pending: [{ key: "decision:race-call" }] });
    assert.equal(await options.beforeSend(), false);
    return { skipped: true };
  };
  f.cards([card("race-call")]); await f.service.tick();
  assert.equal(Object.values((await f.owner.read()).outbox)[0].state, "cancelled");
  assert.equal(f.sends.length, 0);
});

test("bounded transport stops before connection on its final guard and rejects excessive provider bytes", async () => {
  const vapid = { subject: "mailto:operator@example.invalid", publicKey: key.getPublicKey().toString("base64url"), privateKey: Buffer.alloc(32, 1).toString("base64url") };
  const resolve = async () => [{ address: "8.8.8.8", family: 4 }];
  let connected = 0;
  const request = (_url, _options, callback) => {
    connected++; const req = new EventEmitter();
    req.destroy = (error) => { req.emit("error", error); req.emit("close"); };
    req.end = () => { queueMicrotask(() => { const response = new EventEmitter(); response.statusCode = 201; response.headers = {}; callback(response); response.emit("data", Buffer.alloc(4097)); }); };
    return req;
  };
  const provider = createPushProvider(vapid, { resolve, request });
  assert.deepEqual(await provider(subscription(), {}, { ttl: 900, topic: "test", beforeSend: async () => false }), { skipped: true });
  assert.equal(connected, 0);
  assert.deepEqual(await provider(subscription(), {}, { ttl: 900, topic: "test", remainingTtl: () => 0 }), { skipped: true }); assert.equal(connected, 0);
  await assert.rejects(provider(subscription(), {}, { ttl: 900, topic: "test" }), /response too large/); assert.equal(connected, 1);
});

test("unavailable configuration never falsely acknowledges durable opt-out", async () => {
  const service = createNotificationService({ configuration: null });
  await assert.rejects(service.disable(device()), /opt-out was not recorded/);
  assert.equal((await service.status(device())).state, "operator-disabled"); service.close();
});
