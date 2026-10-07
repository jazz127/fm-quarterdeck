// Exact-head, package-free Chromium acceptance for coarse-pointer app-shell disclosure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const profile = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-tablet-"));
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let n = 0; n < 100; n++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, { resolve, reject });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evalPage = async (expression) => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cmd("Page.enable");
  const navigate = async (url) => {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.removeEventListener("message", onMessage); reject(new Error(`Navigation timed out: ${url}`)); }, 10000);
      const onMessage = ({ data }) => {
        if (JSON.parse(data).method !== "Page.loadEventFired") return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      };
      ws.addEventListener("message", onMessage);
    });
    await cmd("Page.navigate", { url });
    await loaded;
  };
  for (const [width, touch] of [[390, true], [768, true], [834, true], [1024, true], [1280, false], [834, false]]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await cmd("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await cmd("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: touch ? "coarse" : "fine" }, { name: "hover", value: touch ? "none" : "hover" }] });
    await navigate(`${base}/?width=${width}&touch=${touch}#quota`);
    for (let n = 0; n < 100; n++) {
      if (await evalPage('Boolean(document.querySelector("#quota-view.active h1") && document.querySelector("#shell-panel-toggle") && getComputedStyle(document.querySelector(".main-stage")).width !== "0px")')) break;
      await wait(100);
    }
    for (let n = 0; n < 100 && width > 720 && width <= 1200 && touch && await evalPage('document.querySelector("#shell-panel-toggle").hidden'); n++) await wait(50);
    const available = width > 720 && width <= 1200 && touch;
    const snapshot = async () => evalPage(`(() => {
      const toggle = document.querySelector('#shell-panel-toggle');
      const sidebar = document.querySelector('#review-sidebar-region');
      const stage = document.querySelector('.main-stage');
      const r = toggle.getBoundingClientRect(), s = stage.getBoundingClientRect();
      return { route: location.hash, expanded: toggle.getAttribute('aria-expanded'), label: toggle.getAttribute('aria-label'), controls: toggle.getAttribute('aria-controls'), hidden: toggle.hidden, focusable: !toggle.hidden && getComputedStyle(toggle).display !== 'none', visible: r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && toggle.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)), width: r.width, height: r.height, sidebar: getComputedStyle(sidebar).display, inert: sidebar.inert, stageLeft: s.left, stageWidth: s.width, title: !!document.querySelector('#quota-view.active h1'), quota: !!document.querySelector('#quota-view.active .quota-controls'), overflow: document.documentElement.scrollWidth > innerWidth + 1, focused: document.activeElement === toggle, focusOutline: getComputedStyle(toggle).outlineStyle };
    })()`);
    const start = await snapshot();
    assert.equal(start.route, "#quota");
    assert.equal(start.hidden, false, `${width} app-shell toggle available: ${JSON.stringify(start)}`);
    assert.ok(start.title && start.quota && !start.overflow, `${width} baseline content: ${JSON.stringify(start)}`);
    if (!available) continue;
    assert.ok(start.visible && start.stageLeft > 200 && start.controls === "review-sidebar-region", `${width} expanded: ${JSON.stringify(start)}`);
    assert.equal(start.expanded, "true");
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await evalPage('document.querySelector("#shell-panel-toggle").focus()');
    assert.notEqual((await snapshot()).focusOutline, "none", `${width} visible keyboard focus`);
    const tap = async () => {
      const { x, y } = await evalPage('(() => { const r = document.querySelector("#shell-panel-toggle").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
      await cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await tap();
    const closed = await snapshot();
    assert.ok(closed.visible && closed.focused && closed.inert && closed.sidebar === "none" && closed.stageLeft < 2 && closed.stageWidth >= width - 2 && !closed.overflow && closed.title && closed.quota, `${width} collapsed: ${JSON.stringify(closed)}`);
    assert.equal(closed.expanded, "false");
    assert.match(closed.label, /^Expand/);
    await evalPage('location.hash = "#overview"');
    for (let n = 0; n < 30 && !(await evalPage('Boolean(document.querySelector("#overview-view.active h1"))')); n++) await wait(50);
    assert.equal((await snapshot()).expanded, "false", `${width} retains collapsed state across route`);
    await tap();
    const reopened = await snapshot();
    assert.ok(reopened.visible && !reopened.inert && reopened.stageLeft > 200 && reopened.expanded === "true" && reopened.route === "#overview", `${width} reopened: ${JSON.stringify(reopened)}`);
    console.log(`${width}px coarse-pointer: expansion, focus, route and geometry passed`);
  }
} finally {
  ws?.close();
  chrome.kill();
  app.close();
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
