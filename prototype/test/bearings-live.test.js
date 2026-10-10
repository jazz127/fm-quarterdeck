import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fakeTimers } from "./helpers/call-dom.js";

const code = await readFile(new URL("../public/bearings-live.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ streamAllowed = true, bootRevision = "a".repeat(40), fetchFails = false } = {}) {
  const sources = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; sources.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
  }
  const docListeners = new Map();
  const winListeners = new Map();
  const doc = { visibilityState: "visible", addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: (type) => docListeners.delete(type) };
  const win = { addEventListener: (type, fn) => winListeners.set(type, fn), removeEventListener: (type) => winListeners.delete(type) };
  const fetches = [];
  const fetchImpl = async (url) => {
    fetches.push(url);
    if (fetchFails) throw new Error("offline");
    return { ok: true, json: async () => url.includes("since=") ? { unchanged: true, rev: "r1", state: "ready" } : { rev: "r1", state: "ready", cards: [] } };
  };
  const context = vm.createContext({ window: {} });
  vm.runInContext(code, context);
  const seen = { models: [], observed: [], connection: [], revision: 0, lost: 0 };
  const timers = fakeTimers();
  const live = context.window.bearingsLive.createBearingsLive({
    onModel: (model) => seen.models.push(model), onObserved: (data) => seen.observed.push(data), onConnection: (state) => seen.connection.push(state.state),
    onRevision: () => { seen.revision += 1; }, onStreamLost: () => { seen.lost += 1; },
    doc, win, EventSourceImpl: FakeEventSource, fetchImpl, bootRevision, streamAllowed, timers,
  });
  return { live, sources, fetches, seen, doc, docListeners, winListeners, timers };
}

test("a visible host tab catches up, opens one stream, and applies pushed models and freshness", async () => {
  const { live, sources, fetches, seen } = setup();
  live.start();
  await flush();
  assert.deepEqual(fetches, ["/api/bearings"]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, "/api/bearings/stream");
  sources[0].emit("hello", { servedCommit: "a".repeat(40) });
  assert.equal(seen.connection.at(-1), "live");
  sources[0].emit("model", { rev: "r2", cards: [{ key: "decision:alpha-call" }] });
  sources[0].emit("observed", { rev: "r2", state: "ready" });
  assert.deepEqual(seen.models.map((model) => model.rev), ["r1", "r2"]);
  assert.equal(seen.observed.at(-1).rev, "r2");
  assert.equal(live.rev, "r2");
});

test("hidden tabs hold no stream; returning catches up with ?since and reopens", async () => {
  const { live, sources, fetches, doc, docListeners, winListeners } = setup();
  live.start();
  await flush();
  doc.visibilityState = "hidden";
  docListeners.get("visibilitychange")();
  assert.equal(sources[0].closed, true);
  doc.visibilityState = "visible";
  docListeners.get("visibilitychange")();
  await flush();
  assert.equal(fetches.at(-1), "/api/bearings?since=r1");
  assert.equal(sources.length, 2);
  winListeners.get("pagehide")();
  assert.equal(sources[1].closed, true);
});

test("a served-revision change rebinds this document and restores the feed", async () => {
  const first = setup();
  first.live.start();
  await flush();
  first.sources[0].emit("hello", { servedCommit: "b".repeat(40) });
  assert.equal(first.seen.revision, 1, "update notice once for the new commit");
  assert.equal(first.sources[0].closed, false, "the connected stream is the new process");
  assert.equal(first.seen.connection.at(-1), "live");
  first.sources[0].emit("model", { rev: "r2", cards: [] });
  assert.equal(first.live.rev, "r2");
  first.timers.advance(120000);
  assert.equal(first.sources.length, 1, "a rebound stream stays up without a reload");

  const second = setup();
  second.live.start();
  await flush();
  second.sources[0].emit("hello", { servedCommit: "a".repeat(40) });
  second.sources[0].emit("revision", {});
  assert.equal(second.seen.revision, 1);
  assert.equal(second.sources[0].closed, true);
  assert.equal(second.seen.connection.at(-1), "revision");
  second.timers.advance(2999);
  assert.equal(second.sources.length, 1, "backoff holds the first retry");
  second.timers.advance(1);
  await flush();
  assert.equal(second.sources.length, 2, "a revision close retries instead of latching");
  second.sources[1].emit("hello", { servedCommit: "c".repeat(40) });
  assert.equal(second.seen.revision, 2);
  assert.equal(second.sources[1].closed, false);
  assert.equal(second.seen.connection.at(-1), "live");

  const third = setup();
  third.live.start();
  await flush();
  third.sources[0].emit("revision", {});
  third.doc.visibilityState = "hidden";
  third.docListeners.get("visibilitychange")();
  third.timers.advance(120000);
  assert.equal(third.sources.length, 1, "a hidden tab does not reconnect");
  third.doc.visibilityState = "visible";
  third.docListeners.get("visibilitychange")();
  await flush();
  assert.equal(third.sources.length, 2, "returning after a revision stop reopens");
  third.sources[1].emit("hello", { servedCommit: "b".repeat(40) });
  assert.equal(third.seen.connection.at(-1), "live");
});

test("stream errors fall back to 15 s polling and retry with 3 s, 10 s, then 30 s backoff", async () => {
  const { live, sources, fetches, seen, timers } = setup();
  live.start();
  await flush();
  sources[0].onerror();
  assert.equal(sources[0].closed, true, "EventSource's own retry is taken over");
  assert.equal(seen.lost, 1, "the update notice check runs on stream loss");
  timers.advance(2999);
  assert.equal(sources.length, 1);
  timers.advance(1);
  await flush();
  assert.equal(sources.length, 2);
  sources[1].onerror();
  timers.advance(9999);
  await flush();
  assert.equal(sources.length, 2);
  timers.advance(1);
  await flush();
  assert.equal(sources.length, 3);
  sources[2].onerror();
  sources[2].onerror();
  const polled = fetches.length;
  timers.advance(15000);
  await flush();
  assert.ok(fetches.length > polled, "polls while the stream is down");
  timers.advance(15000);
  await flush();
  assert.equal(sources.length, 4, "third failure waits 30 s");
  sources[3].emit("hello", { servedCommit: "a".repeat(40) });
  assert.equal(seen.connection.at(-1), "live");
});

test("previews never open a stream and poll with ?since instead", async () => {
  const { live, sources, fetches, timers } = setup({ streamAllowed: false });
  live.start();
  await flush();
  assert.equal(sources.length, 0);
  timers.advance(15000);
  await flush();
  assert.deepEqual(fetches, ["/api/bearings", "/api/bearings?since=r1"]);
});

test("the server's recycle bye reconnects immediately", async () => {
  const { live, sources } = setup();
  live.start();
  await flush();
  sources[0].emit("bye", {});
  await flush();
  assert.equal(sources[0].closed, true);
  assert.equal(sources.length, 2);
});
