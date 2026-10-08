import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "../server.js";
import { openBrowser } from "../scripts/browser-harness.mjs";

const window = {};
vm.runInContext(await readFile(new URL("../public/filter-view.js", import.meta.url), "utf8"), vm.createContext({ window }));
const { MIN_FEED_WIDTH } = window.filterView;
const fitDesktopPanels = (...args) => ({ ...window.filterView.fitDesktopPanels(...args) });
const open = { lane: true, kind: true };

test("desktop filter panels yield, kinds first, to keep the feed at its minimum width", () => {
  assert.equal(MIN_FEED_WIDTH, 480);
  assert.deepEqual(fitDesktopPanels(1000, open), { lane: true, kind: true });
  assert.deepEqual(fitDesktopPanels(899, open), { lane: true, kind: false });
  assert.deepEqual(fitDesktopPanels(600, open), { lane: false, kind: false });
  assert.deepEqual(fitDesktopPanels(1000, { lane: false, kind: true }), { lane: false, kind: true });
  // The panel the user just expanded stays open; the other yields instead.
  assert.deepEqual(fitDesktopPanels(833, open, "kind"), { lane: false, kind: true });
  assert.deepEqual(fitDesktopPanels(833, open, "lane"), { lane: true, kind: false });
  assert.deepEqual(fitDesktopPanels(600, open, "kind"), { lane: false, kind: false });
});

