// Bounded exact-checkout desktop/phone Lane Chat filter acceptance. Node built-ins only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const lane = (id) => ({ id, name: id, status: "active", closed: false, messages: [{ recordId: `fixture:${id}`, author: "Firstmate", role: "firstmate", kind: "conversation", text: id, source: "fixture", time: "12:00", occurredAt: "2030-01-01T12:00:00Z" }], sessions: [], items: [], crew: 0, mission: "Fixture" });
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { lanesReader: async () => ({ source: "fixture", lanes: [lane("general"), lane("working")], transcript: { sessions: [], warnings: [], note: "Fixture coverage" } }) });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const revision = (await (await fetch(`${base}/api/review`)).json()).version;
const profile = await mkdtemp(path.join(process.cwd(), ".chat-filter-chrome-"));
const chromium = process.env.CHROMIUM || "chromium";
const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "isolated Chromium CDP opened");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cmd("Page.enable");
  for (const [width, height] of [[1600, 900], [390, 844]]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await cmd("Page.navigate", { url: `${base}/#lanes` });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await evaluate(`Boolean(innerWidth === ${width} && document.querySelector('#kind-filter-menu') && document.querySelector('#lane-options') && document.querySelector('#review-send') && [...document.styleSheets].some(s => s.href?.endsWith('/styles.css')))`);
      if (ready) break;
      await wait(100);
    }
    assert.ok(ready, `Lane Chat ready at ${width}px`);
    const result = await evaluate(`(() => {
      const lane = document.querySelector('#lane-options'), kind = document.querySelector('#kind-filter-menu'), feed = document.querySelector('#messages');
      const rect = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right }; };
      return { width: innerWidth, route: location.hash, owner: !!lane.closest('#conversations-view'), shellOwnsFilters: !!document.querySelector('.lane-list #lane-options, .lane-list #message-type-filters'),
        laneVisible: !lane.hidden, lane: rect(lane), kindParent: kind.parentElement.id || kind.parentElement.className, kindOpen: kind.open, kind: rect(kind), feed: rect(feed),
        navToggleVisible: getComputedStyle(document.querySelector('#lane-filter-toggle')).display !== 'none', overflow: document.documentElement.scrollWidth > innerWidth,
        statusOptions: document.querySelector('#lane-status').textContent, unavailable: document.querySelector('.lane-status-note').textContent,
        format: !!document.querySelector('#message-format-toggle'), review: !!document.querySelector('#review-send') };
    })()`);
    assert.equal(result.owner, true);
    assert.equal(result.shellOwnsFilters, false);
    assert.equal(result.overflow, false);
    assert.equal(result.format && result.review, true);
    assert.match(result.unavailable, /Pinned and unread filtering unavailable/);
    if (width === 1600) {
      assert.equal(result.laneVisible, true);
      assert.equal(result.kindParent, "conversation-kind-panel");
      assert.equal(result.kindOpen, true);
      assert.equal(result.navToggleVisible, false);
      assert.ok(result.lane.right <= result.feed.left + 2);
      assert.ok(result.kind.left >= result.feed.right - 2);
    } else {
      assert.equal(result.kindParent, "lane-options");
      assert.equal(result.kindOpen, true);
      assert.equal(result.navToggleVisible, false, 'phone filter toggle lives in More; header shortcut opens the drawer');
      await evaluate("document.querySelector('#conversation-filter-shortcut').click()");
      assert.equal(await evaluate("document.querySelector('#lane-options').hidden"), false);
      await evaluate("document.querySelector('#mobile-kinds-tab').click()");
      assert.equal(await evaluate("document.querySelector('#kind-filter-menu').hidden"), false);
      assert.equal(await evaluate("document.querySelector('#kind-filter-menu').getAttribute('role') === 'tabpanel' && document.querySelector('#kind-filter-menu').getAttribute('aria-labelledby') === 'mobile-kinds-tab'"), true);
      const kindChoice = await evaluate(`(() => { const input = document.querySelector('#message-type-filters input'); input.click(); return { value: input.value, checked: input.checked }; })()`);
      await evaluate("document.querySelector('#mobile-lanes-tab').click()");
      await evaluate("document.querySelector('#mobile-kinds-tab').click()");
      assert.equal(await evaluate(`document.querySelector('#message-type-filters input[value=${JSON.stringify(kindChoice.value)}]').checked`), kindChoice.checked, "message-kind choice persists across tabs");
      assert.equal(await evaluate("document.querySelector('#lane-filter-controls').hidden"), true);
      await evaluate("document.querySelector('#mobile-lanes-tab').click()");
      assert.equal(await evaluate("document.querySelector('#lane-filter-controls').hidden"), false);
      const laneChoice = await evaluate(`(() => { const input = document.querySelector('#lane-filter-rows input'); input.click(); return { value: input.dataset.filterLane, checked: input.checked }; })()`);
      await evaluate("document.querySelector('#lane-filter-close').click()");
      assert.equal(await evaluate("document.querySelector('#lane-options').hidden"), true);
      await evaluate("document.querySelector('#conversation-filter-shortcut').click()");
      assert.equal(await evaluate(`document.querySelector('#lane-filter-rows input[data-filter-lane=${JSON.stringify(laneChoice.value)}]').checked`), laneChoice.checked, "lane choice persists after dismissal");
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
      assert.equal(await evaluate("document.querySelector('#lane-options').hidden"), true);
    }
    console.log(`${revision} ${width}x${height}: Lane Chat filter placement and controls passed`);
  }
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
  if (chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), wait(3000)]);
  await rm(profile, { recursive: true, force: true });
  app.close();
}
