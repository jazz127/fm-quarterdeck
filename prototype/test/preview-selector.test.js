import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/preview-selector.js", import.meta.url), "utf8");
const versionSource = await readFile(new URL("../public/sidebar-version.js", import.meta.url), "utf8");
const commit = "a".repeat(40);
const versions = () => [
  { id: "main", name: "Main", branch: "main", state: "ready" },
  { id: "dev-one", name: "One", branch: "dev/one", state: "stopped" },
  { id: "dev-two", name: "Two", branch: "dev/two", state: "stopped" },
].map((e) => ({ ...e, commit, validation: "captured", freshness: "unknown", reason: "Fixture" }));
async function browser({ current = "main", host, servedCommit, saved = new Map(), initial, withSidebarVersion = false } = {}) {
  const all = [], callbacks = [], writes = [], navigations = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.value = ""; all.push(this); }
    get options() { return this.children; }
    append(...children) { this.children.push(...children); children.forEach((child) => { child.parent = this; }); }
    insertBefore(child) { this.children.push(child); }
    querySelector(selector) { return this.children.find(child => `.${child.className}` === selector) || null; }
    click() { return this.fire("click"); }
    setAttribute(key, value) { this[key] = value; }
    addEventListener(key, fn) { this.events[key] = fn; }
    fire(key) { return this.events[key]?.({ preventDefault() {} }); }
  }
  const sidebar = new Element("aside"), feed = new Element("section"), workspace = new Element("main");
  const sideVersion = withSidebarVersion ? new Element("button") : null;
  if (sideVersion) {
    sideVersion.id = "sidebar-version";
    for (const name of ["source", "publication", "hash"]) {
      const span = new Element("span"); span.className = `sidebar-version-${name}`; sideVersion.append(span);
    }
  }
  let entries = initial || versions(), blockDelivery;
  const context = {
    document: { hidden: false, createElement: (tag) => new Element(tag), querySelector: (selector) => selector === ".workspace" ? workspace : selector === ".lane-list" ? sidebar : selector === ".feed-actions" ? feed : selector === "#sidebar-version" ? sideVersion : null },
    sessionStorage: { getItem: (key) => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) },
    location: { hash: "#lanes/general/session/task-123", assign: (url) => navigations.push(url) },
    setInterval: (fn) => callbacks.push(fn),
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    fetch: async (url, options) => {
      if (options?.method === "POST") {
        writes.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith("/chat")) {
          await new Promise((r) => { blockDelivery = r; });
          return { ok: false, json: async () => ({ error: "Unconfigured" }) };
        }
        const entry = entries.find((e) => e.id === JSON.parse(options.body).id);
        if (!["ready", "idling"].includes(entry.state)) { entry.state = "starting"; entry.operation = "generation"; }
        return { ok: true, json: async () => ({ ...entry, accepted: true }) };
      }
      return { ok: true, json: async () => structuredClone(entries) };
    },
  };
  context.window = { FM_PREVIEW_ID: current, FM_HOST_ID: host, FM_SERVED_COMMIT: servedCommit, fetch: context.fetch,
    fmChatViewContext: ({ branch, commit }) => ({ schema: "fm-agentos-chat-view.v1", capturedAt: "2026-01-01T00:00:00Z", route: context.location.hash,
      served: { branch, commit }, lanes: [{ id: "general", name: "General" }], filters: { kinds: ["captain"], search: "", searchTruncated: false, session: "", diskSession: "", page: 0 },
      visible: { first: null, last: null, focused: null } }) };
  // Browser global fetch assignment and window.fetch share the same binding.
  Object.defineProperty(context, "fetch", { get: () => context.window.fetch, set: (value) => { context.window.fetch = value; } });
  if (sideVersion) vm.runInNewContext(versionSource, context);
  await vm.runInNewContext(source, context);
  return { all, saved, entries, writes, navigations, workspace, tick: async () => { for (const fn of callbacks) await fn(); await flush(); },
    byId: (id) => all.find((e) => e.id === id), byText: (text) => all.find((e) => e.textContent === text),
    finishDelivery: () => blockDelivery?.() };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test("desktop footer discloses full selector without changing active route, drafts, or lifecycle", async () => {
  const saved = new Map([["fm-preview-chat-draft", "chat draft"], ["fm-agentos-review-draft-v1", "annotation draft"]]);
  const b = await browser({ current: "dev-one", saved });
  const footer = b.workspace.children.find((e) => e.tag === "footer");
  const toggle = b.byId("preview-toggle"), details = b.byId("preview-details");
  assert.equal(footer.getAttribute?.("aria-label") || footer["aria-label"], "Version footer");
  assert.equal(b.all.find((e) => e.tag === "textarea").placeholder, "Message firstmate");
  assert.equal(details.hidden, true);
  assert.equal(toggle["aria-expanded"], "false");
  assert.equal(toggle["aria-controls"], "preview-details");
  assert.match(b.byId("preview-active").textContent, /^One · remote · a{12}$/);
  assert.match(b.byId("preview-active").title, /Full revision a{40}/);
  assert.doesNotMatch(b.byId("preview-active").textContent, /checkpoint|captured|Fixture|dev-two/);
  toggle.fire("click");
  assert.equal(details.hidden, false);
  assert.equal(toggle["aria-expanded"], "true");
  assert.equal(b.byId("preview-selector").options.length, 3);
  assert.match(b.byId("preview-identity").textContent, /published checkpoint.*captured/);
  toggle.fire("click");
  assert.equal(details.hidden, true);
  assert.equal(saved.get("fm-preview-footer-expanded"), "false");
  assert.equal(saved.get("fm-preview-chat-draft"), "chat draft");
  assert.equal(saved.get("fm-agentos-review-draft-v1"), "annotation draft");
  assert.deepEqual(b.navigations, []); assert.deepEqual(b.writes, []);
  const again = await browser({ saved });
  assert.equal(again.byId("preview-details").hidden, true);
  again.byId("preview-toggle").fire("click");
  assert.equal((await browser({ saved })).byId("preview-details").hidden, false);
});