const chromiumAvailable = (() => { try { execFileSync(process.env.CHROMIUM || "chromium", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const lane = (id) => ({ id, name: id, status: "active", closed: false, messages: [{ recordId: `fixture:${id}`, author: "Firstmate", role: "firstmate", kind: "conversation", text: id, source: "fixture", time: "12:00", occurredAt: "2030-01-01T12:00:00Z" }], sessions: [], items: [], crew: 0, mission: "Fixture" });

test("chat feed keeps its minimum width with the Message kinds panel and task rail open", { skip: !chromiumAvailable && "Chromium unavailable" }, async (t) => {
  const fixture = { source: "fixture", lanes: [lane("general"), lane("working")], transcript: { sessions: [], warnings: [], note: "Fixture coverage" } };
  let finishRead;
  // Hold the API independently of application startup so both loading and
  // loaded layout are checked, not just whichever phase wins the CI race.
  const app = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { lanesReader: () => new Promise((resolve) => { finishRead = resolve; }) });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(() => { finishRead?.(fixture); app.close(); });
  if (!(await fetch(base)).ok) return t.skip("Quarterdeck serves only from a clean committed checkout");
  const browser = await openBrowser();
  t.after(() => browser.close());
  // Deterministically reproduce the old readiness bug: static loading children
  // exist while the default Overview is still active and app.js is pending.
  let appRequest;
  browser.onEvent((event) => { if (event.method === "Fetch.requestPaused") appRequest = event.params.requestId; });
  await browser.command("Fetch.enable", { patterns: [{ urlPattern: "*/app.js" }] });
  for (const [width, height] of [[1700, 1300], [1366, 768], [1440, 900], [1920, 1080], [1280, 800], [1201, 800], [1024, 768], [390, 844]]) {
    await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    const previousOrigin = await browser.evaluate("performance.timeOrigin");
    finishRead = undefined;
    await browser.command("Page.navigate", { url: `${base}/?viewport=${width}#lanes` });
    if (width === 1700) {
      await browser.until(`performance.timeOrigin !== ${previousOrigin} && document.querySelector('#messages')?.children.length > 0`);
      const beforeRoute = await browser.evaluate(`({ view: document.querySelector('#lanes').dataset.view, active: document.querySelector('#conversations-view').classList.contains('active') })`);
      assert.deepEqual(beforeRoute, { view: "overview", active: false }, "placeholder children do not mean the Fleet Chats route is ready");
      await browser.command("Fetch.continueRequest", { requestId: appRequest });
      await browser.command("Fetch.disable");
    }
    await browser.until(`performance.timeOrigin !== ${previousOrigin} && innerWidth === ${width} && document.querySelector('#lanes')?.dataset.view === 'conversations' && document.querySelector('#conversations-view.active') && document.querySelector('#messages[aria-busy=true] [role=status]')`);
    // The loading DOM can precede the server receiving its request as well.
    for (let attempt = 0; !finishRead && attempt < 100; attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(typeof finishRead, "function", "the controlled lane read started");
    for (const phase of ["loading", "loaded"]) {
      if (phase === "loaded") {
        finishRead(fixture);
        await browser.until(`document.querySelector('#messages[aria-busy=false] article.message')`);
      }
      await browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const feed = await browser.evaluate(`document.querySelector('#messages').getBoundingClientRect().width`);
      assert.ok(feed >= (width > 1200 ? MIN_FEED_WIDTH : 360), `feed ${feed}px at ${width}px viewport while ${phase}`);
    }
  }
});

// The captain's path: visiting any other view first makes the shell's route sync close the fleet filters. Windows display scaling shrinks the CSS viewport (window px / scale), and a
// restored oversized shell width must not eat into the feed either.
test("chat feed keeps its minimum width after navigating to Fleet Chats at any display scale and restored width", { skip: !chromiumAvailable && "Chromium unavailable" }, async (t) => {
  const { CONVERSATION_MIN_WIDTH, SHELL_WIDTH_KEY } = await import("../public/shell-panel-layout.js");
  assert.equal(CONVERSATION_MIN_WIDTH, MIN_FEED_WIDTH, "shell clamp and panel fitter agree on the feed minimum");
  const app = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { lanesReader: async () => ({ source: "fixture", lanes: [lane("general"), lane("working")], transcript: { sessions: [], warnings: [], note: "Fixture coverage" } }) });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(() => app.close());
  if (!(await fetch(base)).ok) return t.skip("Quarterdeck serves only from a clean committed checkout");
  const browser = await openBrowser();
  t.after(() => browser.close());
  const viewports = [[1201, 1], [1280, 1], [1366, 1], [1920, 1], [1717, 1.25], [1920, 1.25], [2400, 1.25], [1920, 1.5], [2560, 1.5]]
    .map(([windowWidth, scale]) => [Math.floor(windowWidth / scale), scale]);
  for (const restored of [null, { [SHELL_WIDTH_KEY]: "9999", "fm-agentos-review-panel-width.v1": "9999" }]) {
    for (const [width, scale] of viewports) {
      await browser.command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: scale, mobile: false });
      await browser.command("Page.navigate", { url: `${base}/` });
      await browser.until(`innerWidth === ${width} && document.readyState === "complete"`);
      await browser.evaluate(`localStorage.clear(); Object.entries(${JSON.stringify(restored ?? {})}).forEach(([key, value]) => localStorage.setItem(key, value))`);
      await browser.command("Page.reload");
      // app.js relabels the fleet filter toggle once its handlers are wired.
      await browser.until(`document.querySelector('#lanes')?.dataset.view === "conversations" && document.querySelector('#lane-filter-toggle')?.getAttribute('aria-label') !== "Open conversation filters"`);
      for (const view of ["work", "conversations"]) {
        await browser.evaluate(`document.querySelector('.primary-tab[data-view="${view}"]').click()`);
        await browser.until(`document.querySelector('#lanes').dataset.view === "${view}"`);
      }
      await browser.until(`document.querySelector('#conversations-view.active') && document.querySelector('#messages[aria-busy=false] article.message')`);
      await browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const layout = await browser.evaluate(`(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { laneHidden: document.querySelector('#lane-options').hidden, lane: box('#lane-options').right, feed: box('#messages'), kind: box('#conversation-kind-panel').left };
      })()`);
      const at = `${width}px CSS viewport at ${scale}x${restored ? " with restored oversized widths" : ""}`;
      assert.equal(layout.laneHidden, false, `fleets panel keeps its column at ${at}`);
      assert.ok(layout.feed.left >= layout.lane - 1 && layout.feed.right <= layout.kind + 1, `feed sits between the filter panels at ${at}: ${JSON.stringify(layout)}`);
      assert.ok(layout.feed.width >= MIN_FEED_WIDTH, `feed ${layout.feed.width}px at ${at}`);
      if (restored || width !== 1373) continue;
      // The captain's 1717px window at 125%: Message kinds starts collapsed; expanding it makes the fleets panel yield.
      await browser.evaluate(`document.querySelector('#kind-panel-toggle').click()`);
      await browser.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const opened = await browser.evaluate(`({ kind: document.querySelector('#conversation-kind-panel').dataset.collapsed, lane: document.querySelector('#lane-options').dataset.collapsed, feed: document.querySelector('#messages').getBoundingClientRect().width })`);
      assert.deepEqual({ kind: opened.kind, lane: opened.lane }, { kind: "false", lane: "true" });
      assert.ok(opened.feed >= MIN_FEED_WIDTH, `feed ${opened.feed}px with Message kinds expanded at ${at}`);
    }
  }
});
