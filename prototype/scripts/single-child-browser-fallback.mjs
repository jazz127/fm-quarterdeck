// Task-isolated fallback, only called after repeated supported-tool target loss.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
export async function isolatedBrowser(lab) {
  const profile = await mkdtemp(path.join(lab, "fallback-profile-"));
  const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let ws;
  const stop = async () => {
    ws?.close(); chrome.kill("SIGKILL");
    await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve));
    await rm(profile, { recursive: true, force: true });
  };
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
      catch { if (chrome.exitCode !== null) throw Error("isolated Chromium exited"); await wait(100); }
    }
    if (!port) throw Error("isolated Chromium not ready");
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    let id = 0; const pending = new Map();
    ws.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data), entry = pending.get(reply.id); if (!entry) return;
      pending.delete(reply.id); clearTimeout(entry.timer);
      reply.error ? entry.reject(Error(JSON.stringify(reply.error))) : entry.resolve(reply.result);
    });
    const cmd = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error(`${method} timed out`)); }, 15000);
      pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
    });
    await cmd("Page.enable");
    return async (action, ...args) => {
      if (action === "stop") { await stop(); return "stopped"; }
      if (action === "open") return JSON.stringify(await cmd("Page.navigate", { url: args[0] }));
      if (action === "wait") { await wait(Number(args[0])); return "waited"; }
      if (action === "resize") return JSON.stringify(await cmd("Emulation.setDeviceMetricsOverride", { width: Number(args[0]), height: Number(args[1]), deviceScaleFactor: 1, mobile: Number(args[0]) <= 720 }));
      if (action === "eval") {
        const reply = await cmd("Runtime.evaluate", { expression: args[0], returnByValue: true, awaitPromise: true });
        if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
        return JSON.stringify(reply.result.value);
      }
      if (action === "screenshot") { const shot = await cmd("Page.captureScreenshot", { format: "png" }); await writeFile(args[0], Buffer.from(shot.data, "base64")); return args[0]; }
      throw Error(`unsupported fallback action: ${action}`);
    };
  } catch (error) { await stop(); throw error; }
}
