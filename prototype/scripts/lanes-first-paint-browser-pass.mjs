// Offline first-paint, source-window expansion and compact-wire acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser } from "./browser-harness.mjs";

const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-first-paint-"));
await mkdir(path.join(home, "data"));
await mkdir(path.join(home, "state/main-session"), {recursive: true});
await writeFile(path.join(home, "data/projects.md"), "- Alpha - Synthetic fleet\n");
const turns = Array.from({length: 160}, (_, index) => JSON.stringify({
  type: "message", timestamp: new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString(),
  padding: "x".repeat(10000), message: {role: "assistant", content: index === 0 ? "Alpha archive-only sentinel" : `Alpha recent turn ${index}`},
}));
await writeFile(path.join(home, "state/main-session/source.jsonl"), turns.join("\n") + "\n");
let failExpansion = true;
const requests = [];
const server = createServer({}, {
  lanesReader: async (_, options) => {
    requests.push(options.windowBytes);
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (options.windowBytes === 2 * 1024 * 1024 && failExpansion) {
      failExpansion = false;
      throw Error("Synthetic expansion failure");
    }
    return loadFirstmateHome(home, options);
  },
  quotaReader: async () => ({providers: [], error: "Offline fixture", stale: false}),
  costReader: async () => ({azure: {state: "unavailable"}, github: {state: "unavailable"}}),
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await openBrowser();
  const {command, evaluate, until} = browser;
  await command("Page.addScriptToEvaluateOnNewDocument", {source: "localStorage.clear()"});
  for (const [width, height] of [[1600, 900], [390, 844]]) {
    await command("Emulation.setDeviceMetricsOverride", {width, height, deviceScaleFactor: 1, mobile: width < 720});
    const origin = await evaluate("performance.timeOrigin");
    await command("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?width=${width}#lanes`});
    await until(`performance.timeOrigin !== ${origin} && document.querySelector('#messages[aria-busy=true] [role=status]')`);
    assert.match(await evaluate("document.querySelector('#messages').textContent"), /Loading Fleet Chats/);
    assert.doesNotMatch(await evaluate("document.querySelector('#messages').textContent"), /Choose at least one/);
    await until("document.querySelector('article.message') && document.querySelector('#messages').getAttribute('aria-busy') === 'false'");
    const recentKey = await evaluate("document.querySelector('article.message:last-of-type').dataset.recordKey");
    assert.equal(await evaluate("document.querySelector('#transcript-window-status').hidden"), false);
    assert.match(await evaluate("document.querySelector('#transcript-window-status').textContent"), /Search covers loaded records/);
    // The visible fleet name is the solo control. Keep its selection, query and
    // raw formatting unchanged through a failed expansion and its exact retry.
    await evaluate("document.querySelector('.lane-option[data-lane-id=alpha] .lane-option-copy').click(); document.querySelector('#message-format-toggle').click(); {const q=document.querySelector('#transcript-search'); q.value='archive-only'; q.dispatchEvent(new Event('input',{bubbles:true}))}");
    await until("document.querySelector('#messages').textContent.includes('No records match')");
    await evaluate("document.querySelector('#transcript-load-more').click()");
    if (width === 1600) {
      await until("document.querySelector('#transcript-load-more').textContent.includes('Retry')");
      assert.equal(await evaluate("document.querySelector('#transcript-search').value"), "archive-only");
      await evaluate("document.querySelector('#transcript-load-more').click()");
    }
    await until("document.querySelector('article.message')?.textContent.includes('archive-only sentinel')");
    if (width === 1600) assert.deepEqual(requests.slice(-2), [2 * 1024 * 1024, 2 * 1024 * 1024], "failure retries the same window, not the next size");
    assert.equal(await evaluate("location.hash"), "#lanes/alpha");
    assert.equal(await evaluate("document.querySelector('#transcript-search').value"), "archive-only");
    assert.equal(await evaluate("document.querySelector('.message-content').classList.contains('raw')"), true);
    assert.equal(await evaluate("document.querySelector('#transcript-window-status').hidden"), true);
    await evaluate("{const q=document.querySelector('#transcript-search'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true}))}");
    await until("document.querySelectorAll('article.message').length === 160");
    assert.equal(await evaluate(`!!document.querySelector('article[data-record-key="${recentKey}"]')`), true, "source identity survives whole-file expansion");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    console.log(`${width}x${height}: explicit loading, recent coverage, expansion/retry, filters and stable identity passed`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, {recursive: true, force: true});
}
