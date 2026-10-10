import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fakeTimers } from "./helpers/call-dom.js";

const code = await readFile(new URL("../public/bearings-live.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ streamAllowed = true, bootRevision = "a".repeat(40), fetchFails = false, fetchResponse, sourceThrows = 0 } = {}) {
  const sources = [];
  class FakeEventSource {
    constructor(url) {
      if (sourceThrows > 0) { sourceThrows -= 1; throw new Error("stream construction refused"); }
      this.url = url; this.listeners = new Map(); this.closed = false; sources.push(this);
    }
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
    if (fetchResponse) return fetchResponse(url);
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

test("EventSource construction failures use the same backoff and polling fallback", async () => {
  const { live, sources, fetches, seen, timers } = setup({ sourceThrows: Infinity });
  live.start();
  await flush();
  assert.equal(live.connected, false);
  assert.equal(seen.connection.at(-1), "reconnecting");
  assert.equal(seen.lost, 1);
  timers.advance(3000);
  await flush();
  assert.equal(seen.lost, 2);
  timers.advance(10000);
  await flush();
  assert.equal(seen.lost, 3);
  const polled = fetches.length;
  timers.advance(15000);
  await flush();
  assert.ok(fetches.length > polled, "HTTP polling remains active when the constructor keeps throwing");
  assert.equal(seen.lost, 3, "the third retry waits the full 30 seconds");
  timers.advance(15000);
  await flush();
  assert.equal(seen.lost, 4);
  assert.equal(sources.length, 0);
  live.stop();
  assert.equal(timers.pending(), 0);
});

test("a refused EventSource construction can recover without a reload", async () => {
  const { live, sources, seen, timers } = setup({ sourceThrows: 1 });
  live.start();
  await flush();
  assert.equal(seen.connection.at(-1), "reconnecting");
  timers.advance(3000);
  await flush();
  assert.equal(sources.length, 1);
  sources[0].emit("hello", { servedCommit: "a".repeat(40) });
  assert.equal(seen.connection.at(-1), "live");
  assert.equal(live.connected, true);
  assert.equal(timers.pending(), 0);
  live.stop();
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

function deferredResponse() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, reject, resolve: (rev) => resolve({ ok: true, json: async () => ({ rev, cards: [] }) }) };
}

test("suspending during catch-up ignores its late response and does not reopen on pagehide", async () => {
  for (const action of ["stop", "hidden", "pagehide"]) {
    const pending = deferredResponse();
    const { live, sources, seen, doc, docListeners, winListeners } = setup({ fetchResponse: () => pending.promise });
    live.start();
    if (action === "stop") live.stop();
    if (action === "hidden") { doc.visibilityState = "hidden"; docListeners.get("visibilitychange")(); }
    if (action === "pagehide") winListeners.get("pagehide")();
    pending.resolve("late");
    await flush();
    assert.equal(seen.models.length, 0, action);
    assert.equal(sources.length, 0, action);
    assert.equal(seen.connection.at(-1), "paused", action);
  }
});

test("a late failure after suspension does not replace paused status", async () => {
  const pending = deferredResponse();
  const { live, seen } = setup({ fetchResponse: () => pending.promise });
  live.start();
  live.stop();
  pending.reject(new Error("offline"));
  await flush();
  assert.equal(seen.connection.at(-1), "paused");
});

test("out-of-order catch-ups cannot roll back a newer reading", async () => {
  const pending = [];
  const { live, seen } = setup({ fetchResponse: () => { const read = deferredResponse(); pending.push(read); return read.promise; } });
  const first = live.refresh();
  const second = live.refresh();
  pending[1].resolve("newer");
  await second;
  pending[0].resolve("older");
  await first;
  assert.deepEqual(seen.models.map(model => model.rev), ["newer"]);
  assert.equal(live.rev, "newer");
});

test("stop/start isolates the new catch-up from the previous lifecycle", async () => {
  const pending = [];
  const { live, sources, seen } = setup({ fetchResponse: () => { const read = deferredResponse(); pending.push(read); return read.promise; } });
  live.start();
  live.stop();
  live.start();
  pending[0].resolve("old-lifecycle");
  await flush();
  assert.equal(seen.models.length, 0);
  assert.equal(sources.length, 0, "the previous resume continuation must not open a stream");
  pending[1].resolve("current-lifecycle");
  await flush();
  assert.deepEqual(seen.models.map(model => model.rev), ["current-lifecycle"]);
  assert.equal(sources.length, 1);
});

test("a pushed model supersedes an in-flight catch-up", async () => {
  const pending = deferredResponse();
  let initial = true;
  const { live, sources, seen } = setup({ fetchResponse: () => {
    if (!initial) return pending.promise;
    initial = false;
    return { ok: true, json: async () => ({ rev: "r1", cards: [] }) };
  } });
  live.start();
  await flush();
  const refresh = live.refresh();
  sources[0].emit("model", { rev: "r3", cards: [] });
  pending.resolve("r2");
  await refresh;
  assert.deepEqual(seen.models.map(model => model.rev), ["r1", "r3"]);
  assert.equal(live.rev, "r3");
});

test("queued events from a closed stream cannot affect its replacement", async () => {
  const { live, sources, seen, timers, winListeners } = setup();
  live.start();
  await flush();
  const closed = sources[0];
  winListeners.get("pagehide")();
  winListeners.get("pageshow")();
  await flush();
  const current = sources[1];
  current.emit("hello", { servedCommit: "a".repeat(40) });
  const models = seen.models.length, observed = seen.observed.length;
  for (const event of ["hello", "model", "observed", "revision", "bye"]) {
    closed.emit(event, { servedCommit: "b".repeat(40), rev: "obsolete", cards: [] });
  }
  closed.onerror();
  await flush();
  assert.equal(current.closed, false);
  assert.equal(sources.length, 2);
  assert.equal(seen.models.length, models);
  assert.equal(seen.observed.length, observed);
  assert.equal(seen.revision, 0);
  assert.equal(seen.connection.at(-1), "live");
  assert.equal(timers.pending(), 0);
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
