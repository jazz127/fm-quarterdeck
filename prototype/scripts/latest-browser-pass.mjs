// Offline Latest regression and desktop/tablet/phone reading-intent acceptance.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser, openReadingControls, closeReadingControls } from "./browser-harness.mjs";

const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-latest-"));
await mkdir(path.join(scratch, "data"));
await mkdir(path.join(scratch, "state/main-session"), { recursive: true });
await writeFile(path.join(scratch, "data/projects.md"), "- Alpha - Synthetic selected fleet\n- Beta - Synthetic other fleet\n");
const record = (index) => JSON.stringify({
  type: "message", timestamp: new Date(Date.UTC(2030, 0, 1, 12, index)).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text:
    `[fm-lane Alpha]\nAlpha update ${index}: **Synthetic latest acceptance**.\n${"A tall paragraph of original context. ".repeat(12)}\n[end Alpha]\n\n[fm-lane Beta]\nOther fleet original ${index}.\n[end Beta]` }] },
});
let records;
const save = () => writeFile(path.join(scratch, "state/main-session/session.jsonl"), records.join("\n") + "\n");
const server = createServer({}, {
  lanesReader: async (_, options) => loadFirstmateHome(scratch, options),
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const [width, height] of [[1600, 900], [1024, 768], [390, 844]]) {
    records = Array.from({ length: 451 }, (_, index) => record(index));
    await save();
    browser = await openBrowser();
    const { command, evaluate, until } = browser;
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#lanes` });
    await until("document.querySelectorAll('article.message').length > 0");
    await evaluate(`while(true) {
      const input=[...document.querySelectorAll('#lane-filter-rows input[data-filter-lane]')].find(i => i.checked !== (i.dataset.filterLane === 'alpha'));
      if (!input) break; input.click();
    }`);
    const source = await evaluate(`(() => {
      const picker=document.querySelector('#transcript-session');
      picker.value=picker.options[1].value; picker.dispatchEvent(new Event('change',{bubbles:true}));
      return picker.value;
    })()`);
    const distance = () => evaluate("(() => {const f=document.querySelector('#messages'); return f.scrollHeight-f.scrollTop-f.clientHeight;})()");
    const trackNativeScroll = () => evaluate("window.latestScrollEnd = new Promise(resolve => document.querySelector('#messages').addEventListener('scrollend', () => resolve(true), {once:true})); true");
    const scrollUp = async (pixels) => {
      await evaluate(`(() => {const f=document.querySelector('#messages'); f.scrollTop=f.scrollHeight-f.clientHeight-${pixels}; f.dispatchEvent(new Event('scroll'));})()`);
    };
    const geometry = () => evaluate(`(() => {
      const button=document.querySelector('#jump-to-latest-floating'), r=button.getBoundingClientRect();
      const feed=document.querySelector('#messages').getBoundingClientRect();
      const dock=document.querySelector('#mobile-dock')?.getBoundingClientRect();
      return {hidden:button.hidden,width:r.width,height:r.height,inside:r.left>=feed.left && r.right<=feed.right && r.bottom<=feed.bottom,
        clearDock:!dock?.height || r.bottom<=dock.top,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button};
    })()`);
    const atLatest = async () => {
      assert.ok(await distance() <= 1, "Latest reaches the native scroll bottom");
      assert.equal(await evaluate("document.querySelector('#jump-to-latest-floating').hidden"), true);
      assert.equal(await evaluate("document.querySelector('#transcript-newer').disabled"), true, "latest loaded page selected");
      assert.ok(await evaluate(`(() => {const f=document.querySelector('#messages'), r=f.getBoundingClientRect();
        const last=f.querySelector('article.message:last-child').getBoundingClientRect();
        const dock=document.querySelector('#mobile-dock')?.getBoundingClientRect();
        return last.bottom<=r.bottom && (!dock?.height || last.bottom<=dock.top);})()`), "last original row clears feed and dock");
    };
    await atLatest();
    // This assertion fails on the original 60px tolerance, before any new control is needed.
    await scrollUp(50);
    assert.equal(await evaluate("document.querySelector('#jump-to-latest').disabled"), false, "Latest must be enabled 50px short of bottom");
    await closeReadingControls(browser);
    const g = await geometry();
    assert.ok(!g.hidden && g.width >= 44 && g.height >= 44 && g.inside && g.clearDock && g.hit,
      "floating Latest is reachable with menus closed and clears feed/composer/dock");
    const reading = await evaluate("document.querySelector('#messages').scrollTop");
    records.push(...Array.from({ length: 5 }, (_, i) => record(451 + i)));
    await save();
    await evaluate("document.querySelector('#refresh').click()");
    await until("document.querySelector('#transcript-page').textContent.includes('of 456')");
    assert.equal(await evaluate("document.querySelector('#messages').scrollTop"), reading, "refresh preserves reading intent even 50px from bottom");
    await evaluate("document.querySelector('#jump-to-latest-floating').click()");
    await atLatest();
    assert.equal(await evaluate("document.activeElement.id"), "messages", "activation returns keyboard focus to feed");
    records.push(record(456));
    await save();
    await evaluate("document.querySelector('#refresh').click()");
    await until("document.querySelector('#transcript-page').textContent.includes('of 457')");
    await atLatest();
    await scrollUp(4);
    assert.equal(await evaluate("document.querySelector('#jump-to-latest-floating').hidden"), true, "4px bottom tolerance");
    await scrollUp(5);
    assert.equal(await evaluate("document.querySelector('#jump-to-latest-floating').hidden"), false, "5px shows suggestion");
    for (const key of ["Enter", " "]) {
      await scrollUp(50);
      await evaluate("document.querySelector('#messages').focus()");
      await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await evaluate("document.querySelector('#jump-to-latest-floating').focus()");
      assert.equal(await evaluate("document.activeElement.id"), "jump-to-latest-floating");
      assert.ok(await evaluate("getComputedStyle(document.activeElement).outlineStyle !== 'none'"), "keyboard focus is visible");
      await command("Input.dispatchKeyEvent", { type: "keyDown", key, code: key === " " ? "Space" : "Enter", windowsVirtualKeyCode: key === " " ? 32 : 13, text: key === " " ? " " : "\r" });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key, code: key === " " ? "Space" : "Enter", windowsVirtualKeyCode: key === " " ? 32 : 13 });
      await atLatest();
    }
    // Actual native scroll gestures and pointer activation, with menus closed.
    await trackNativeScroll();
    const point = await evaluate("(() => {const r=document.querySelector('#messages').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    if (width < 720) {
      await command("Emulation.setTouchEmulationEnabled", { enabled: true });
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await command("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...point, y: point.y + 120 }] });
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await command("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -120 });
    }
    await until("!document.querySelector('#jump-to-latest-floating').hidden");
    await evaluate("window.latestScrollEnd");
    const pill = await evaluate("(() => {const r=document.querySelector('#jump-to-latest-floating').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()");
    if (width < 720) {
      await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pill] });
      await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...pill });
      assert.equal(await evaluate("getComputedStyle(document.querySelector('#jump-to-latest-floating')).color"), "rgb(255, 255, 255)", "hover uses accent treatment");
      await command("Input.dispatchMouseEvent", { type: "mousePressed", ...pill, button: "left", clickCount: 1 });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...pill, button: "left", clickCount: 1 });
    }
    await until("document.querySelector('#jump-to-latest-floating').hidden");
    await atLatest();
    await evaluate("document.querySelector('#messages').focus()");
    await trackNativeScroll();
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 });
    await until("!document.querySelector('#jump-to-latest-floating').hidden");
    await evaluate("window.latestScrollEnd");
    await evaluate("document.querySelector('#jump-to-latest-floating').click()");
    await atLatest();
    await openReadingControls(browser);
    await evaluate("(() => {document.querySelector('#transcript-older').click(); const f=document.querySelector('#messages');f.scrollTop=f.scrollHeight;f.dispatchEvent(new Event('scroll'));})()");
    await closeReadingControls(browser);
    assert.equal((await geometry()).hidden, false, "older-page bottom still offers global Latest");
    const olderPosition = await evaluate("document.querySelector('#messages').scrollTop");
    records.push(record(457));
    await save();
    await evaluate("document.querySelector('#refresh').click()");
    await until("document.querySelector('#transcript-page').textContent.includes('201–400 of 458')");
    assert.equal(await evaluate("document.querySelector('#messages').scrollTop"), olderPosition, "incoming rows preserve older-page reading position");
    await evaluate("document.querySelector('#jump-to-latest-floating').click()");
    await atLatest();
    await openReadingControls(browser);
    await evaluate("document.querySelector('#transcript-search').value='Synthetic latest';document.querySelector('#transcript-search').dispatchEvent(new Event('input',{bubbles:true}))");
    await until("document.querySelector('#transcript-page').textContent.includes('for “Synthetic latest”')");
    await evaluate("document.querySelector('#message-compact-toggle').click()");
    assert.equal(await evaluate("document.querySelector('#messages').classList.contains('is-compact')"), true);
    await closeReadingControls(browser);
    const selection = await evaluate("JSON.stringify([...document.querySelectorAll('input[data-filter-lane], #message-type-filters input')].map(n=>[n.value,n.checked]))");
    await scrollUp(50);
    assert.equal((await geometry()).hidden, false, "compact/search still offers Latest");
    await evaluate("document.querySelector('#jump-to-latest-floating').click()");
    await atLatest();
    assert.equal(await evaluate("document.querySelector('#transcript-search').value"), "Synthetic latest");
    assert.equal(await evaluate("document.querySelector('#transcript-session').value"), source, "selected source unchanged");
    assert.equal(await evaluate("JSON.stringify([...document.querySelectorAll('input[data-filter-lane], #message-type-filters input')].map(n=>[n.value,n.checked]))"), selection, "fleet and kind filters unchanged");
    await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await scrollUp(50);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#jump-to-latest-floating')).transitionDuration"), "0s");
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `latest-${width}x${height}.png`), Buffer.from(data, "base64"));
    }
    const allKeys = await evaluate(`(() => {
      const keys=[];
      for(let i=0;i<3;i++) {
        keys.push(...[...document.querySelectorAll('#messages article.message')].map(n=>n.dataset.recordKey));
        document.querySelector('#transcript-older').click();
      }
      return keys;
    })()`);
    assert.equal(new Set(allKeys).size, records.length, "all original records remain reachable across loaded pages");
    console.log(`${width}x${height}: 50px regression, floating geometry, reading intent, following, tolerance, keyboard, older page, filters, compact and reduced motion passed`);
    await browser.close();
    browser = null;
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