test("served commit remains the displayed identity even if registry tip changes", async () => {
  const old = "b".repeat(40);
  const b = await browser({ current: "dev-one", servedCommit: old });
  assert.equal(b.byId("preview-active").textContent, `One · remote · ${old.slice(0, 12)}`);
  assert.equal(b.byId("preview-active").title, `Full revision ${old}; One remote.`);
  assert.doesNotMatch(b.byId("preview-active").textContent, new RegExp(old.slice(12)));
});

test("collapsed identity is served version, not pending target, and flags failures on warm Main", async () => {
  const b = await browser();
  b.byId("preview-selector").value = "dev-two";
  b.byId("preview-selector").fire("change"); await flush();
  assert.match(b.byId("preview-active").textContent, /^Main · local · a{12} · Starting$/);
  assert.doesNotMatch(b.byId("preview-active").textContent, /Two/);
  b.entries[2].state = "busy"; await b.tick();
  assert.match(b.byId("preview-active").textContent, /Busy/);
  assert.doesNotMatch(b.byId("preview-active").textContent, /Active:|Candidate/);
  b.entries[2].state = "failed"; b.entries[2].previous = "dev-one"; await b.tick();
  assert.match(b.byId("preview-active").textContent, /Main · local.*Failed.*Main warm/);
  assert.deepEqual(b.navigations, []);
});

