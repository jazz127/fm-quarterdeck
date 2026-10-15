import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { openBrowser } from "../scripts/browser-harness.mjs";

const chromiumAvailable = (() => {
  try { execFileSync(process.env.CHROMIUM || "chromium", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

test("second mates disclosure supports keyboard activation, refreshes and collapsed fresh loads", {
  skip: !chromiumAvailable && "Chromium unavailable",
}, async (t) => {
  let reads = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/dashboard") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        fleet: { source: "fixture", summary: {}, projects: [], secondmates: {
          items: [{ id: "navigator", summary: "Review", scope: "Review", location: "local", state: "idle", stateEvidence: "Idle", backlog: null }],
          warning: `Registry unavailable (${++reads})`,
        } },
        expenses: { source: "fixture", entryCount: 0, overall: [], entries: [] },
      }));
      return;
    }
    if (pathname.startsWith("/api/")) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unavailable in disclosure fixture" }));
      return;
    }
    const asset = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!/^[\w.-]+$/.test(asset)) { response.writeHead(404).end(); return; }
    try {
      const contents = await readFile(new URL(`../public/${asset}`, import.meta.url));
      const type = asset.endsWith(".js") ? "text/javascript" : asset.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(contents);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await openBrowser();
  t.after(() => browser.close());
  await browser.command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#overview` });
  await browser.until("document.querySelector('#secondmates-count')?.textContent === '1'");

  const assertDisclosure = async (open) => {
    assert.deepEqual(await browser.evaluate(`(() => {
      const toggle = document.querySelector('#secondmates-toggle');
      const cards = document.querySelector('#secondmates');
      return {
        expanded: toggle.getAttribute('aria-expanded'), hidden: cards.hidden,
        cardVisible: cards.querySelector('.secondmate-card').getClientRects().length > 0,
        warningVisible: document.querySelector('#secondmates-state').getClientRects().length > 0,
        count: document.querySelector('#secondmates-count').textContent,
      };
    })()`), { expanded: String(open), hidden: !open, cardVisible: open, warningVisible: true, count: "1" });
  };
  const refresh = async () => {
    const previous = await browser.evaluate("document.querySelector('#secondmates-state').textContent");
    await browser.evaluate("document.querySelector('#refresh').click()");
    await browser.until(`document.querySelector('#secondmates-state').textContent !== ${JSON.stringify(previous)}`);
  };
  const activate = async (key, code, virtualKey) => {
    await browser.evaluate("document.querySelector('#secondmates-toggle').focus()");
    assert.equal(await browser.evaluate("document.activeElement.id"), "secondmates-toggle");
    for (const type of ["keyDown", "keyUp"]) {
      await browser.command("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: virtualKey });
    }
  };

  await assertDisclosure(false);
  for (const key of [["Enter", "Enter", 13], [" ", "Space", 32]]) {
    await activate(...key);
    await assertDisclosure(true);
    await refresh();
    await assertDisclosure(true);
    await activate(...key);
    await assertDisclosure(false);
    await refresh();
    await assertDisclosure(false);
  }
  await browser.evaluate("document.querySelector('#secondmates-toggle').click()");
  await assertDisclosure(true);
  const previousOrigin = await browser.evaluate("performance.timeOrigin");
  await browser.command("Page.reload");
  await browser.until(`performance.timeOrigin !== ${previousOrigin} && document.querySelector('#secondmates-count')?.textContent === '1'`);
  await assertDisclosure(false);
});
