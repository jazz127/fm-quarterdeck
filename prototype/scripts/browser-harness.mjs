// Direct local Chromium/CDP only; isolated temporary profile and bounded commands.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function cleanupBrowserProfile(chrome, profile, { removeProfile = rm, warn = console.warn } = {}) {
  if (chrome.pid !== undefined && chrome.exitCode === null && chrome.signalCode === null) {
    await new Promise((resolve) => { chrome.once("exit", resolve); chrome.kill("SIGKILL"); });
  }

  try {
    await removeProfile(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch (error) {
    if (error.code !== "ENOTEMPTY" && error.code !== "EBUSY") throw error;
    warn("Could not remove Chromium temporary profile " + profile + ": " + error.message);
  }
}

// A cold Chrome/profile on a shared CI runner can take longer than a page/CDP
// operation. Keep launch readiness separately bounded; never retry a failed
// browser or relax the behavioral command/condition deadlines below.
export async function waitForBrowserPort(chrome, profile, {
  timeoutMs = 30000, now = () => performance.now(),
  readActivePort = () => readFile(path.join(profile, "DevToolsActivePort"), "utf8"),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  spawnError = () => undefined, diagnostics = () => "",
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (spawnError()) throw spawnError();
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw Error(`Chromium exited ${chrome.exitCode ?? chrome.signalCode}${diagnostics() ? `: ${diagnostics()}` : ""}`);
    }
    try {
      const port = Number((await readActivePort()).split("\n")[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await wait(Math.min(100, Math.max(0, deadline - now())));
  }
  throw Error(`Chromium startup timed out after ${timeoutMs}ms${diagnostics() ? `: ${diagnostics()}` : ""}`);
}

// Opt-in CPU throttling for reproducing slow CI initialization/paint races.
export function browserCpuRate(value = process.env.FM_BROWSER_CPU_RATE) {
  const rate = Number(value ?? 1);
  if (!Number.isFinite(rate) || rate < 1 || rate > 20) throw Error("FM_BROWSER_CPU_RATE must be a number from 1 to 20");
  return rate;
}

export async function openBrowser() {
  const cpuRate = browserCpuRate();
  const profile = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-browser-"));
  const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let spawnError, ws, startupDiagnostics = "";
  chrome.on("error", (error) => { spawnError = error; });
  const captureStartup = (chunk) => { startupDiagnostics = (startupDiagnostics + chunk.toString()).slice(-2000); };
  chrome.stderr.on("data", captureStartup);
  const pending = new Map(), listeners = new Set(), diagnostics = [];
  let id = 0;
  const close = async () => {
    ws?.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error("Browser closed")); }
    pending.clear();
    await cleanupBrowserProfile(chrome, profile);
  };
  try {
    const port = await waitForBrowserPort(chrome, profile, {
      spawnError: () => spawnError, diagnostics: () => startupDiagnostics.trim(),
    });
    chrome.stderr.removeListener("data", captureStartup);
    chrome.stderr.resume();
    // Own a dedicated page rather than racing Chrome's initial startup tab.
    const pageResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    if (!pageResponse.ok) throw Error(`Cannot create browser fixture page: ${pageResponse.status}`);
    const pageTarget = await pageResponse.json();
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data);
      if (reply.method) {
        // This harness serves synthetic offline fixtures only. Keep failure
        // evidence bounded; never attach response bodies or browser profiles.
        if (reply.method === "Runtime.exceptionThrown") {
          const details = reply.params.exceptionDetails;
          diagnostics.push((details.exception?.description || details.text).slice(0, 1000));
        } else if (reply.method === "Network.loadingFailed") {
          diagnostics.push(`Network failure: ${reply.params.errorText}`);
        } else if (reply.method === "Network.responseReceived" && reply.params.response.status >= 400) {
          const response = reply.params.response;
          diagnostics.push(`HTTP ${response.status}: ${new URL(response.url).pathname}`);
        }
        if (diagnostics.length > 10) diagnostics.shift();
        for (const listener of listeners) listener(reply);
        return;
      }
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id); clearTimeout(request.timer);
      reply.error ? request.reject(Error(JSON.stringify(reply.error))) : request.resolve(reply.result);
    });
    const command = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`${method} timed out`)); }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const until = async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const page = await evaluate(`({ title: document.title, readyState: document.readyState,
        contentType: document.contentType, review: document.querySelector('#review-context')?.textContent,
        projects: document.querySelector('#projects')?.children.length })`);
      throw Error(`Browser condition timed out: ${expression}\n${JSON.stringify({ page, diagnostics })}`);
    };
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Network.enable");
    if (cpuRate !== 1) await command("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    return { command, evaluate, until, close, onEvent: (fn) => listeners.add(fn) };
  } catch (error) { await close(); throw error; }
}

// Reading controls use the same nodes in the desktop header and phone options.
export async function openReadingControls(browser) {
  if (!await browser.evaluate("innerWidth<=720")) {
    await browser.until("!!document.querySelector('#header-reading-options')");
    await browser.evaluate("if(!document.querySelector('#header-reading-options-toggle').hidden&&!document.querySelector('#header-reading-options').open)document.querySelector('#header-reading-options-toggle').click()");
    return;
  }
  await browser.until("!!document.querySelector('#mobile-chat-options')");
  await browser.evaluate("if(!document.querySelector('#mobile-chat-options').open)document.querySelector('#conversation-filter-shortcut').click()");
  await browser.until("document.querySelector('#mobile-chat-options').open && document.querySelector('#message-compact-toggle').getBoundingClientRect().height>0");
}
export async function closeReadingControls(browser) {
  await browser.evaluate("if(document.querySelector('#header-reading-options')?.open)document.querySelector('#header-reading-options header button').click();if(document.querySelector('#mobile-chat-options')?.open)document.querySelector('#mobile-chat-options .mobile-sheet-close').click()");
  await browser.until("!document.querySelector('#mobile-chat-options')?.open");
}
