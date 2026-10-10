import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "../server.js";
import { createProcrastinationStore, procrastinationPath } from "../call-procrastination.js";
import { callDom, fakeTimers } from "./helpers/call-dom.js";

const KEY = "decision:alpha-call";
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test("procrastination extends a future return, expires, and drops calls Firstmate resolved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-proc-"));
  const state = path.join(root, "presentation.json");
  let now = Date.parse("2026-06-01T00:00:00Z");
  const store = createProcrastinationStore({ FM_QUARTERDECK_STATE_PATH: state }, () => now);
  try {
    assert.equal(path.dirname(procrastinationPath({ FM_QUARTERDECK_STATE_PATH: state })), root);
    const first = await store.set(KEY, "3h");
    assert.equal(first.schema, "fm-quarterdeck-call-procrastination.v1");
    assert.equal(first.until[KEY], "2026-06-01T03:00:00.000Z");
    const extended = await store.set(KEY, "6h");
    assert.equal(extended.until[KEY], "2026-06-01T09:00:00.000Z");
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.equal((await store.view(new Set([KEY]))).until[KEY], "2026-06-01T09:00:00.000Z", "naming the open card key keeps it across a revision");
    now = Date.parse("2026-06-01T08:00:00.000Z");
    assert.equal((await store.view(null)).until[KEY], "2026-06-01T09:00:00.000Z", "a loading model does not drop an open call");
    assert.deepEqual((await store.view(new Set())).until, {}, "a resolved call leaves the backlog");
    now = Date.parse("2026-06-01T00:00:00Z");
    await store.set(KEY, "1d");
    assert.deepEqual((await store.clear(KEY)).until, {});
    await assert.rejects(() => store.set("not a key", "3h"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("procrastinate HTTP stays in Quarterdeck state and refuses a bad body, origin, or closed call", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "qd-proc-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-proc-state-"));
  const statePath = path.join(root, "presentation.json");
  const revision = "c".repeat(40);
  let now = Date.parse("2026-06-01T00:00:00Z");
  const cards = [{ key: KEY, type: "decision" }];
  let state = "ready";
  const bearingsSource = { current: () => ({ state, cards: state === "loading" ? [] : cards }), close() {} };
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: statePath }, {
    revisionResolver: { initial: revision, snapshot: async () => revision },
    bearingsSource,
    procrastination: createProcrastinationStore({ FM_QUARTERDECK_STATE_PATH: statePath }, () => now),
    quotaReader: async () => ({ providers: [] }),
    costReader: async () => ({ azure: { status: "unavailable" }, github: { status: "unavailable" } }),
    lanesReader: async () => ({ lanes: [] }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = url) => fetch(`${url}/api/bearings/procrastinate`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ key: KEY, duration: "3h", note: "no" })).status, 400);
    assert.equal((await post({ key: KEY, duration: "2h" })).status, 400);
    assert.equal((await post({ key: KEY, clear: false })).status, 400);
    assert.equal((await post({ key: KEY, duration: "3h" }, "https://elsewhere.invalid")).status, 403);
    assert.equal((await post({ key: "decision:missing", duration: "3h" })).status, 409);
    const saved = await post({ key: KEY, duration: "3h" });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).until[KEY], "2026-06-01T03:00:00.000Z");
    const file = path.join(root, "quarterdeck-call-procrastination.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).until[KEY], "2026-06-01T03:00:00.000Z");
    assert.equal(path.relative(home, file).startsWith(".."), true, "state stays outside the Firstmate home");
    state = "loading";
    assert.equal((await (await fetch(`${url}/api/bearings/procrastinate`)).json()).until[KEY], "2026-06-01T03:00:00.000Z");
    state = "ready";
    cards.splice(0, cards.length);
    assert.deepEqual((await (await fetch(`${url}/api/bearings/procrastinate`)).json()).until, {});
    cards.push({ key: KEY, type: "decision" });
    now = Date.parse("2026-06-01T00:00:00Z");
    await post({ key: KEY, duration: "1d" });
    assert.equal((await post({ key: KEY, clear: true })).status, 200);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).until, {});
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("the menu, return time, and full-text toggle are tab memory and never an answer", async () => {
  const dom = callDom();
  const timers = fakeTimers();
  const sources = ["bearings-view.js", "bearings-procrastinate.js"].map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));
  const context = vm.createContext({ window: { document: dom.document }, URL });
  for (const source of sources) vm.runInContext(source, context);
  const view = context.window.bearingsView;
  const list = dom.document.createElement("div");
  dom.document.body.append(list);
  const card = dom.document.createElement("article");
  card.setAttribute("data-call-key", KEY);
  card.innerHTML = view.cardHtml({ key: KEY, task: "alpha-call", type: "decision", summary: "Pick the window…" });
  list.append(card);
  const posts = [];
  let now = Date.parse("2026-06-01T00:00:00.000Z");
  let until = {};
  const changes = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body));
      const body = posts.at(-1);
      if (body.clear) delete until[body.key];
      else until = { ...until, [body.key]: new Date(now + (body.duration === "6h" ? 6 : 3) * 3600000).toISOString() };
    }
    return { ok: true, json: async () => ({ schema: "fm-quarterdeck-call-procrastination.v1", until: { ...until } }) };
  };
  const controller = context.window.bearingsProcrastinate.createController({
    list, doc: dom.document, fetchImpl, timers, now: () => now, onChange: () => changes.push(controller.parked(KEY)),
  });
  await flush();
  assert.equal(controller.parked(KEY), false);
  assert.equal(card.querySelector("header.call-head").contains(card.querySelector("[data-call-procrastinate]")), true);
  card.querySelector("[data-call-procrastinate-toggle]").click();
  assert.equal(card.querySelector("[data-call-procrastinate-menu]").hidden, false);
  dom.document.body.click();
  assert.equal(card.querySelector("[data-call-procrastinate-menu]").hidden, true, "an outside click closes the menu");
  card.querySelector("[data-call-procrastinate-toggle]").click();
  dom.document.dispatchEvent({ type: "keydown", key: "Escape" });
  assert.equal(card.querySelector("[data-call-procrastinate-menu]").hidden, true);
  card.querySelector("[data-call-procrastinate-toggle]").click();
  card.querySelector('[data-call-procrastinate-for="3h"]').click();
  await flush();
  assert.deepEqual(posts[0], { key: KEY, duration: "3h" });
  assert.equal(controller.parked(KEY), true);
  assert.match(card.querySelector("[data-call-procrastinate-until]").textContent, /^Returns /);
  assert.equal(card.querySelector("[data-call-procrastinate-return]").hidden, false);
  const shown = card.querySelector("[data-call-procrastinate-until]").textContent;
  card.querySelector("[data-call-procrastinate-toggle]").click();
  card.querySelector('[data-call-procrastinate-for="6h"]').click();
  await flush();
  assert.notEqual(card.querySelector("[data-call-procrastinate-until]").textContent, shown);
  card.querySelector("[data-call-procrastinate-return]").click();
  await flush();
  assert.deepEqual(posts.at(-1), { key: KEY, clear: true });
  assert.equal(controller.parked(KEY), false);
  card.querySelector("[data-call-procrastinate-toggle]").click();
  card.querySelector('[data-call-procrastinate-for="3h"]').click();
  await flush();
  now = Date.parse(controller.until()[KEY]) + 1;
  timers.advance(3 * 3600000 + 50);
  assert.equal(controller.parked(KEY), false, "a card returns when its time passes");
  assert.equal(changes.at(-1), false);
  card.setAttribute("data-call-answered", "");
  controller.render(card);
  assert.equal(card.querySelector("[data-call-procrastinate]").hidden, false, "Procrastinate stays on a sent card");

  const text = view.createTextController({ list });
  const toggle = card.querySelector("[data-call-text-toggle]");
  toggle.click();
  assert.equal(card.querySelector("[data-call-full]").hidden, false);
  card.innerHTML = view.cardHtml({ key: KEY, task: "alpha-call", type: "decision", summary: "Pick the window…" });
  text.render(card);
  assert.equal(card.querySelector("[data-call-full]").hidden, false, "the open text survives a refill in this tab");
  text.prune([]);
  card.innerHTML = view.cardHtml({ key: KEY, task: "alpha-call", type: "decision", summary: "Pick the window…" });
  text.render(card);
  assert.equal(card.querySelector("[data-call-full]").hidden, true);
  text.destroy();
  controller.destroy();
});

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("a parked card is already parked from this tab before the server answers", async () => {
  const dom = callDom();
  const timers = fakeTimers();
  const source = readFileSync(new URL("../public/bearings-procrastinate.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: { document: dom.document } });
  vm.runInContext(source, context);
  const future = "2026-06-01T03:00:00.000Z";
  const storage = memoryStorage({ "fm-quarterdeck-call-procrastination.v1": JSON.stringify({ [KEY]: future, "decision:old-call": "2020-01-01T00:00:00.000Z" }) });
  let behavior = "reject";
  const fetchImpl = async () => {
    if (behavior === "reject") throw new Error("offline");
    if (behavior === "missing") return { ok: false, status: 404, json: async () => ({ error: "missing" }) };
    if (behavior === "busy") return { ok: false, status: 503, json: async () => ({ error: "busy" }) };
    return { ok: true, status: 200, json: async () => ({ schema: "fm-quarterdeck-call-procrastination.v1", until: {} }) };
  };
  const controller = context.window.bearingsProcrastinate.createController({
    list: dom.document.createElement("div"), doc: dom.document, fetchImpl, timers, storage, now: () => Date.parse("2026-06-01T00:00:00.000Z"),
  });
  try {
    assert.equal(controller.parked(KEY), true, "tab memory counts before the server answers");
    assert.equal(controller.parked("decision:old-call"), false, "an expired cached return does not park");
    await flush();
    assert.equal(controller.parked(KEY), true, "a failed read keeps the return time");
    behavior = "missing";
    timers.advance(3000);
    await flush();
    assert.equal(controller.parked(KEY), true, "a missing route keeps the tab memory");
    assert.equal(storage.getItem("fm-quarterdeck-call-procrastination.v1")?.includes(KEY), true);
    behavior = "busy";
    await controller.load();
    assert.equal(controller.parked(KEY), true, "a busy read keeps the tab memory");
    behavior = "empty";
    timers.advance(3000);
    await flush();
    assert.equal(controller.parked(KEY), false, "a successful empty read is Bring back or a resolved call");
    assert.equal(storage.getItem("fm-quarterdeck-call-procrastination.v1"), null);
  } finally { controller.destroy(); }
});

test("Update now keeps a procrastinated card parked across a new revision and an answered receipt", async () => {
  const dom = callDom();
  const timers = fakeTimers();
  const sources = ["bearings-view.js", "bearings-patch.js", "bearings-procrastinate.js", "call-lifecycle.js"].map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));
  const { document } = dom;
  const section = document.createElement("section");
  const status = document.createElement("p");
  const list = document.createElement("div");
  const coverage = document.createElement("p");
  section.append(status, list, coverage);
  document.body.append(section);
  const win = { document, matchMedia: () => ({ matches: false }), navigator: {} };
  const context = vm.createContext({ window: win, URL });
  for (const source of sources) vm.runInContext(source, context);
  let until = {};
  const started = Date.parse("2026-06-01T00:00:00.000Z");
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.clear) delete until[body.key];
      else until[body.key] = new Date(started + 3 * 3600000).toISOString();
    }
    return { ok: true, status: 200, json: async () => ({ schema: "fm-quarterdeck-call-procrastination.v1", until: { ...until } }) };
  };
  const model = (cards) => ({ schema: "fm-quarterdeck-call.v1", rev: cards.map((entry) => `${entry.key}@${entry.rev}`).join("|"), state: "ready", cards, coverage: { known: 1, checked: 1, provenClear: false }, omitted: [] });
  let procrastinate;
  const paint = () => {
    const applied = patcher.applied;
    const api = win.callLifecycle;
    if (!applied || !procrastinate) return;
    for (const card of applied.cards) {
      const node = [...list.querySelectorAll("[data-call-key]")].find((item) => item.getAttribute("data-call-key") === card.key);
      if (!node) continue;
      const state = api.cardState({ card, procrastinated: procrastinate.parked(card.key) });
      node.setAttribute("data-call-lifecycle", state);
      node.toggleAttribute("data-call-answered", Boolean(card.answered));
      node.toggleAttribute("data-call-procrastinated", state === "procrastinated");
      procrastinate.render(node);
      node.hidden = state !== "active";
    }
  };
  const patcher = win.bearingsPatch.createCallPatcher({
    section, list, status, coverage, view: win.bearingsView, doc: document, win, storage: memoryStorage(), timers,
    onRender: (node) => procrastinate?.render(node), onApply: () => paint(),
  });
  procrastinate = win.bearingsProcrastinate.createController({
    list, doc: document, fetchImpl, timers, storage: memoryStorage(), now: () => started, onChange: () => paint(),
  });
  try {
    await flush();
    const first = { key: KEY, type: "decision", task: "alpha-call", summary: "Pick the window…", rev: "a1" };
    assert.equal(patcher.update(model([first])), "applied");
    const card = [...list.querySelectorAll("[data-call-key]")].find((node) => node.getAttribute("data-call-key") === KEY);
    card.querySelector('[data-call-procrastinate-for="3h"]').click();
    await flush();
    assert.equal(procrastinate.parked(KEY), true);
    assert.equal(card.hidden, true, "Active hides a procrastinated card");
    card.querySelector("[data-call-answer-text]").focus();
    const next = { ...first, rev: "a2", summary: "Gamma credential after Update now", answered: true };
    assert.equal(patcher.update(model([next])), "held");
    assert.ok(card.querySelector("[data-call-update-now]"));
    card.querySelector("[data-call-update-now]").click();
    assert.equal(card.getAttribute("data-call-rev"), "a2");
    assert.match(card.textContent, /Gamma credential after Update now/);
    assert.equal(procrastinate.parked(KEY), true);
    assert.match(card.querySelector("[data-call-procrastinate-until]").textContent, /^Returns /);
    assert.equal(card.querySelector("[data-call-procrastinate]").hidden, false, "Update now leaves the Procrastinate pill");
    assert.equal(card.getAttribute("data-call-lifecycle"), "procrastinated");
    assert.equal(card.hidden, true, "an answered procrastinated card stays off Active");
    assert.equal(win.callLifecycle.cardState({ card: next, procrastinated: true }), "procrastinated");
  } finally {
    procrastinate.destroy();
    patcher.destroy();
  }
});