test("footer layout reserves a grid row on desktop and preserves mobile top controls", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-rows: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.preview-control \{[^}]*grid-column: 1 \/ -1; grid-row: 2/);
  assert.match(css, /\.preview-details \{[^}]*max-height: min\(32dvh, 220px\); overflow-y: auto/);
  assert.match(css, /\.preview-details\[hidden\] \{ display: none/);
  assert.match(css, /#preview-toggle:focus-visible/);
  assert.match(css, /\.preview-heading \{[^}]*display: flex/);
  assert.match(css, /\.preview-details\[hidden\] \{ display: none !important/);
  assert.match(css, /\.preview-details:not\(\[hidden\]\) \{ display: grid !important/);
  assert.match(css, /\.workspace:has\(\.preview-control\) \.main-stage \{ padding-top: calc\(48px \+ 33px\); \}/);
  assert.match(css, /\.main-stage \{ height: calc\(100dvh - 96px\); padding-top: 48px/);
});

test("stopped selection sends only ID, waits through Busy/Starting and exact Ready before hash navigation", async () => {
  const b = await browser(), select = b.byId("preview-selector");
  select.value = "dev-one"; select.fire("change"); await flush();
  assert.deepEqual(b.writes[0], { url: "/api/previews/select", body: { id: "dev-one" } });
  assert.deepEqual(b.navigations, []);
  b.entries[1].state = "busy"; await b.tick();
  assert.match(b.byId("preview-status").textContent, /Busy/); assert.deepEqual(b.navigations, []);
  b.entries[1].state = "starting"; await b.tick(); assert.deepEqual(b.navigations, []);
  b.entries[1].state = "ready"; await b.tick();
  assert.deepEqual(b.navigations, ["/preview/dev-one/#lanes/general/session/task-123"]);
});

test("failed replacement falls back to Main with one-click retry/previous, retaining both draft stores", async () => {
  const saved = new Map([["fm-preview-chat-draft", "unsent chat"], ["fm-agentos-review-draft-v1", "annotation fixture"]]);
  const b = await browser({ current: "dev-one", saved });
  const select = b.byId("preview-selector"); select.value = "dev-two"; select.fire("change"); await flush();
  b.entries[2].state = "failed"; b.entries[2].previous = "dev-one"; await b.tick();
  assert.deepEqual(b.navigations, ["/preview/main/#lanes/general/session/task-123"]);
  assert.equal(saved.get("fm-preview-chat-draft"), "unsent chat"); assert.equal(saved.get("fm-agentos-review-draft-v1"), "annotation fixture");
  const fallback = await browser({ saved, initial: b.entries });
  assert.equal(fallback.byId("preview-selector").value, "dev-two");
  assert.equal(fallback.byText("Restart One").hidden, false);
  fallback.byText("Retry start").fire("click"); await flush();
  assert.equal(fallback.writes[0].body.id, "dev-two");
  assert.equal(fallback.all.find((e) => e.tag === "textarea").value, "unsent chat");
});

test("UAT-host selector switches to local Staging and falls back to UAT, never Main", async () => {
  const initial = [
    { id: "uat", name: "UAT", branch: "uat", state: "ready", commit, validation: "accepted", reason: "Local UAT" },
    { id: "stg", name: "Staging", branch: "stg", state: "stopped", commit, validation: "captured", reason: "Select to start" },
  ];
  const b = await browser({ current: "uat", initial });
  assert.equal(b.byText("Local UAT")?.tag, "button");
  assert.equal(b.byId("preview-selector").options.length, 2);
  assert.match(b.byId("preview-active").textContent, /^UAT · local · a{12}$/);
  b.byId("preview-selector").value = "stg"; b.byId("preview-selector").fire("change"); await flush();
  b.entries[1].state = "ready"; await b.tick();
  assert.deepEqual(b.navigations, ["/preview/stg/#lanes/general/session/task-123"]);
  const staged = await browser({ current: "stg", initial: initial.map((entry) => ({ ...entry, state: entry.id === "stg" ? "stopped" : "ready" })) });
  staged.byId("preview-selector").value = "stg";
  staged.byId("preview-selector").fire("change"); await flush();
  staged.entries[1].state = "failed"; await staged.tick();
  assert.deepEqual(staged.navigations, ["/preview/uat/#lanes/general/session/task-123"]);
  assert.ok(staged.byId("preview-active").textContent.includes("Staging"));
});

test("this tab cannot navigate during delivery; a failed send retains persisted chat", async () => {
  const b = await browser();
  const input = b.all.find((e) => e.tag === "textarea"); input.value = "keep me"; input.fire("input");
  const delivery = b.all.find((e) => e.tag === "form").fire("submit"); await flush();
  b.byText("Warm Main").fire("click"); await flush(); assert.deepEqual(b.navigations, []);
  assert.match(b.byId("preview-status").textContent, /delivery/);
  b.finishDelivery(); await delivery;
  assert.equal(b.saved.get("fm-preview-chat-draft"), "keep me"); assert.equal(input.value, "keep me");
  const sent = b.writes[0].body;
  assert.equal(sent.text, "keep me"); assert.equal(sent.viewContext.served.branch, "main");
  assert.ok(b.saved.has("fm-preview-chat-pending"));
  const restored = await browser({ saved: b.saved });
  const retry = restored.all.find((e) => e.tag === "form").fire("submit"); await flush();
  assert.equal(restored.writes[0].body.messageId, sent.messageId);
  assert.deepEqual(restored.writes[0].body.viewContext, sent.viewContext);
  restored.finishDelivery(); await retry;
});

test("compact sidebar version uses served source, publication checkpoint and six hash chars", async () => {
  const uat = { id: "uat", name: "UAT", branch: "uat", commit, remoteCheckpoint: commit, relation: "equal", state: "ready", reason: "Fixture" };
  const main = { ...uat, id: "main", name: "Main", branch: "main" };
  const local = await browser({ current: "uat", host: "uat", initial: [uat], withSidebarVersion: true });
  const button = local.byId("sidebar-version");
  assert.equal(button.hidden, false);
  assert.equal(button.querySelector(".sidebar-version-source").textContent, "UAT");
  assert.equal(button.querySelector(".sidebar-version-hash").textContent, commit.slice(0, 6));
  assert.match(button.querySelector(".sidebar-version-publication").innerHTML, /<svg/);
  assert.doesNotMatch(button.querySelector(".sidebar-version-publication").innerHTML, /M3 21 21 3/);
  assert.match(button["aria-label"], new RegExp(`UAT, local, published, full revision ${commit}`));
  button.fire("click");
  assert.equal(local.byId("preview-details").hidden, false, "version button opens existing selector without a new lifecycle action");
  assert.deepEqual(local.writes, []);
  const origin = await browser({ current: "uat", host: "main", initial: [main, { ...uat, remoteCheckpoint: null, relation: "absent" }], withSidebarVersion: true });
  const originButton = origin.byId("sidebar-version");
  assert.equal(originButton.querySelector(".sidebar-version-source").textContent, "UAT");
  assert.match(originButton.querySelector(".sidebar-version-publication").innerHTML, /M3 21 21 3/);
  assert.match(originButton["aria-label"], new RegExp(`UAT, origin, unpublished, full revision ${commit}`));
  const uncertain = await browser({ current: "uat", host: "main", initial: [main, { ...uat, remoteCheckpoint: "b".repeat(40), relation: "unknown" }], withSidebarVersion: true });
  assert.match(uncertain.byId("sidebar-version")["aria-label"], /publication unverified/);
  assert.doesNotMatch(uncertain.byId("sidebar-version").querySelector(".sidebar-version-publication").innerHTML, /<svg/);
});
