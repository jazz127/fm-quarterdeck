// Bounded, task-isolated local Chromium acceptance at desktop and phone widths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const chromium = process.env.CHROMIUM || "chromium";
assert.ok(process.env.FM_HOME, "Set FM_HOME to an explicitly authorized fixture home");
const profile = await mkdtemp(path.join(os.tmpdir(), "fm-mix-ac-browser-"));
const app = createServer({ FM_HOME: process.env.FM_HOME });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const revision = (await (await fetch(`${base}/api/review`)).json()).version;
const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "Chromium CDP opened");
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
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width === 390 });
    await cmd("Page.navigate", { url: `${base}/#lanes` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(innerWidth === ${width} && document.querySelector('#lane-status')?.options.length > 1 && document.querySelector('#messages .message') && getComputedStyle(document.querySelector('.lane-list')).backgroundColor === 'rgb(11, 31, 42)')`)) break;
      await wait(100);
    }
    const layout = await evaluate(`(() => {
      const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top:r.top, bottom:r.bottom, left:r.left, right:r.right }; };
      return { width:innerWidth, overflow:document.documentElement.scrollWidth > innerWidth, nav:box(innerWidth <= 720 ? '.mobile-dock' : '.primary-nav'), stage:box('.main-stage'), filter:box('#lane-filter-toggle'), feed:box('#messages'), statusOptions:document.querySelector('#lane-status').options.length, pane:getComputedStyle(document.querySelector('#review-panel')).display };
    })()`);
    assert.equal(layout.width, width);
    assert.equal(layout.overflow, false, JSON.stringify(layout));
    assert.ok(layout.statusOptions > 1, `live lane statuses loaded: ${JSON.stringify(layout)}`);
    if (width === 390) {
      assert.ok(layout.feed.bottom <= layout.nav.top + 2, `feed clear of bottom dock: ${JSON.stringify(layout)}`);
      await evaluate(`document.querySelector('#conversation-filter-shortcut').click()`);
    }
    assert.equal(await evaluate(`document.querySelector('#lane-options').hidden`), false);
    const filtered = await evaluate(`(() => { const sel = document.querySelector('#lane-status'); sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles:true })); return {value:sel.value, title:document.querySelector('#conversation-title').textContent, count:document.querySelectorAll('#messages .message').length}; })()`);
    assert.ok(filtered.value !== 'all');
    await evaluate(`document.querySelector('#lane-status').value='all'; document.querySelector('#lane-status').dispatchEvent(new Event('change', {bubbles:true})); document.querySelector('#lane-filter-close').click()`);
    await evaluate(`document.querySelector('#review-panel-toggle').click()`);
    assert.equal(await evaluate(`document.querySelector('#review-panel').hidden`), false);
    const panel = await evaluate(`(() => { const r=document.querySelector('#review-panel').getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; })()`);
    assert.ok(panel.left >= 0 && panel.right <= width && panel.top >= 0 && panel.bottom <= height, JSON.stringify(panel));
    await evaluate(`document.querySelector('#review-close').click()`);
    assert.equal(await evaluate(`document.querySelector('#review-panel').hidden`), true);
    console.log(`${width}x${height} ${revision} lane filter=${filtered.value} records=${filtered.count}; dock/feed and review pane fit; no overflow`);
  }
} finally {
  ws?.close(); chrome.kill(); app.close();
  if (chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), wait(2000)]);
  await rm(profile, { recursive:true, force:true });
}
