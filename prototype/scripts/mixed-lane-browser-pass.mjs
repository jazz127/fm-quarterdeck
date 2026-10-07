// Offline mixed-lane disclosure acceptance, using real transcript projections.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser } from "./browser-harness.mjs";
import { claudeProjectDirectory } from "../claude-transcript.js";

const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-mixed-lanes-"));
await mkdir(path.join(scratch, "data"));
await mkdir(path.join(scratch, "state"));
const config = path.join(scratch, "claude"), directory = claudeProjectDirectory(config, scratch);
await mkdir(directory, { recursive: true });
await writeFile(path.join(scratch, "state/.lock-session"), "primary-fixture\n");
await writeFile(path.join(scratch, "data/projects.md"), "- Alpha - Synthetic selected lane\n- fm-quarterdeck - Current product\n- fm-AgentOS - Historical product\n");
const text = ["General", "Alpha-UI", "fm-quarterdeck-Long-Context-Theme"].map((name) => `[fm-lane ${name}]\n${name} context **update**.\nSecond context line.\n[end ${name}]`).join("\n\n");
const single = "[fm-lane fm-quarterdeck-UI]\nAlpha is mentioned here only as contextual noise.\n[end fm-quarterdeck-UI]";
await writeFile(path.join(directory, "primary-fixture.jsonl"), [text, single].map((text, index) => JSON.stringify({ type: "assistant", uuid: `fixture-reply-${index}`, sessionId: "primary-fixture", timestamp: `2030-01-01T12:00:0${index}Z`, message: { role: "assistant", model: "fixture-model", content: [{ type: "text", text }] } })).join("\n") + "\n");
const server = createServer({}, {
  lanesReader: async (_, options) => loadFirstmateHome(scratch, { ...options, claudeConfigDir: config }),
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await openBrowser();
  const { command, evaluate, until } = browser;
  for (const [width, height] of [[1600, 900], [390, 844]]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#lanes` });
    await until("document.querySelectorAll('.mixed-lane-toggle').length === 3");
    // Re-query after each click because filter rendering replaces the inputs.
    const selectAll = () => evaluate("while(true) { const input=document.querySelector('#lane-filter-rows input[data-filter-lane]:not(:checked)'); if(!input) break; input.click(); }");
    await selectAll();
    assert.equal(await evaluate("document.querySelectorAll('.mixed-lane-toggle[aria-expanded=true]').length"), 3);
    assert.equal(await evaluate("document.querySelectorAll('article.message').length"), 2, "one mixed original plus one single-theme reply, not duplicate projections");
    // The visible fleet name is a solo selector; do not bypass it with globals.
    await evaluate("document.querySelector('.lane-option[data-lane-id=alpha] .lane-option-copy').click()");
    assert.equal(await evaluate("location.hash"), "#lanes/alpha");
    assert.equal(await evaluate("document.querySelectorAll('article.message').length"), 1, "the product-only theme reply must not leak into Alpha even when it mentions Alpha");
    assert.equal(await evaluate("document.querySelector('#messages').textContent.includes('contextual noise')"), false);
    const state = () => evaluate("[...document.querySelectorAll('.mixed-lane-toggle')].map(b => ({name:b.querySelector('strong').textContent, expanded:b.getAttribute('aria-expanded'), hidden:document.getElementById(b.getAttribute('aria-controls')).hidden}))");
    assert.deepEqual(await state(), [
      { name: "General", expanded: "false", hidden: true },
      { name: "Alpha-UI", expanded: "true", hidden: false },
      { name: "fm-quarterdeck-Long-Context-Theme", expanded: "false", hidden: true },
    ]);
    assert.equal(await evaluate("[...document.querySelectorAll('.mixed-lane-toggle')].every(b => b.textContent.includes('[fm-lane '))"), true, "the visible marker label is the toggle");
    assert.equal(await evaluate("[...document.querySelectorAll('.mixed-lane-content')].some(b => b.textContent.includes('[fm-lane '))"), false, "no duplicated marker beneath a separate button");
    // Direct hierarchy/task links route through the same parent fleet selection.
    await command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#lanes/alpha` });
    await until("document.querySelectorAll('.mixed-lane-toggle[aria-expanded=false]').length === 2");
    await evaluate("document.querySelector('.mixed-lane-toggle').focus()");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal((await state())[0].expanded, "true", "native keyboard activation expands hidden context");
    assert.equal(await evaluate("document.activeElement.matches('.mixed-lane-toggle')"), true, "toggle retains focus");
    await evaluate("document.querySelector('.mixed-lane-toggle').click()");
    assert.equal((await state())[0].hidden, true);
    // Force a same-selection rerender; choices remain tab-local, not stored.
    await evaluate("document.querySelectorAll('.mixed-lane-toggle')[2].click(); document.querySelector('#message-format-toggle').click()");
    assert.equal((await state())[2].expanded, "true");
    assert.equal(await evaluate("document.querySelector('.message-content').classList.contains('raw')"), true);
    await evaluate("document.querySelector('#message-format-toggle').click(); document.querySelectorAll('.mixed-lane-toggle')[2].click()");
    assert.equal((await state())[2].hidden, true);
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('.mixed-lane-heading, .message-content')].some(n => n.scrollWidth > n.clientWidth + 1)"), false, "long lane labels do not overflow the phone message");
    // No local preference is introduced; All defaults to every section expanded.
    await selectAll();
    assert.equal(await evaluate("document.querySelectorAll('.mixed-lane-content[hidden]').length"), 0);
    console.log(`${width}x${height}: mixed-lane filtering, keyboard/click toggles, raw format and rerender persistence passed`);
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
