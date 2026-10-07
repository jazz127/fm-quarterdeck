// Clean-commit synthetic screenshots; output must be outside the source tree.
// QUOTA_CAPTURE_DIR=/absolute/private/path node scripts/quota-page-screenshots.mjs
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./browser-harness.mjs";
import { createQuotaAcceptanceServer, quotaCaptureTime } from "./quota-acceptance-fixture.mjs";
const output = process.env.QUOTA_CAPTURE_DIR;
assert.ok(output && path.isAbsolute(output), "QUOTA_CAPTURE_DIR must be an absolute external directory");
await mkdir(output, { recursive: true });
const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const destination = await realpath(output);
assert.ok(destination !== root && !destination.startsWith(root + path.sep), "never save runtime captures in the repository");
const browser = await openBrowser();
const evidence = [];
try {
  await browser.command("Page.addScriptToEvaluateOnNewDocument", { source: `Date.now = () => ${Date.parse(quotaCaptureTime)};` });
  for (const state of ["normal", "runway", "provider-stale", "whole-stale", "unavailable", "loading", "expanded", "forced-colours", "exhaustion"]) {
    const server = createQuotaAcceptanceServer(["runway", "expanded", "forced-colours"].includes(state) ? "normal" : state);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      for (const [width, height] of [[1440, 1000], [834, 1000], [390, 844], [320, 700]]) {
        await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
        await browser.command("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: state === "forced-colours" ? "active" : "none" }, { name: "prefers-reduced-motion", value: "reduce" }] });
        // Navigation acknowledges before document replacement; never let the
        // previous state's DOM satisfy this capture's readiness predicate.
        await browser.evaluate("window.quotaCaptureNavigationPending = true");
        await browser.command("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?quota-capture=${state}-${width}#quota` });
        await browser.until('!window.quotaCaptureNavigationPending && document.readyState === "complete" && document.querySelector(".workspace")?.dataset.view === "quota"');
        await browser.until(state === "loading" ? 'document.querySelector("#quota-providers .quota-skeleton")' : 'document.querySelector("#quota-providers")?.getAttribute("aria-busy") === "false"');
        if (state !== "loading") {
          const mode = state === "runway" ? "runway" : "lowest";
          await browser.evaluate(`(() => {
            const desired = ${JSON.stringify(mode)}, button = document.querySelector("#quota-sort-${mode === "runway" ? "runway" : "left"}");
            if (localStorage.getItem("fm-agentos-sidebar-quota-sort.v1") !== desired) button.click();
            if (localStorage.getItem("fm-agentos-sidebar-quota-sort.v1") !== desired) button.click();
          })()`);
          assert.equal(await browser.evaluate('localStorage.getItem("fm-agentos-sidebar-quota-sort.v1")'), mode);
        }
        if (state === "expanded") await browser.evaluate('document.querySelector("#quota-details-toggle").click()');
        await browser.evaluate('document.querySelector("#quota-view").scrollTop = 0; document.activeElement?.blur()');
        const geometry = await browser.evaluate(`({ overflow: document.documentElement.scrollWidth > innerWidth,
          cardsFit: [...document.querySelectorAll('#quota-view article')].every(c => c.scrollWidth <= c.clientWidth + 1),
          rowCount: document.querySelectorAll('#quota-view .quota-family-row').length,
          cardCount: document.querySelectorAll('#quota-providers article').length,
          staleCards: document.querySelectorAll('#quota-providers .quota-card-stale').length,
          detailsOpen: [...document.querySelectorAll('#quota-providers details')].every(d => d.open),
          trayCount: document.querySelectorAll('.quota-unconfigured-chip').length,
          summaryText: document.querySelector('#quota-summary').textContent,
          stateText: document.querySelector('#quota-state').textContent })`);
        assert.equal(geometry.overflow, false, `${state} ${width}: horizontal overflow`);
        assert.equal(geometry.cardsFit, true, `${state} ${width}: card clipping`);
        assert.equal(geometry.cardCount, ["loading", "unavailable"].includes(state) ? 0 : 3, `${state}: correct source state rendered`);
        if (geometry.cardCount) {
          assert.equal(geometry.detailsOpen, state === "expanded", `${state}: native disclosure state`);
          assert.equal(geometry.trayCount, 15, `${state}: all inactive providers retained`);
          assert.equal(geometry.staleCards, state === "whole-stale" ? 3 : state === "provider-stale" ? 1 : 0);
          if (state === "whole-stale") assert.ok(geometry.summaryText.includes("unknown (stale)") && geometry.summaryText.includes("captured"));
          if (state === "exhaustion") assert.ok(geometry.summaryText.includes("exhausted now") && geometry.summaryText.includes("1 projected to run out"));
        }
        if (state === "loading") assert.ok(geometry.stateText.includes("Loading quota"));
        const image = await browser.command("Page.captureScreenshot", { format: "png" });
        const name = `after-${state}-${width}.png`;
        await writeFile(path.join(output, name), Buffer.from(image.data, "base64"));
        evidence.push({ name, width, height, state, ...geometry });
        if (!["loading", "unavailable"].includes(state)) {
          for (const [section, selector] of [["cards", "#quota-providers article"], ["tray", ".quota-unconfigured-tray"]]) {
            await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`);
            const sectionImage = await browser.command("Page.captureScreenshot", { format: "png" });
            const sectionName = `after-${state}-${width}-${section}.png`;
            await writeFile(path.join(output, sectionName), Buffer.from(sectionImage.data, "base64"));
            evidence.push({ name: sectionName, width, height, state, section, ...geometry });
          }
        }
      }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  await writeFile(path.join(output, "screenshots.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Saved ${evidence.length} synthetic captures to ${output}`);
} finally { await browser.close(); }
