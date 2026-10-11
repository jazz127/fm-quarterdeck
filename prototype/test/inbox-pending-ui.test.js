import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../public/inbox-pending.js", import.meta.url), "utf8");
const tick = () => new Promise(setImmediate);
function fixture() {
  const nodes = new Map(), requests = [], events = [];
  let records = [{ key: "example-app-call", text: "Option A with its call context" }, { key: "acme-thread", text: "Ordinary thread note" }];
  let release, fail = false, refresh;
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", disabled: false, hidden: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, createElement: () => ({ style: {}, append() {} }), addEventListener() {} },
    window: { addEventListener() {}, dispatchEvent(event) { events.push(event.type); } }, Event,
    setInterval(fn) { refresh = fn; },
    fetch: async (url, options) => {
      requests.push({ url, method: options?.method || "GET" });
      if (options?.method === "POST") return new Promise((resolve) => { release = () => { if (!fail) records = []; resolve({ ok: !fail }); }; });
      return { ok: true, json: async () => ({ items: records }) };
    },
  });
  vm.runInContext(script, context);
  return { element, requests, events, provider: context.window.quarterdeckInboxPending, refresh: () => refresh(), release: () => release(), fail: () => { fail = true; } };
}

test("composer pending provider coalesces flushes without resubmitting or changing saved items", async () => {
  const f = fixture(); await tick();
  assert.equal(f.provider.count(), 2);
  await f.refresh();
  assert.equal(f.events.length, 1, "unchanged counts do not rerender Review");
  const first = f.provider.flush(), second = f.provider.flush();
  assert.equal(first, second);
  assert.equal(f.element("inbox-pending-send").disabled, true);
  assert.deepEqual(f.requests.filter((r) => r.method === "POST"), [{ url: "/api/inbox/send-now", method: "POST" }]);
  f.release(); await first;
  assert.equal(f.provider.count(), 0);
  assert.equal(f.element("inbox-pending").hidden, true);
});

test("failed pending flush retains the saved count and shows an explicit retry reason", async () => {
  const f = fixture(); await tick(); f.fail();
  const send = f.provider.flush(); f.release(); await send;
  assert.equal(f.provider.count(), 2);
  assert.equal(f.element("inbox-pending-send").disabled, false);
  assert.match(f.element("inbox-pending-status").textContent, /unconfirmed.*retained/);
});
