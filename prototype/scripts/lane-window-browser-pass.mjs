// Isolated direct-Chromium, exact-revision desktop/phone Lane Chat source-window pass.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

assert.ok(process.env.FM_HOME, "Set FM_HOME to a readable Firstmate home");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const server = createServer({ FM_HOME: process.env.FM_HOME, FM_DEPLOYMENT_TIER: "uat" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const revision = (await (await fetch(`${base}/api/review`)).json()).version;
assert.equal(revision, head, "the isolated process must serve this exact clean checkout");
const profile = await mkdtemp(path.join(process.cwd(), ".lane-window-chrome-"));
const chrome = spawn(process.env.CHROMIUM || "chromium",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "isolated Chromium started");
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
    await cmd("Page.navigate", { url: `${base}/#lanes/fm-quarterdeck` });
    const first = await evaluate(`(async () => {
      for (let i = 0; i < 300; i++) {
        if (document.querySelector('#view-freshness')?.textContent?.includes('Lane Chats · fresh') && document.querySelector('#session-history-list [data-session-id]')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { status: document.querySelector('#view-freshness')?.textContent, count: document.querySelector('#session-count')?.textContent,
        records: document.querySelectorAll('#messages article.message').length, initial: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/lanes')).at(-1)?.duration };
    })()`);
    assert.match(first.status, /Lane Chats · fresh/);
    assert.ok(first.records > 0 && first.records <= 200);
    const refreshed = await evaluate(`(async () => {
      const before = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/lanes')).length;
      document.querySelector('#transcript-search').value = 'preserved filter';
      document.querySelector('#transcript-search').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#refresh').click();
      for (let i = 0; i < 300; i++) {
        if (performance.getEntriesByType('resource').filter(e => e.name.includes('/api/lanes')).length > before && !document.querySelector('#view-freshness').textContent.includes('refreshing')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const e = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/lanes')).at(-1);
      return { duration: e.duration, transfer: e.transferSize, decoded: e.decodedBodySize,
        filter: document.querySelector('#transcript-search').value, status: document.querySelector('#view-freshness').textContent };
    })()`);
    assert.equal(refreshed.filter, "preserved filter");
    assert.match(refreshed.status, /Lane Chats · fresh/);
    const direct = await evaluate(`(async () => {
      document.querySelector('#transcript-search').value = '';
      document.querySelector('#transcript-search').dispatchEvent(new Event('input', { bubbles: true }));
      const row = document.querySelector('#session-history-list [data-loaded="false"]');
      if (!row) return { available: false };
      const id = row.dataset.sessionId;
      row.click();
      for (let i = 0; i < 300; i++) {
        if (document.querySelector('#session-history-list [data-session-id="' + id + '"]')?.dataset.loaded === 'true' && !document.querySelector('#view-freshness').textContent.includes('refreshing')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { available: true, id, route: location.hash, loaded: document.querySelector('#session-history-list [data-session-id="' + id + '"]')?.dataset.loaded };
    })()`);
    if (direct.available) {
      assert.equal(direct.loaded, "true", "direct route reads an older session");
      assert.ok(direct.route.includes(direct.id));
    }
    const older = await evaluate(`(async () => {
      document.querySelector('#transcript-search').value = '';
      document.querySelector('#transcript-search').dispatchEvent(new Event('input', { bubbles: true }));
      const before = document.querySelector('#session-count').textContent;
      const button = document.querySelector('#sessions-load-older');
      if (button.hidden) return { before, after: before, hidden: true };
      button.click();
      for (let i = 0; i < 300; i++) {
        if (document.querySelector('#session-count').textContent !== before && !document.querySelector('#view-freshness').textContent.includes('refreshing')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { before, after: document.querySelector('#session-count').textContent, hidden: false, status: document.querySelector('#view-freshness').textContent };
    })()`);
    assert.ok(older.hidden || older.before !== older.after, "older task sessions must load on request");
    assert.match(older.status || refreshed.status, /Lane Chats · fresh/);
    const disk = await evaluate(`(async () => {
      const button = document.querySelector('#disk-load-older');
      if (button.hidden) return { available: false };
      const before = document.querySelector('#transcript-summary').textContent;
      button.click();
      for (let i = 0; i < 300; i++) {
        if (document.querySelector('#transcript-summary').textContent !== before && !document.querySelector('#view-freshness').textContent.includes('refreshing')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { available: true, before, after: document.querySelector('#transcript-summary').textContent };
    })()`);
    assert.ok(!disk.available || disk.before !== disk.after, "older disk transcript sources load explicitly");
    console.log(JSON.stringify({ revision, viewport: `${width}x${height}`, first, refreshed, direct, older, disk }));
  }
} finally {
  ws?.close();
  chrome.kill("SIGTERM");
  if (chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), wait(3000)]);
  await rm(profile, { recursive: true, force: true });
  server.close();
}
