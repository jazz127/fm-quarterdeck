import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../public/review-target.js", import.meta.url), "utf8")
  + "\n" + await readFile(new URL("../public/review-client.js", import.meta.url), "utf8");
const boot = "a".repeat(40), next = "b".repeat(40);
const ready = (version) => ({ ready: true, version, delivery: "local", sessionId: "", awaitingReview: 0 });
const tick = () => new Promise(setImmediate);

async function page({ bootRevision = boot, reply = ready(boot), draft = null, phone = false } = {}) {
  const nodes = new Map(), events = new Map(), values = new Map();
  const requests = [], intervals = [];
  let reloads = 0;
  if (draft) values.set("fm-agentos-review-draft-v1", JSON.stringify(draft));
  function node(tag = "div") {
    return {
      tagName: tag.toUpperCase(), className: "", value: "", textContent: "", hidden: false,
      listeners: {}, children: [], style: {}, isConnected: true,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(key, value) { this[key] = value; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      focus() { this.focused = true; },
    };
  }
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, Object.assign(node(), { id, hidden: id === "review-panel" }));
    return nodes.get(id);
  }
  const document = {
    body: node("body"), visibilityState: "visible", getElementById: element,
    createElement: node, querySelector: () => node(),
    addEventListener(type, fn) { events.set(type, fn); },
  };
  const location = { hash: "#lanes/demo", reload() { reloads++; } };
  const context = vm.createContext({
    document, location, setTimeout,
    window: { FM_BOOT_REVISION: bootRevision, innerHeight: 800, addEventListener() {},
      matchMedia: (query) => ({ matches: phone && query === "(max-width: 720px)", addEventListener() {} }) },
    crypto: { randomUUID: () => "123e4567-e89b-12d3-a456-426614174000" },
    sessionStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (reply instanceof Error) throw reply;
      return { ok: reply.status !== 503, status: reply.status || 200, json: async () => reply };
    },
  });
  vm.runInContext(script, context);
  await tick();
  const stack = document.body.children.find((child) => child.className === "app-notice-stack");
  const notice = stack.children.find((child) => child.className === "app-update-notice");
  return { context, document, element, stack, notice, requests, intervals, values, location,
    reloads: () => reloads,
    async foreground(newReply) {
      reply = newReply;
      events.get("visibilitychange")();
      await tick();
    },
    clickCapture: (event) => events.get("click")(event),
  };
}

test("boot mismatch shows one explicit reload notice, using only the existing configuration read", async () => {
  const app = await page({ reply: ready(next) });
  assert.equal(app.notice.hidden, false);
  assert.equal(app.notice.role, "status");
  assert.equal(app.notice.children[0].textContent, "Quarterdeck updated — reload to continue");
  assert.equal(app.notice.children[1].textContent, "Reload");
  assert.equal(app.reloads(), 0, "no automatic reload on first boot");
  assert.deepEqual(app.requests.map(({ url }) => url), ["/api/review"]);
  assert.equal(app.requests[0].options.cache, "no-store");
  assert.deepEqual(app.intervals.map(({ ms }) => ms), [5000], "only the existing review recovery timer");
  await app.foreground(ready(next));
  assert.equal(app.stack.children.filter((child) => child.className === "app-update-notice").length, 1);
  assert.equal(app.reloads(), 0, "foreground checks do not reload");
  app.notice.children[1].listeners.click();
  assert.equal(app.reloads(), 1);
  assert.equal(app.location.hash, "#lanes/demo", "reload leaves the route unchanged");
});

test("matching boot revision stays quiet; foreground mismatch is noticed and matching again clears it", async () => {
  const app = await page();
  assert.equal(app.notice.hidden, true);
  app.document.visibilityState = "hidden";
  await app.foreground(ready(next));
  assert.equal(app.requests.length, 1, "hidden documents do not check again");
  app.document.visibilityState = "visible";
  await app.foreground(ready(next));
  assert.equal(app.notice.hidden, false);
  await app.foreground(ready(boot));
  assert.equal(app.notice.hidden, true);
  assert.equal(app.reloads(), 0);
});

