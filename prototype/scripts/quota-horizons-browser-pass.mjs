// Bounded exact-head desktop + phone quota preview pass, with isolated server and Chromium.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(), "", "exact-head pass requires clean tree");
const profile = await mkdtemp(path.join(os.tmpdir(), "fm-quota-horizons-"));
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const reading = { readAt: iso(0), capturedAt: iso(0), stale: false, providers: [{ provider: "agy", status: "fresh", quotaStatus: "known", scopes: [{ scope: "gemini", boundedBy: ["five", "week"] }], windows: [
  { id: "five", label: "Gemini 5-hour", percentRemaining: 24, durationSeconds: 18000, startsAt: iso(-9000000), resetsAt: iso(9000000) },
  { id: "week", label: "Gemini weekly", percentRemaining: 70, resetsAt: iso(5 * 86400000) }
] }] };
const server = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { quotaReader: async () => reading });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 80; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "isolated Chromium started");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data), item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    reply.error ? item.reject(Error(JSON.stringify(reply.error))) : item.resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
  const evalPage = async (expression) => {
    const reply = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw Error(reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cmd("Page.enable");
  for (const [width, height] of [[1280, 844], [375, 812]]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await cmd("Page.navigate", { url: base });
    let ready = false;
    for (let i = 0; i < 80; i++) { ready = await evalPage('document.querySelectorAll("#mobile-quota-sheet-content .quota-family-row").length === 2'); if (ready) break; await wait(100); }
    assert.ok(ready, `${width}: injected quota reading rendered: ${JSON.stringify(await evalPage('({url:location.href,body:document.body?.textContent.slice(0,250),sheet:document.querySelector("#mobile-quota-sheet-content")?.textContent.slice(0,600),strip:document.querySelector("#quota-strip")?.innerHTML.slice(0,600),page:document.querySelector("#quota-providers")?.innerHTML.slice(0,200)})'))}`);
    if (width < 500) await evalPage('document.querySelector(".mobile-dock-quota").click()');
    const result = await evalPage(`(() => {
      const pane = document.querySelector(${JSON.stringify(width < 500 ? "#mobile-quota-sheet-content" : "#quota-strip")});
      const rows = [...pane.querySelectorAll(".quota-family-row")];
      const page = document.querySelector("#quota-providers");
      return { revision: window.FM_STANDALONE_UAT?.revision || "", rows: rows.map(r => ({ label: r.querySelector(".quota-family-label")?.textContent, value: r.querySelector(".quota-family-value")?.textContent, reset: r.querySelector(".quota-reset-full")?.textContent, notch: r.querySelector(".quota-family-notch")?.style.getPropertyValue("--remaining"), width: r.clientWidth, overflow: r.scrollWidth > r.clientWidth + 1 })), pageRows: page.querySelectorAll(".quota-family-row").length, pageReset: page.querySelectorAll(".quota-family-reset").length, overflow: document.documentElement.scrollWidth > innerWidth + 1, paneDisplay: getComputedStyle(pane).display };
    })()`);
    assert.equal(result.revision, head, `${width}: exact served revision`);
    assert.equal(result.rows.length, 2, `${width}: two preview horizons`);
    assert.ok(result.rows.every(r => r.width > 0), `${width}: preview rows visible`);
    assert.match(result.rows[0].label, /5h/);
    assert.match(result.rows[1].label, /7d/);
    assert.deepEqual(result.rows.map(r => r.value), ["24%", "70%"]);
    assert.match(result.rows[0].reset, /\d+[dhm]/);
    assert.match(result.rows[1].reset, /\d+[dhm]/);
    assert.equal(result.rows[0].notch, "50%");
    assert.equal(result.rows[1].notch, undefined);
    assert.equal(result.pageReset, 0, "full quota page has no new compact ticker");
    assert.equal(result.pageRows, 2);
    assert.ok(!result.overflow && result.rows.every(r => !r.overflow), `${width}: no horizontal overflow: ${JSON.stringify(result)}`);
    console.log(`${width}x${height} ${head} ${JSON.stringify(result)}`);
  }
} finally {
  ws?.close(); chrome.kill(); await new Promise((resolve) => chrome.once("exit", resolve)); await new Promise((resolve) => server.close(resolve)); await rm(profile, { recursive: true, force: true });
}
