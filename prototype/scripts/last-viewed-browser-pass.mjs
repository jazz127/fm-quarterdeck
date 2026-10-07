// Offline reading checkpoint acceptance. Optional screenshots contain fixtures only.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser, openReadingControls } from "./browser-harness.mjs";

const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-last-viewed-"));
await mkdir(path.join(scratch, "data"));
await mkdir(path.join(scratch, "state/main-session"), { recursive: true });
await writeFile(path.join(scratch, "data/projects.md"), "- Alpha - Synthetic selected lane\n- Beta - Synthetic context lane\n");
const records = Array.from({ length: 451 }, (_, index) => JSON.stringify({
  type: "message", timestamp: new Date(Date.UTC(2030, 0, 1, 12, index)).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: ["General", "Alpha", "Beta"].map((name) =>
    `[fm-lane ${name}]\n${name} update ${index}: **Synthetic reading checkpoint**.\nA second line of context for this message.\n[end ${name}]`).join("\n\n") }] },
}));
await writeFile(path.join(scratch, "state/main-session/session.jsonl"), records.join("\n") + "\n");
const server = createServer({}, {
  lanesReader: async (_, options) => loadFirstmateHome(scratch, options),
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const command = (...args) => browser.command(...args);
  const evaluate = (...args) => browser.evaluate(...args);
  const until = (...args) => browser.until(...args);
  const url = `http://127.0.0.1:${server.address().port}/#lanes`;
  const checkpoint = () => evaluate(`(() => {
    const feed = document.querySelector('#messages'), bounds = feed.getBoundingClientRect();
    const visible = [...feed.querySelectorAll('article.message')].filter(n => { const r=n.getBoundingClientRect(); return r.bottom>bounds.top && r.top<bounds.bottom; });
    const full = visible.filter(n => { const r=n.getBoundingClientRect(); return r.top>=bounds.top && r.bottom<=bounds.bottom; });
    const node = full.at(-1) || visible[0];
    return { key: node.dataset.recordKey, index: Number(node.dataset.recordIndex) };
  })()`);
  const solo = (id) => evaluate(`while(true) {
    const input=[...document.querySelectorAll('#lane-filter-rows input[data-filter-lane]')].find(i => i.checked !== (i.dataset.filterLane === ${JSON.stringify(id)}));
    if (!input) break; input.click();
  }`);
  const shown = () => evaluate("!document.querySelector('#jump-to-last-viewed').disabled");
  for (const [width, height] of [[1600, 900], [390, 844]]) {
    browser = await openBrowser();
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await command("Page.navigate", { url });
    await until("document.querySelectorAll('article.message').length > 0");
    await solo("alpha");
    assert.equal(await shown(), false, "no checkpoint yet");
    assert.match(await evaluate("document.querySelector('#transcript-page').textContent"), /401–451 of 451/);
    await evaluate("document.querySelector('#transcript-older').click(); document.querySelector('#transcript-older').click()");
    await evaluate(`(() => {
      const feed = document.querySelector('#messages');
      const target = feed.querySelector('[data-record-index="30"]');
      feed.scrollTop += target.getBoundingClientRect().top - feed.getBoundingClientRect().top - 12;
    })()`);
    const saved = await checkpoint();
    await evaluate("document.querySelector('[data-view=overview]').click()");
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('fm-agentos-last-viewed.v1')).some(([, key]) => key === ${JSON.stringify(saved.key)})`), true, "leaving the view saves the last fully visible record");
    await evaluate("document.querySelector('[data-view=conversations]').click()");
    await solo("beta");
    assert.equal(await shown(), false, "other lane has an independent checkpoint");
    await solo("alpha");
    await until("!document.querySelector('#jump-to-last-viewed').disabled");
    const latestTop = await evaluate("document.querySelector('#messages').scrollTop");
    await evaluate("document.querySelector('#refresh').click()");
    await until("!document.querySelector('#refresh').disabled");
    assert.equal(await evaluate("document.querySelector('#messages').scrollTop"), latestTop, "refresh does not disturb current position");
    await openReadingControls(browser);
    const readingGeometry = await evaluate("[...document.querySelectorAll('.feed-jump-controls button')].map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})");
    for(const rect of readingGeometry)assert.ok(rect.left>=0&&rect.right<=width&&rect.height>=44);
    await evaluate("document.querySelector('#jump-to-last-viewed').focus()");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("document.activeElement.dataset.recordKey"), saved.key);
    assert.match(await evaluate("document.querySelector('#transcript-page').textContent"), /1–200 of 451/, "cross-page jump must override follow-latest");
    const geometry = await evaluate(`(() => {
      const feed=document.querySelector('#messages'), target=document.activeElement;
      const a=feed.getBoundingClientRect(), b=target.getBoundingClientRect();
      return { offset:b.top-a.top, highlighted:target.classList.contains('last-viewed-highlight'),
        expanded:[...target.querySelectorAll('.mixed-lane-toggle')].map(n => n.getAttribute('aria-expanded')),
        overflow:document.documentElement.scrollWidth>innerWidth,
        buttons:[...document.querySelectorAll('.feed-jump-controls button')].filter(n=>!n.classList.contains('hidden')).map(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};}),
        feed:{left:a.left,right:a.right,bottom:a.bottom} };
    })()`);
    assert.ok(Math.abs(geometry.offset - 12) < 2, JSON.stringify(geometry));
    assert.equal(geometry.highlighted, true);
    assert.deepEqual(geometry.expanded, ["false", "true", "false"], "lane disclosure defaults are unchanged");
    assert.equal(geometry.overflow, false);
    assert.equal(await evaluate("!!document.querySelector('.feed-jump-controls').closest(innerWidth<=720?'#mobile-chat-options':'.conversation-head')"),true);
    assert.equal(await shown(), false, "checkpoint is disabled at the returned message, not hidden");
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `last-viewed-${width}x${height}.png`), Buffer.from(data, "base64"));
    }
    await until("!document.querySelector('.last-viewed-highlight')");
    await openReadingControls(browser);
    await evaluate("document.querySelector('#jump-to-latest').click()");
    assert.ok(await evaluate("Math.abs(document.querySelector('#messages').scrollHeight - document.querySelector('#messages').scrollTop - document.querySelector('#messages').clientHeight) < 2"), "Jump to latest reaches the newest page bottom");
    await until("!document.querySelector('#jump-to-last-viewed').disabled");
    assert.match(await evaluate("document.querySelector('#transcript-page').textContent"), /401–451 of 451/, "latest selects the newest loaded page");
    assert.equal(await shown(), true, "earlier checkpoint is available after the scroll event");
    await openReadingControls(browser);
    await evaluate("document.querySelector('#jump-to-last-viewed').click()");
    await evaluate("window.dispatchEvent(new Event('blur'))");
    const beforeReload = await checkpoint();
    await command("Page.reload");
    await until("document.querySelector('#jump-to-last-viewed') && !document.querySelector('#jump-to-last-viewed').disabled");
    await openReadingControls(browser);
    await evaluate("document.querySelector('#jump-to-last-viewed').click()");
    assert.equal(await evaluate("document.activeElement.dataset.recordKey"), beforeReload.key, "reload restores the departure checkpoint from local storage");
    await evaluate("document.querySelector('#transcript-search').value='update 30:'; document.querySelector('#transcript-search').dispatchEvent(new Event('input', {bubbles:true}))");
    await until("document.querySelectorAll('article.message').length === 1");
    assert.equal(await shown(), false, "search has its own view checkpoint");
    await evaluate("document.querySelector('#transcript-search-clear').click(); document.querySelector('#transcript-older').click()");
    assert.match(await evaluate("document.querySelector('#transcript-page').textContent"), /201–400 of 451/, "paging still works after search and restoration");
    if (process.env.SCREENSHOT_DIR) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `last-viewed-controls-${width}x${height}.png`), Buffer.from(data, "base64"));
    }
    console.log(`${width}x${height}: departure/filter checkpoints, refresh, keyboard cross-page return, focus/highlight, reload, latest, search, paging and disclosure geometry passed`);
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
