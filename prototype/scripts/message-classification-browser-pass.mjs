// Synthetic Fleet Chats check: pre-tool narration stays out of the default feed,
// and an inbox reply shows in the note's lane. Screenshots are fixtures only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser } from "./browser-harness.mjs";

const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-classify-"));
const home = path.join(scratch, "home");
await mkdir(path.join(home, "data"), { recursive: true });
await mkdir(path.join(home, "state/main-session"), { recursive: true });
await mkdir(path.join(home, "state/inbox/handled"), { recursive: true });
await mkdir(path.join(home, "state/inbox/.replies"), { recursive: true });
await writeFile(path.join(home, "data/projects.md"), "- Alpha - Synthetic classification fleet\n");
await writeFile(path.join(home, "state/alpha-task.meta"), `project=${path.join(home, "projects", "Alpha")}\n`);
await writeFile(path.join(home, "state/inbox/handled/1791641035-WPakGQ.note"),
  "id=1791641035-WPakGQ\nat=2030-05-06T14:00:00Z\nsource=text\ntask_id=alpha-task\n--\nSynthetic captain note on Alpha.\n");
await writeFile(path.join(home, "state/inbox/.replies/1791641035-WPakGQ"),
  "id=1791641035-WPakGQ\nat=2030-05-06T14:07:27Z\nseq=4\n--\nSynthetic inbox reply to the Alpha note.\n");
const at = (minute) => new Date(Date.UTC(2030, 4, 6, 14, minute)).toISOString();
const message = (minute, stopReason, content) => JSON.stringify({
  type: "message", timestamp: at(minute), message: { role: "assistant", stopReason, content },
});
await writeFile(path.join(home, "state/main-session/session.jsonl"), [
  message(1, "toolUse", [{ type: "text", text: "Synthetic pre-tool narration about the build." }, { type: "toolCall", name: "bash", arguments: { command: "true" } }]),
  message(2, "stop", [{ type: "text", text: "Synthetic end of turn reply." }]),
  message(3, "toolUse", [{ type: "text", text: "[fm-lane Alpha]\nSynthetic lane reply stays visible.\n[end Alpha]" }]),
].join("\n") + "\n");

const server = createServer({}, {
  lanesReader: async (_, options) => loadFirstmateHome(home, options),
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
});
const feedText = "document.querySelector('#messages').innerText";
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/#lanes`;
  for (const width of [1280, 390]) {
    browser = await openBrowser();
    const { command, evaluate, until } = browser;
    const screenshot = async (name) => {
      if (!process.env.SCREENSHOT_DIR) return;
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `${name}-${width}.png`), Buffer.from(data, "base64"));
    };
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    await command("Page.navigate", { url });
    await until("document.querySelectorAll('article.message').length >= 3");
    assert.equal(await evaluate("document.querySelector('#message-type-filters input[value=narration]').checked"), false);
    assert.equal(await evaluate("document.querySelector('#message-type-filters input[value=conversation]').checked"), true);
    const hidden = await evaluate(feedText);
    assert.equal(hidden.includes("Synthetic pre-tool narration about the build."), false);
    assert.equal(hidden.includes("Synthetic end of turn reply."), true);
    assert.equal(hidden.includes("Synthetic lane reply stays visible."), true);
    assert.equal(hidden.includes("Synthetic inbox reply to the Alpha note."), true);
    await evaluate("[...document.querySelectorAll('article.message')].find((node) => node.innerText.includes('Synthetic inbox reply to the Alpha note.')).scrollIntoView({ block: 'center' })");
    await screenshot("classification-default");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false, `${width}px feed fits`);
    await evaluate("document.querySelector('#message-type-filters input[value=narration]').click()");
    await until(`${feedText}.includes('Synthetic pre-tool narration about the build.')`);
    const shown = await evaluate(feedText);
    assert.equal(shown.includes("Synthetic pre-tool narration about the build."), true);
    assert.equal(shown.includes("Synthetic inbox reply to the Alpha note."), true);
    await evaluate("[...document.querySelectorAll('article.message')].find((node) => node.innerText.includes('Synthetic pre-tool narration about the build.')).scrollIntoView({ block: 'center' })");
    await screenshot("classification-narration");
    const label = await evaluate("[...document.querySelectorAll('article.message')].find((node) => node.innerText.includes('Synthetic pre-tool narration about the build.')).querySelector('.message-origin').textContent");
    assert.equal(label, "Firstmate progress");
    console.log(`PASS ${width}px: narration hidden by default, end-of-turn and lane replies visible, inbox reply in the feed`);
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