for (const [name, reply] of [
  ["503", { ...ready(next), status: 503 }],
  ["network failure", new Error("Unavailable")],
  ["not ready", { ...ready(next), ready: false }],
  ["non-string version", ready(null)],
]) {
  test(`${name} is unavailable, not an update`, async () => {
    const app = await page({ reply });
    assert.equal(app.notice.hidden, true);
    assert.match(app.element("review-state").textContent, /unavailable/);
    assert.equal(app.reloads(), 0);
  });
}

test("without an injected boot revision the notice stays quiet", async () => {
  const app = await page({ bootRevision: "", reply: ready(next) });
  assert.equal(app.notice.hidden, true);
});

test("a failed read after a confirmed mismatch retains the known update without reloading", async () => {
  const app = await page({ reply: ready(next) });
  await app.foreground({ status: 503 });
  assert.equal(app.notice.hidden, false);
  assert.match(app.element("review-state").textContent, /unavailable/);
  assert.equal(app.reloads(), 0);
});

test("update notice keeps composer text, queued notes, and original uncertain delivery identity", async () => {
  const entry = { kind: "message", text: "Queued synthetic note", region: null, route: "#lanes/demo", version: boot };
  const batchId = "123e4567-e89b-12d3-a456-426614174000";
  const retry = { id: batchId, payload: { schema: "fm-agentos-review.v1", batchId, version: boot,
    route: "#lanes/demo", sessionId: "", end: false, entries: [entry] } };
  const app = await page({ draft: { queue: [entry], queueIds: ["note-1"], sent: [],
    message: "Unsent composer draft", open: false, selected: null, retryBatches: [retry] } });
  await app.foreground(ready(next));
  assert.equal(app.notice.hidden, false);
  assert.equal(app.element("review-message").value, "Unsent composer draft");
  const saved = JSON.parse(app.values.get("fm-agentos-review-draft-v1"));
  assert.equal(saved.queue[0].prompt, entry.text, "existing v1-to-v2 draft conversion retains note text");
  assert.deepEqual(saved.queueIds, ["note-1"]);
  assert.equal(saved.queue[0].version, next, "existing draft version rebinding is unchanged");
  assert.deepEqual(saved.retryBatches, [retry], "uncertain payload and ID never rebound or retried");
  assert.deepEqual([...app.values.keys()], ["fm-agentos-review-draft-v1"], "no storage namespace added");
  assert.equal(app.reloads(), 0);
  assert.ok(app.requests.every(({ url }) => url === "/api/review"), "notice never sends drafts");
});

test("notice is stacked separately from the picker and Reload bypasses annotation click capture", async () => {
  const app = await page({ reply: ready(next), phone: true });
  const picker = app.stack.children.find((child) => child.className === "review-pick-notice");
  picker.hidden = false;
  assert.notEqual(app.notice, picker, "update banner must not steal picker close focus");
  assert.equal(app.stack.children.length, 2);
  vm.runInContext('pickingRegion = true; annotateByDefault = true; activeReviewTab = "annotation";', app.context);
  app.element("review-panel").hidden = false;
  app.clickCapture({ button: 0, detail: 1,
    target: { closest: (selector) => selector.includes(".app-update-notice") },
    preventDefault() { assert.fail("Reload click must not be prevented"); },
    stopImmediatePropagation() { assert.fail("Reload click must reach its button"); },
  });
  app.notice.children[1].listeners.click();
  assert.equal(app.reloads(), 1);
  const css = await readFile(new URL("../public/shell-panel.css", import.meta.url), "utf8");
  assert.match(css, /\.app-notice-stack \{[^}]*display: grid;[^}]*gap: 8px;/);
  assert.match(css, /\.review-pick-notice\[hidden\], \.app-update-notice\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.review-pick-notice, \.app-update-notice \{[^}]*display: flex;/);
});
