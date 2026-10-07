// Exact-build, direct local Chromium browser pass for Quota visualization on phone and desktop.
// Run: node scripts/quota-browser-pass.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { sanitizeQuota } from "../quota.js";

const chromium = process.env.CHROMIUM || "chromium";
const profile = await mkdtemp(path.join(os.tmpdir(), "quota-chrome-"));

const sampleRawQuota = {
  schemaVersion: 5,
  providers: [
    {
      provider: "codex",
      state: { status: "fresh", stale: false },
      quotaSemantics: {
        status: "known",
        effectiveAvailability: [{
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 19,
          boundedBy: ["weekly"],
          limitingWindowIds: ["weekly"],
          pace: { status: "ahead", worstReservePercentPoints: -6.45 }
        }]
      },
      windows: [{ id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 19, windowSeconds: 604800, resetsAt: "2026-09-30T17:50:00.000Z", pace: { status: "ahead", cycleBasis: "window_seconds", cycleSeconds: 604800, timeRemainingPercent: 79.1667, reservePercentPoints: -6.45 } }]
    },
    {
      provider: "grok",
      state: { status: "fresh", stale: false, authStatus: "usable" },
      quotaSemantics: {
        status: "known",
        effectiveAvailability: [{
          scope: "all_products",
          status: "known",
          effectivePercentRemaining: 12,
          boundedBy: ["credits"],
          limitingWindowIds: ["credits"],
          pace: { status: "ahead", worstReservePercentPoints: -70.15 }
        }]
      },
      windows: [
        { id: "credits", label: "week", kind: "weekly", percentRemaining: 12, startsAt: "2026-09-23T22:52:52.000Z", resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", cycleBasis: "starts_at_resets_at", cycleSeconds: 604800, reservePercentPoints: -70.15 } },
        { id: "product:grok_build", label: "Grok Build", kind: "weekly", percentRemaining: 43, startsAt: "2026-09-23T22:52:52.000Z", resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", cycleBasis: "starts_at_resets_at", cycleSeconds: 604800, reservePercentPoints: -70.15 } },
        { id: "product:chat", label: "Chat", kind: "weekly", percentRemaining: 80, startsAt: "2026-09-23T22:52:52.000Z", resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "behind", cycleBasis: "starts_at_resets_at", cycleSeconds: 604800 } }
      ]
    },
    {
      provider: "agy",
      state: { status: "fresh", stale: false },
      quotaSemantics: {
        status: "known",
        effectiveAvailability: [
          {
            scope: "gemini",
            status: "known",
            effectivePercentRemaining: 68,
            boundedBy: ["gemini_5h", "gemini_weekly"],
            limitingWindowIds: ["gemini_5h"],
            pace: { status: "unknown" }
          },
          {
            scope: "claude_gpt",
            status: "known",
            effectivePercentRemaining: 100,
            boundedBy: ["claude_gpt_5h", "claude_gpt_weekly"],
            limitingWindowIds: ["claude_gpt_5h"],
            pace: { status: "unknown" }
          }
        ]
      },
      windows: [
        { id: "gemini_5h", label: "Gemini 5-hour", kind: "session", percentRemaining: 68, resetsAt: "2026-09-25T05:56:31.000Z", resetText: "You have used some of your 5-hour limit, it will fully refresh in 1 hour, 4 minutes.", pace: { status: "unknown" } },
        { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly", percentRemaining: 78, resetsAt: "2026-09-30T03:37:19.000Z", resetText: "You have used some of your weekly limit, it will fully refresh in 4 days, 22 hours.", pace: { status: "unknown" } },
        { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session", percentRemaining: 100, resetsAt: "2026-09-25T09:51:35.000Z", pace: { status: "unknown" } },
        { id: "claude_gpt_weekly", label: "Claude/GPT weekly", kind: "weekly", percentRemaining: 100, resetsAt: "2026-10-02T04:51:35.000Z", pace: { status: "unknown" } }
      ]
    },
    { provider: "claude", state: { status: "auth_required", stale: false }, quotaSemantics: { status: "unknown", effectiveAvailability: [] }, windows: [] },
    { provider: "commandcode", state: { status: "auth_required", stale: false, authStatus: "unusable" }, quotaSemantics: { status: "unknown", effectiveAvailability: [] }, windows: [] }
  ]
};

const sanitizedFixture = {
  providers: sanitizeQuota(sampleRawQuota),
  readAt: "2026-09-25T04:50:00.000Z",
  ageMs: 12000,
  stale: false,
  error: null
};

const fakeQuotaReader = async () => sanitizedFixture;
const incompleteFixture = { providers: sanitizeQuota({ schemaVersion: 5, providers: [{
  provider: "cursor", state: { status: "fresh", stale: false },
  quotaSemantics: { status: "partial", effectiveAvailability: [] }, windows: [
    { id: "missing", label: "Unmeasured", kind: "weekly" },
    { id: "measured", label: "Measured", kind: "session", percentRemaining: 31 }
  ]
}] }), readAt: "2030-01-01T00:00:00.000Z", stale: false, error: null };

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const app = createServer({}, { quotaReader: fakeQuotaReader });
const incompleteApp = createServer({}, { quotaReader: async () => incompleteFixture });
await listen(app);
await listen(incompleteApp);
const base = `http://127.0.0.1:${app.address().port}`;
const incompleteBase = `http://127.0.0.1:${incompleteApp.address().port}`;

const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
let nextId = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const close = (server) => new Promise((resolve) => server.close(resolve));

try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "Chromium CDP port opened");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });

  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });

  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evalJs = async (code) => {
    const result = await cmd("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };

  await cmd("Page.enable");
  await cmd("Page.navigate", { url: base });

  // Wait for app and quota reading to render
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    loaded = await evalJs('Boolean(document.querySelector("#quota-strip .quota-badge") && document.querySelector("#sidebar-quota"))');
    if (loaded) break;
    await wait(100);
  }
  assert.ok(loaded, "Quarterdeck loaded with quota strip in Chromium");

  // ===================== DESKTOP VERIFICATION (1280x844) =====================
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });

  const desktopSidebar = await evalJs(`(() => {
    const strip = document.querySelector("#quota-strip");
    const html = strip.innerHTML;
    const badges = [...strip.querySelectorAll(".quota-badge")].map(b => b.textContent);
    const freshness = document.querySelector("#sidebar-quota-freshness")?.textContent || "";
    const overflow = document.documentElement.scrollWidth > innerWidth;
    return { html, badges, freshness, overflow };
  })()`);

  assert.equal(desktopSidebar.overflow, false, "desktop has no horizontal overflow");
  assert.ok(desktopSidebar.html.includes("codex"), "desktop sidebar shows Codex");
  assert.ok(desktopSidebar.html.includes("grok"), "desktop sidebar shows Grok");
  assert.ok(desktopSidebar.html.includes("agy"), "desktop sidebar shows AGY (Grok-only bug fixed)");
  assert.ok(!desktopSidebar.html.includes("commandcode"), "desktop sidebar excludes inactive providers");
  assert.equal(await evalJs('document.querySelectorAll("#quota-strip .quota-family").length'), 4, "AGY scope families and unsplit providers each have a compact box");
  assert.equal(await evalJs('document.querySelectorAll("#quota-strip .quota-family-notch").length'), 6, "source intervals and in-range AGY label intervals draw notches");
  assert.ok(await evalJs('document.querySelector("#quota-strip .quota-family-notch")?.getAttribute("aria-label")?.includes("remaining at source capture")'), "notch has an accessible meaning");
  assert.ok(Math.abs(Number(await evalJs('document.querySelector("#quota-strip [data-quota-key*=codex] .quota-family-notch").style.getPropertyValue("--remaining").replace("%", "")')) - 79.1667) < 0.001, "5d13h remaining in the 7-day Codex window positions the marker at 79.1%");
  assert.ok(desktopSidebar.html.includes("Gemini 5-hour") && desktopSidebar.html.includes("Claude/GPT 5-hour"), "desktop sidebar shows multiple windows for AGY");
  assert.ok(desktopSidebar.freshness.length > 0, "desktop sidebar shows freshness timestamp");
  assert.ok(!desktopSidebar.html.includes("time ?"), "missing window timing does not clutter rows");
  assert.equal(await evalJs('document.querySelectorAll("#quota-strip .quota-family-side").length'), 4, "one Grok card alongside Codex and two AGY families");
  assert.deepEqual(await evalJs('[...document.querySelectorAll("#quota-strip .quota-family-side")].filter(f => f.querySelector(".quota-family-title > .provider-name")?.textContent === "grok").map(f => [...f.querySelectorAll(".quota-family-row")].map(r => ({ label: r.querySelector(".quota-family-label").firstChild.textContent.replace(/ · $/, ""), value: r.querySelector(".quota-family-value").textContent })))'), [[{ label: "Credits", value: "12%" }, { label: "Build", value: "43%" }, { label: "Chat", value: "80%" }]], "independent Grok rows in one card");

  // Changing 1/2/3-digit values must not move either bar edge or the notch.
  const stableGeometry = (selector) => `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    const value = row.querySelector('.quota-family-value');
    const meter = row.querySelector('.quota-family-meter');
    const notch = row.querySelector('.quota-family-notch');
    const positions = [1, 19, 100].map(n => {
      value.textContent = n + '%';
      const rect = meter.getBoundingClientRect();
      return [rect.left, rect.right, notch?.getBoundingClientRect().left];
    });
    return positions.every(p => p.every((x, i) => x === positions[0][i]));
  })()`;
  assert.equal(await evalJs(stableGeometry('#quota-strip .quota-family-row')), true, 'side panel bar and notch are fixed across percentage widths');
  // Exercise the actual resizable shell width, not the overridden root fallback.
  for (const width of [220, 320, 440]) {
    const fit = await evalJs(`(() => {
      const workspace = document.querySelector(".workspace");
      workspace.style.setProperty("--shell-nav-width", "${width}px");
      const strip = document.querySelector("#quota-strip");
      return { nav: Math.round(document.querySelector("#review-sidebar-region").getBoundingClientRect().width),
        cards: [...strip.querySelectorAll(".quota-badge")].every(card => card.scrollWidth <= card.clientWidth + 1),
        rows: [...strip.querySelectorAll(".quota-family-row")].every(row => row.scrollWidth <= row.clientWidth + 1 && row.querySelector(".quota-family-meter").getBoundingClientRect().width >= 20),
        rowGeometry: [...strip.querySelectorAll(".quota-family-row")].map(row => [row.clientWidth, row.scrollWidth, row.querySelector(".quota-family-meter").getBoundingClientRect().width]),
        overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.ok(fit.nav === width && fit.cards && fit.rows && !fit.overflow, `${width}px desktop sidebar fits compact cards: ${JSON.stringify(fit)}`);
  }
  await evalJs('document.querySelector(".workspace").style.removeProperty("--shell-nav-width")');

  // The full Quota page remains reachable from the main navigation.
  await evalJs(`document.querySelector('.primary-nav [data-view="quota"]').click()`);
  await wait(150);

  const desktopQuotaView = await evalJs(`(() => {
    const view = document.querySelector("#quota-view");
    const hash = location.hash;
    const accordions = [...view.querySelectorAll("article.quota-card[data-provider]")].map(d => ({
      provider: d.dataset.provider,
      open: d.querySelector(".quota-more").open,
      summary: d.querySelector(".quota-card-head").textContent + d.querySelector(".quota-summary-windows").textContent
    }));
    const limitingBadges = view.querySelectorAll(".quota-summary-window-limiting").length;
    const pacingNotes = view.querySelectorAll(".quota-pacing-note").length;
    const unconfigured = view.querySelectorAll(".quota-unconfigured-chip").length;
    const progressBars = [...view.querySelectorAll(".quota-family-track[role='progressbar']")].map(b => ({
      now: b.getAttribute("aria-valuenow"),
      width: b.querySelector("span")?.style.width
    }));
    const overflow = document.documentElement.scrollWidth > innerWidth;
    return { hash, accordions, limitingBadges, pacingNotes, unconfigured, progressBars, overflow };
  })()`);

  assert.equal(desktopQuotaView.hash, "#quota", "hash updated to #quota");
  assert.equal(await evalJs(stableGeometry('#quota-view .quota-family-row')), true, 'full-page bar and notch are fixed across percentage widths');
  assert.equal(desktopQuotaView.overflow, false, "desktop #quota-view has no horizontal overflow");
  assert.equal(desktopQuotaView.accordions.length, 3, "three active provider accordions rendered");
  assert.ok(desktopQuotaView.accordions.every(a => !a.open), "details collapsed by default");
  assert.equal(await evalJs('document.querySelectorAll(".quota-summary-tile").length'), 4, "four summary tiles");
  assert.ok(await evalJs('document.querySelector(".quota-summary [data-quota-key=tightest]").textContent.includes("12%") && document.querySelector(".quota-summary [data-quota-key=tightest] [data-quota-target=grok]") !== null'), "tightest uses Grok effective 12%");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view .quota-family-band").length'), 3, "bands require both source marker and reserve");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view [data-provider=agy] .quota-family-band").length'), 0, "AGY marker-only evidence never gets a band");
  await evalJs('document.querySelector(".quota-summary [data-quota-key=tightest] a").focus()');
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  assert.equal(await evalJs('document.activeElement.closest("article")?.dataset.provider'), "grok", "summary activation focuses provider heading");
  assert.equal(await evalJs('document.activeElement.tagName'), "H2");
  assert.ok(desktopQuotaView.limitingBadges >= 1, "limiting window badges rendered");
  assert.ok(desktopQuotaView.pacingNotes >= 1, "pacing notes comparing consumption to elapsed-time pacing rendered");
  assert.ok(desktopQuotaView.unconfigured >= 2, "inactive providers grouped into unconfigured tray");
  assert.ok(desktopQuotaView.accordions.some(a => a.provider === "grok" && a.summary.includes("Credits") && a.summary.includes("Build")), "both constrained provider windows remain visible in the summary");
  assert.ok(desktopQuotaView.accordions.some(a => a.provider === "grok" && a.summary.includes("limit Credits")), "only the source-named binding window is called limiting");
  assert.equal(await evalJs('document.querySelectorAll(".quota-family-identity .provider-name").length'), 0, "provider name is not repeated in the monogram badge");
  assert.equal(await evalJs('document.querySelector("#quota-view [data-provider=agy] h2").textContent'), "AGY");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view [data-provider=agy] .quota-family").length'), 2, "full page separates proven AGY scopes");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view [data-provider=agy] .quota-family-row").length'), 4, "two rows in each AGY family");
  assert.ok(await evalJs('[...document.querySelectorAll("#quota-view [data-provider=agy] .quota-family")].every(g => g.querySelectorAll(".quota-family-row").length === 2)'), "each proven family has exactly two compact window rows");
  assert.equal(await evalJs("document.querySelector('#quota-strip .quota-family-label[title=\"Gemini 5-hour\"]')?.textContent.includes('5h')"), true, "only source-scoped labels abbreviate 5-hour");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view .quota-family-notch").length'), 6, "out-of-range AGY label intervals never draw timing markers");
  assert.ok(await evalJs('[...document.querySelectorAll("#quota-view [data-provider=agy] .quota-family-row")].every(r => r.title.includes("Window length from provider label"))'), "AGY label interval provenance is disclosed");
  assert.ok(await evalJs('[...document.querySelectorAll("#quota-view [data-provider=agy] .quota-family-label")].some(r => r.firstChild.textContent === "7d" && r.getAttribute("aria-label").includes("weekly"))'), "7d label preserves full accessible wording");
  assert.ok(!await evalJs('document.querySelector("#quota-view").innerText.includes("time ?")'), "full page hides timing artifact");
  assert.equal(await evalJs('document.querySelectorAll("#quota-view [data-provider=grok] .quota-family").length'), 1);
  assert.equal(await evalJs('document.querySelectorAll("#quota-view [data-provider=grok] .quota-family-row").length'), 3);
  assert.ok(await evalJs('document.querySelector("#quota-view .quota-card-head h2")?.textContent'), "provider identity remains readable beside decorative monogram");
  const exactReset = await evalJs('document.querySelector(".quota-window time[datetime=\'2026-09-30T22:52:52.000Z\']") !== null');
  assert.ok(exactReset, "exact reset datetime remains available in expanded detail");

  // Truthful remaining direction: 19% has width: 19%
  const codexBar = desktopQuotaView.progressBars.find(b => b.now === "19");
  assert.ok(codexBar && codexBar.width === "19%", "truthful remaining progressbar width matches percentRemaining exactly");

  // Shared keys and saved preference; AGY's adjacent families remain one page card.
  for (const mode of ["highest", "lowest", "runway", "runway-lowest", "az", "za"]) {
    const key = mode.startsWith("runway") ? "runway" : ["az", "za"].includes(mode) ? "az" : "left";
    for (let attempt = 0; attempt < 2 && await evalJs('localStorage.getItem("fm-agentos-sidebar-quota-sort.v1")') !== mode; attempt++) await evalJs(`document.querySelector("#quota-sort-${key}").click()`);
    assert.deepEqual(await evalJs('[...document.querySelectorAll("#quota-providers article[data-provider]")].map(c => c.dataset.provider)'), await evalJs('[...new Set([...document.querySelectorAll("#quota-strip .quota-family")].map(c => JSON.parse(c.dataset.quotaKey)[0]))]'), `${mode}: page and sidebar share order`);
    assert.equal(await evalJs('localStorage.getItem("fm-agentos-sidebar-quota-sort.v1")'), mode);
    assert.equal(await evalJs('document.querySelector("#sidebar-quota-sort [data-sort=runway]").getAttribute("aria-pressed")'), String(mode.startsWith("runway")));
  }
  await evalJs("window.quotaReloadPending = true");
  await cmd("Page.reload");
  for (let i = 0; i < 100; i++) {
    if (await evalJs('!window.quotaReloadPending && document.readyState === "complete" && document.querySelector("#quota-providers article")')) break;
    await wait(50);
  }
  assert.equal(await evalJs('!window.quotaReloadPending && document.readyState === "complete"'), true, "checks the replaced document after reload");
  assert.equal(await evalJs('localStorage.getItem("fm-agentos-sidebar-quota-sort.v1")'), "za", "shared preference persists across reload");
  assert.equal(await evalJs('document.querySelector("#sidebar-quota-sort [data-sort=az]").getAttribute("aria-pressed")'), "true");
  assert.equal(await evalJs('document.querySelector("#quota-sort-az .quota-sort-direction").textContent'), "↓");
  await evalJs('document.querySelector("#sidebar-quota-sort [data-sort=left]").click(); if (localStorage.getItem("fm-agentos-sidebar-quota-sort.v1") !== "lowest") document.querySelector("#sidebar-quota-sort [data-sort=left]").click()');
  assert.equal(await evalJs('document.querySelector("#quota-sort-left").getAttribute("aria-pressed")'), "true", "sidebar changes page control");
  assert.equal(await evalJs('document.querySelector("#quota-sort-left .quota-sort-direction").textContent'), "↑");
  await evalJs('document.querySelector("#quota-details-toggle").click()');
  assert.equal(await evalJs('[...document.querySelectorAll("details.quota-more")].every(d => d.open)'), true, "Show all details opens every disclosure");
  await evalJs('document.querySelector("#quota-details-toggle").click()');
  assert.equal(await evalJs('[...document.querySelectorAll("details.quota-more")].every(d => !d.open)'), true, "Hide all details closes every disclosure");
  await evalJs('document.querySelector("#quota-details-toggle").click()');

  await cmd("Emulation.setDeviceMetricsOverride", { width: 834, height: 1000, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evalJs('document.documentElement.scrollWidth > innerWidth'), false, "tablet quota has no horizontal overflow");

  // ===================== MOBILE VERIFICATION (390x844) =====================
  await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  const mobileLayout = await evalJs(`(() => {
    const sidebarQuota = document.querySelector("#sidebar-quota");
    const sidebarDisplay = getComputedStyle(sidebarQuota).display;
    const quotaTab = document.querySelector('.primary-nav > [data-view="quota"]');
    const quotaTabVisible = getComputedStyle(quotaTab).display !== "none";
    const overflow = document.documentElement.scrollWidth > innerWidth;
    return { sidebarDisplay, quotaTabVisible, overflow };
  })()`);

  assert.equal(mobileLayout.sidebarDisplay, "none", "mobile hides sidebar quota strip so feed/nav remain uncrowded");
  assert.equal(mobileLayout.quotaTabVisible, true, "mobile navigation offers dedicated Quota tab");
  assert.equal(mobileLayout.overflow, false, "mobile has no horizontal overflow");

  // Click Quota tab on mobile
  await evalJs('document.querySelector(\'.primary-nav > [data-view="quota"]\').click()');
  await wait(100);

  for (const width of [390, 320]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: true });
    const fit = await evalJs(`(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
      rows: [...document.querySelectorAll("#quota-view .quota-family-row")].every(row => row.scrollWidth <= row.clientWidth + 1 && row.querySelector(".quota-family-meter").getBoundingClientRect().width >= 20) }))()`);
    assert.ok(fit.rows && !fit.overflow, `${width}px quota rows fit without clipping: ${JSON.stringify(fit)}`);
    await evalJs('document.querySelector(".quota-summary [data-quota-key=tightest] a").click()');
    assert.equal(await evalJs('document.activeElement.tagName'), "H2");
    assert.ok(await evalJs('document.activeElement.getBoundingClientRect().top >= document.querySelector(".product-identity").getBoundingClientRect().bottom'), `${width}px target heading stays below the fixed phone header`);
  }
  await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobileViewCheck = await evalJs(`(() => {
    const view = document.querySelector("#quota-view");
    const overflow = document.documentElement.scrollWidth > innerWidth;
    const cards = [...view.querySelectorAll(".quota-card")].map(c => {
      const r = c.getBoundingClientRect();
      return { width: r.width, left: r.left, right: r.right };
    });
    return { overflow, cardsCount: cards.length, fitsWidth: cards.every(c => c.right <= 390 && c.left >= 0) };
  })()`);

  assert.equal(mobileViewCheck.overflow, false, "mobile #quota-view has no horizontal overflow");
  assert.equal(mobileViewCheck.fitsWidth, true, "mobile quota cards fit cleanly within 390px viewport");

  // Test tapping accordion on mobile
  const summaryPoint = await evalJs(`(() => {
    const summary = document.querySelector("details.quota-more summary");
    summary.scrollIntoView({block: "center"});
    const r = summary.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cmd("Input.dispatchMouseEvent", { type: "mousePressed", ...summaryPoint, button: "left", clickCount: 1 });
  await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", ...summaryPoint, button: "left", clickCount: 1 });

  const toggledState = await evalJs('document.querySelector("details.quota-more").open');
  assert.equal(toggledState, false, "tapping accordion header toggles open/close on mobile");

  // The narrowest supported phone width must preserve summary and detail inside the viewport.
  await cmd("Emulation.setDeviceMetricsOverride", { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await evalJs('document.querySelector("#quota-details-toggle").click()');
  const narrow = await evalJs(`(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    cardsFit: [...document.querySelectorAll("#quota-view .quota-card")].every(c => c.getBoundingClientRect().right <= innerWidth && c.getBoundingClientRect().left >= 0),
    detailsOpen: [...document.querySelectorAll("details.quota-more")].every(d => d.open),
    windowsVisible: document.querySelectorAll("#quota-view .quota-family-row").length,
    cards: [...document.querySelectorAll("article.quota-card")].map(d => ({ provider: d.dataset.provider, open: d.querySelector("details").open, right: Math.round(d.getBoundingClientRect().right) }))
  }))()`);
  console.log("320px expanded geometry", JSON.stringify(narrow));
  if (process.env.QUOTA_SCREENSHOT) {
    const image = await cmd("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.QUOTA_SCREENSHOT, Buffer.from(image.data, "base64"));
  }
  assert.equal(narrow.overflow, false, "320px has no page horizontal overflow");
  assert.equal(narrow.cardsFit, true, "320px quota cards fit");
  assert.equal(narrow.detailsOpen, true, "320px expanded details remain reachable");
  assert.ok(narrow.windowsVisible >= 4, "320px retains all source-reported windows");

  // A second read uses a distinct local server and intentionally incomplete
  // sanitized source data, not model-name guesses or synthetic forecasts.
  await cmd("Page.navigate", { url: `${incompleteBase}/#quota` });
  let incompleteLoaded = false;
  for (let i = 0; i < 100; i++) {
    incompleteLoaded = await evalJs('document.querySelector(".quota-family-row")?.textContent.includes("Unmeasured") || false');
    if (incompleteLoaded) break;
    await wait(100);
  }
  assert.ok(incompleteLoaded, "incomplete quota reading rendered");
  await evalJs('document.querySelector("#quota-details-toggle").click()');
  const incomplete = await evalJs(`(() => {
    const view = document.querySelector("#quota-view");
    return { overflow: document.documentElement.scrollWidth > innerWidth, text: view.innerText,
      limiting: view.querySelectorAll(".quota-summary-window-limiting").length,
      unknownBars: view.querySelectorAll(".quota-bar-unknown").length,
      resetTimes: view.querySelectorAll(".quota-window time").length };
  })()`);
  assert.equal(incomplete.overflow, false, "incomplete 320px reading has no overflow");
  assert.match(incomplete.text, /Binding limit unknown/);
  assert.match(incomplete.text, /Remaining unknown/);
  assert.match(incomplete.text, /Reset unknown/);
  assert.equal(incomplete.limiting, 0, "no invented binding relationship");
  assert.ok(incomplete.unknownBars >= 1, "no zero-valued bar for missing percentage");
  assert.equal(incomplete.resetTimes, 0, "no fabricated reset timestamp");
  assert.doesNotMatch(incomplete.text, /Projected exhaustion:/);

  console.log(`Chromium Quota Visualization acceptance PASS: exact head desktop (1280px), phone (390px, 320px), expanded constrained and incomplete sanitized readings`);

} finally {
  if (ws) {
    try { ws.close(); } catch {}
  }
  if (chrome) {
    chrome.kill("SIGKILL");
    await new Promise((resolve) => {
      chrome.once("exit", resolve);
      setTimeout(resolve, 500);
    });
  }
  await close(app);
  await close(incompleteApp);
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}
