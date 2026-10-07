// Exact-candidate browser acceptance for Overview and Work Split visual organization.
// Verifies horizontal repository scrolling, 3-tier hierarchy, card item separation,
// responsive containment at 1600, 1440, 834, 768, 390, and 320px, and zero page-level overflow.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "../server.js";
import { createAgentStateOwner, emptyAgentState, fingerprint } from "../agent-state.js";
import { sanitizeQuota } from "../quota.js";
import { captureKpiGeometry, inspectKpiGeometry } from "./kpi-geometry.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const lab = path.join(root, ".taxonomy-lab");
await mkdir(lab, { recursive: true });
const home = path.join(lab, "vo-home");
const statePath = path.join(lab, "vo-state.json");
await mkdir(path.join(home, "data"), { recursive: true });
await mkdir(path.join(home, "state/main-session"), { recursive: true });

// Setup a rich 3-repository fixture to test multi-repo horizontal deck, lanes, and themes
const repos = [
  { id: "quarterdeck", name: "Quarterdeck Core", path: path.join(lab, "quarterdeck") },
  { id: "firstmate", name: "Firstmate Engine", path: path.join(lab, "firstmate") },
  { id: "example-store", name: "Example Store", path: path.join(lab, "example-store") },
];

await writeFile(path.join(home, "data/projects.md"), repos.map(r => `- ${r.id} - ${r.name}\n`).join(""));

const taskDefs = [
  { id: "task-os-1", repo: "quarterdeck", lane: "ui", laneName: "Interface Workstream", theme: "overview", themeName: "Overview Polish", state: "working", status: "active" },
  { id: "task-os-2", repo: "quarterdeck", lane: "ui", laneName: "Interface Workstream", theme: "overview", themeName: "Overview Polish", state: "done", status: "newly-done", commit: "a" },
  { id: "task-os-3", repo: "quarterdeck", lane: "ui", laneName: "Interface Workstream", theme: "overview", themeName: "Overview Polish", state: "done", status: "previously-done", commit: "b" },
  { id: "task-fm-1", repo: "firstmate", lane: "supervision", laneName: "Supervision", theme: "fleet", themeName: "Fleet Ledger", state: "needs-decision", status: "captain-action" },
  { id: "task-fm-2", repo: "firstmate", lane: "supervision", laneName: "Supervision", theme: "fleet", themeName: "Fleet Ledger", state: "paused", status: "waiting" },
  { id: "task-store-1", repo: "example-store", lane: "checkout", laneName: "Checkout Flow", theme: "payment", themeName: "Payment Gateway", state: "preserved", status: "cleanup" },
  { id: "task-store-2", repo: "example-store", lane: "checkout", laneName: "Checkout Flow", theme: "payment", themeName: "Payment Gateway", state: "working", status: "active" },
];

await writeFile(path.join(home, "data/backlog.md"), `## In flight\n${taskDefs.map(t => {
  const repo = repos.find(r => r.id === t.repo);
  return `- [ ] ${t.id} - ${t.id} implementation slice (repo: ${repo.path})`;
}).join("\n")}\n`);

const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

for (const t of taskDefs) {
  const repo = repos.find(r => r.id === t.repo);
  await writeFile(path.join(home, "state", `${t.id}.status`), `${t.state} [at=1]: fixture recorded outcome\n`);
  await writeFile(path.join(home, "state", `${t.id}.meta`), `project=${repo.path}\n${t.status === "active" ? `worker_pid=${process.pid}\nworker_start_ticks=${ticks}\nworker_boot_id=${boot}\n` : ""}${t.commit ? `completion_commit=${t.commit.repeat(40)}\n` : ""}`);
}

const state = {
  ...emptyAgentState(),
  completionRecords: {},
  repositories: repos.map(r => ({
    id: r.id,
    name: r.name,
    path: r.path,
    github: `fixture/${r.id}`,
    destinations: [{ environment: "UAT", tier: "uat" }],
    lanes: [
      {
        id: r.id === "quarterdeck" ? "ui" : r.id === "firstmate" ? "supervision" : "checkout",
        name: r.id === "quarterdeck" ? "Interface Workstream" : r.id === "firstmate" ? "Supervision" : "Checkout Flow",
        themes: [
          {
            id: r.id === "quarterdeck" ? "overview" : r.id === "firstmate" ? "fleet" : "payment",
            name: r.id === "quarterdeck" ? "Overview Polish" : r.id === "firstmate" ? "Fleet Ledger" : "Payment Gateway",
            kind: "iteration"
          }
        ]
      }
    ]
  }))
};

for (const t of taskDefs) {
  const repo = repos.find(r => r.id === t.repo);
  const taskFingerprint = fingerprint("task.v1", repo.path, t.id);
  state.assignments[taskFingerprint] = {
    repositoryId: t.repo,
    laneId: t.lane,
    themeId: t.theme
  };
  if (t.commit) {
    const completionIdentity = { source: "status", line: `${t.state} [at=1]: fixture recorded outcome`, occurrence: 0, doneDate: null };
    state.completionRecords[fingerprint("completion-source.v1", taskFingerprint, completionIdentity)] = {
      taskFingerprint,
      commit: t.commit.repeat(40)
    };
  }
}

await createAgentStateOwner(statePath).update((saved) => Object.assign(saved, state));

// Conversation fixture in main-session
await writeFile(
  path.join(home, "state/main-session/fixture.jsonl"),
  JSON.stringify({
    type: "message",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: `[fm-lane quarterdeck]\nOverview and Work Split visual organization test turn.\n\n\`\`\`text\nevidence-block\n\`\`\`\n[end quarterdeck]` }]
    }
  }) + "\n"
);

const windows = [
  { id: "daily", label: "Daily limit", kind: "daily", percentRemaining: 65, resetsAt: new Date(Date.now() + 4 * 3600000).toISOString() },
  { id: "weekly", label: "Weekly quota", kind: "weekly", percentRemaining: 40, resetsAt: new Date(Date.now() + 3 * 86400000).toISOString() }
];

const server = createServer(
  { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: statePath, FM_DEPLOYMENT_TIER: "uat" },
  {
    previewRegistry: [{ id: "uat", name: "UAT", branch: "uat", commit: head, remoteCheckpoint: null, validation: "captured" }],
    quotaReader: async () => ({
      readAt: new Date().toISOString(),
      stale: false,
      error: null,
      providers: sanitizeQuota({
        schemaVersion: 5,
        providers: [{
          provider: "codex",
          state: { status: "fresh", authStatus: "usable" },
          windows,
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [{
              scope: "all_models",
              status: "known",
              effectivePercentRemaining: 40,
              boundedBy: ["weekly"],
              limitingWindowIds: ["weekly"]
            }]
          }
        }]
      })
    }),
    costReader: async () => ({ azure: { status: "unavailable", error: "Synthetic" }, github: { status: "unavailable", error: "Synthetic" } }),
    chatDeliver: async () => ({ receiptId: "vo-receipt" })
  }
);

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/preview/uat/`;

const profile = await mkdtemp(path.join(lab, "chrome-vo-"));
const chrome = spawn(
  process.env.CHROMIUM || "chromium",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: "ignore" }
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const deadline = setTimeout(() => {
  console.error("FAIL: visual organization acceptance expired");
  chrome.kill("SIGKILL");
  process.exitCode = 1;
}, 120000);

try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch {
      if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`);
      await wait(100);
    }
  }
  assert.ok(port, "DevTools port found");

  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data), entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result);
  });

  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(next, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: next, method, params }));
  });

  const evaluate = async (expression) => {
    const reply = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };

  const until = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await wait(100);
    }
    throw new Error(`Readiness timeout: ${expression}`);
  };

  await cmd("Page.enable");

  const viewports = [1600, 1440, 834, 768, 390, 320];
  const acceptanceResults = [];

  for (const width of viewports) {
    const isMobile = width <= 720;
    const height = isMobile ? 844 : 1000;
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: isMobile });

    for (const view of ["overview", "work"]) {
      await cmd("Page.navigate", { url: `${url}#${view}` });
      await until("Boolean(document.querySelector('#projects .taxonomy-theme') && document.querySelector('#tight-work .taxonomy-theme'))");

      const targetRoot = view === "overview" ? "#projects" : "#tight-work";

      // 1. Verify NO PAGE-LEVEL HORIZONTAL OVERFLOW
      const pageOverflow = await evaluate("document.documentElement.scrollWidth > innerWidth");
      assert.equal(pageOverflow, false, `Page must not horizontally overflow at width ${width} on #${view}`);

      // 2. Inspect layout metrics of the taxonomy deck and repositories
      const metrics = await evaluate(`(() => {
        const root = document.querySelector('${targetRoot}');
        const viewEl = document.querySelector('${view === "overview" ? "#overview-view" : "#work-view"}');
        const viewRect = viewEl.getBoundingClientRect();
        const repos = [...root.querySelectorAll('.taxonomy-repository')];
        const lanes = [...root.querySelectorAll('.taxonomy-lane')];
        const themes = [...root.querySelectorAll('.taxonomy-theme')];
        const slices = [...root.querySelectorAll('.work-slice')];
        const rootBox = root.getBoundingClientRect();
        return {
          repoCount: repos.length,
          laneCount: lanes.length,
          themeCount: themes.length,
          sliceCount: slices.length,
          rootScrollWidth: root.scrollWidth,
          rootClientWidth: root.clientWidth,
          rootWidth: rootBox.width,
          stageWidth: viewRect.width,
          utilizationRatio: rootBox.width / viewRect.width,
          pageGutterTotal: viewRect.width - rootBox.width,
          rootCanScrollX: root.scrollWidth > root.clientWidth + 1,
          reposHorizontal: repos.length >= 2 && repos[1].getBoundingClientRect().left >= repos[0].getBoundingClientRect().right - 2,
          repoBoxes: repos.map(r => {
            const b = r.getBoundingClientRect();
            const s = getComputedStyle(r);
            return { width: b.width, height: b.height, left: b.left, border: s.borderWidth, radius: s.borderRadius };
          }),
          sliceStyles: slices.slice(0, 2).map(sl => {
            const s = getComputedStyle(sl);
            return { borderRadius: s.borderRadius, borderWidth: s.borderWidth, boxShadow: s.boxShadow !== 'none' };
          })
        };
      })()`);

      assert.equal(metrics.repoCount, 3, "All 3 repositories must be rendered");
      assert.ok(metrics.sliceCount >= 6, "Work slices rendered across repos");

      // Explicit viewport utilization and geometry checks:
      // Content deck fills the full available view stage width (>= 90%) across all viewports
      assert.ok(metrics.utilizationRatio >= 0.90, `Content must utilize at least 90% of page stage width at ${width}px (was ${(metrics.utilizationRatio * 100).toFixed(1)}%)`);
      // Content deck fills the stage beyond 1200px when available stage width exceeds 1250px (wide desktop)
      if (metrics.stageWidth > 1250) {
        assert.ok(metrics.rootWidth > 1200, `Content width (${metrics.rootWidth}px) must expand beyond the previous 1200px cap on wide screens`);
      }
      assert.ok(metrics.pageGutterTotal >= 20, `Sensible outer gutters must be preserved at ${width}px (gutter was ${metrics.pageGutterTotal}px)`);
      assert.ok(metrics.pageGutterTotal <= 80, `Outer gutters must not be excessively wide at ${width}px (gutter was ${metrics.pageGutterTotal}px)`);

      if (width > 720) {
        // On desktop/tablet, repositories sit horizontally side-by-side with horizontal scroll
        assert.ok(metrics.reposHorizontal, `Repositories must be arranged horizontally at width ${width}`);
        assert.ok(metrics.rootCanScrollX || metrics.repoBoxes[0].width >= 320, `Repository deck allows horizontal scrolling or wide columns at ${width}`);
      } else {
        // On mobile (390px, 320px), repositories stack vertically with zero overflow
        assert.equal(metrics.rootCanScrollX, false, `No horizontal overflow on mobile container at width ${width}`);
      }

      // Slices have distinct card styling: borders, border-radius, and shadow
      for (const st of metrics.sliceStyles) {
        assert.notEqual(st.borderRadius, "0px", "Work slices must have rounded card corners");
        assert.notEqual(st.borderWidth, "0px", "Work slices must have visible card borders");
      }

      // 3. Verify mobile KPIs at 390 and 320
      if (width <= 390 && view === "overview") {
        const diagnostic = { head, requestedWidth: width, view, ...await evaluate(`(${captureKpiGeometry.toString()})()`) };
        const kpiResult = inspectKpiGeometry(diagnostic);
        assert.deepEqual(kpiResult.failures, [], `KPI cards must fit cleanly at width ${width}: ${JSON.stringify(diagnostic)}`);
      }

      // 4. Test expand / collapse interactivity and horizontal contraction on desktop
      const toggleTest = await evaluate(`(() => {
        const repo = document.querySelector('${targetRoot} .taxonomy-repository');
        const summary = repo.querySelector('summary');
        const titleStrong = summary.querySelector('strong');
        const summaryStyle = getComputedStyle(summary);
        const titleStyle = getComputedStyle(titleStrong);
        const initialOpen = repo.open;
        const initialWidth = repo.getBoundingClientRect().width;

        summary.click();
        const afterFirstClick = repo.open;
        const collapsedBox = repo.getBoundingClientRect();
        const collapsedSummaryBox = summary.getBoundingClientRect();
        const collapsedTitleBox = titleStrong.getBoundingClientRect();
        const collapsedCountsBox = summary.querySelector('.taxonomy-counts')?.getBoundingClientRect();
        const titleWritingMode = getComputedStyle(titleStrong).writingMode;
        const titleTopOffset = collapsedTitleBox.top - collapsedSummaryBox.top;
        const countsTopOffset = collapsedCountsBox ? collapsedCountsBox.top - collapsedSummaryBox.top : null;
        const collapsedWidth = collapsedBox.width;
        const computedFlex = getComputedStyle(repo).flex;
        const computedWidth = getComputedStyle(repo).width;
        const computedMaxWidth = getComputedStyle(repo).maxWidth;
        const computedMinWidth = getComputedStyle(repo).minWidth;
        const badges = [...summary.querySelectorAll('.taxonomy-counts .state-chip')];
        const badgeDetails = badges.map(b => {
          const chipRect = b.getBoundingClientRect();
          const fullSpan = b.querySelector('.badge-label-full');
          const abbrSpan = b.querySelector('.badge-label-abbr');
          const fullStyle = fullSpan ? getComputedStyle(fullSpan) : null;
          const abbrStyle = abbrSpan ? getComputedStyle(abbrSpan) : null;
          return {
            text: b.textContent.trim(),
            title: b.getAttribute('title') || '',
            ariaLabel: b.getAttribute('aria-label') || '',
            fullDisplay: fullStyle ? fullStyle.display : null,
            abbrDisplay: abbrStyle ? abbrStyle.display : null,
            chipLeft: chipRect.left - collapsedSummaryBox.left,
            chipRight: chipRect.right - collapsedSummaryBox.left,
            chipWidth: chipRect.width
          };
        });

        summary.click();
        const afterSecondClick = repo.open;
        const restoredWidth = repo.getBoundingClientRect().width;

        return {
          initialOpen,
          afterFirstClick,
          afterSecondClick,
          initialWidth,
          collapsedWidth,
          restoredWidth,
          titleWritingMode,
          titleTopOffset,
          countsTopOffset,
          computedFlex,
          computedWidth,
          computedMaxWidth,
          computedMinWidth,
          summaryBg: summaryStyle.backgroundColor,
          titleColor: titleStyle.color,
          badgeDetails
        };
      })()`);

      assert.notEqual(toggleTest.initialOpen, toggleTest.afterFirstClick, "Clicking summary toggles repository open state");
      assert.equal(toggleTest.initialOpen, toggleTest.afterSecondClick, "Second click restores repository open state");

      if (width > 720) {
        // Desktop/tablet: repository collapses horizontally into a compact column with top-aligned vertical title and counts
        assert.ok(toggleTest.collapsedWidth <= 70, `Collapsed repo must contract horizontally on desktop at ${width}px (was ${toggleTest.collapsedWidth}px)`);
        assert.ok(toggleTest.titleWritingMode.includes("vertical"), `Collapsed title must use vertical writing mode on desktop at ${width}px`);
        assert.ok(toggleTest.titleTopOffset <= 50, `Collapsed title text must be top-aligned inside spine on desktop at ${width}px (offset was ${toggleTest.titleTopOffset}px)`);
        if (toggleTest.countsTopOffset !== null) {
          assert.ok(toggleTest.countsTopOffset <= 250, `Collapsed counts must be top-aligned below title in spine on desktop at ${width}px (offset was ${toggleTest.countsTopOffset}px)`);
        }
        for (const badge of toggleTest.badgeDetails) {
          assert.equal(badge.fullDisplay, "none", "Full status label must be hidden in collapsed spine");
          assert.equal(badge.abbrDisplay, "inline", "1-character abbreviation must be visible in collapsed spine");
          assert.ok(badge.chipLeft <= 16, `Badge must be start/left-aligned in collapsed spine (left offset was ${badge.chipLeft}px)`);
          assert.ok(badge.chipRight <= toggleTest.collapsedWidth + 2, `Badge must fit inside spine without clipping (right was ${badge.chipRight}px, width was ${toggleTest.collapsedWidth}px)`);
          assert.ok(badge.title.length > 0, "Badge must have full title attribute for mouse hover");
          assert.ok(badge.ariaLabel.length > 0, "Badge must have full aria-label for screen readers");
        }
        assert.ok(toggleTest.restoredWidth >= 320, `Re-opened repo must expand back to full column width at ${width}px`);
      } else {
        // Mobile: repository collapses vertically, keeping full container width
        assert.ok(toggleTest.collapsedWidth >= 280, `Collapsed repo remains full container width on mobile at ${width}px`);
        for (const badge of toggleTest.badgeDetails) {
          assert.equal(badge.fullDisplay, "inline", "Full status label must be visible on mobile");
          assert.equal(badge.abbrDisplay, "none", "Abbreviated status label must be hidden on mobile");
        }
      }

      // Title contrast verification: title must not be dark on dark
      assert.notEqual(toggleTest.titleColor, toggleTest.summaryBg, "Title text must not match summary background");

      // 5. Test visible status filter buttons
      const btnFilterTest = await evaluate(`(() => {
        const btnContainer = document.querySelector('${view === "overview" ? "#overview-status-buttons" : "#work-phase-buttons"}');
        if (!btnContainer) return null;
        const buttons = [...btnContainer.querySelectorAll('.status-filter-btn')];
        const activeBtn = btnContainer.querySelector('[data-status-value="active"]');
        const allBtn = btnContainer.querySelector('[data-status-value="all"]');
        const sel = document.querySelector('${view === "overview" ? "#overview-status" : "#work-phase"}');

        const initialActivePressed = activeBtn ? activeBtn.getAttribute('aria-pressed') : null;
        const initialAllPressed = allBtn ? allBtn.getAttribute('aria-pressed') : null;

        // Click the 'active' button
        if (activeBtn) activeBtn.click();
        const updatedActiveBtn = btnContainer.querySelector('[data-status-value="active"]');
        const afterClickActivePressed = updatedActiveBtn ? updatedActiveBtn.getAttribute('aria-pressed') : null;
        const afterClickHasActiveClass = updatedActiveBtn ? updatedActiveBtn.classList.contains('active') : null;
        const afterClickSelectVal = sel ? sel.value : null;
        const visibleSlices = document.querySelectorAll('${targetRoot} .work-slice').length;

        // Restore to 'all'
        const updatedAllBtn = btnContainer.querySelector('[data-status-value="all"]');
        if (updatedAllBtn) updatedAllBtn.click();
        const finalAllBtn = btnContainer.querySelector('[data-status-value="all"]');
        const restoredAllPressed = finalAllBtn ? finalAllBtn.getAttribute('aria-pressed') : null;
        const restoredSelectVal = sel ? sel.value : null;
        const restoredSlices = document.querySelectorAll('${targetRoot} .work-slice').length;

        const liveButtons = [...btnContainer.querySelectorAll('.status-filter-btn')];
        const buttonDetails = liveButtons.map(b => {
          const lbl = b.querySelector('.status-btn-label');
          const count = b.querySelector('.filter-count');
          const lblStyle = lbl ? getComputedStyle(lbl) : null;
          const lblRect = lbl ? lbl.getBoundingClientRect() : null;
          return {
            text: b.textContent.trim(),
            labelText: lbl ? lbl.textContent.trim() : null,
            labelWidth: lblRect ? lblRect.width : 0,
            labelDisplay: lblStyle ? lblStyle.display : null,
            countText: count ? count.textContent.trim() : null,
            ariaLabel: b.getAttribute('aria-label') || '',
            title: b.getAttribute('title') || ''
          };
        });

        return {
          buttonCount: liveButtons.length,
          buttonDetails,
          initialActivePressed,
          initialAllPressed,
          afterClickActivePressed,
          afterClickHasActiveClass,
          afterClickSelectVal,
          visibleSlices,
          restoredAllPressed,
          restoredSelectVal,
          restoredSlices
        };
      })()`);

      assert.ok(btnFilterTest.buttonCount >= 3, "Status filter buttons must be rendered");
      for (const btn of btnFilterTest.buttonDetails) {
        assert.ok(btn.labelText && btn.labelText.length > 0, "Button must have readable text label, not number-only");
        assert.notEqual(btn.labelDisplay, "none", "Status button label must be displayed");
        assert.ok(btn.labelWidth > 0, "Status button label must have positive width");
        assert.ok(btn.ariaLabel.length > 0, "Button must have accessible name");
        assert.ok(btn.title.length > 0, "Button must have tooltip title");
      }
      assert.equal(btnFilterTest.initialAllPressed, "true", "All button is initially active");
      assert.equal(btnFilterTest.afterClickActivePressed, "true", "Active button becomes pressed after click");
      assert.equal(btnFilterTest.afterClickHasActiveClass, true, "Active button receives .active class");
      assert.equal(btnFilterTest.afterClickSelectVal, "active", "Backing select synchronizes to active status");
      assert.ok(btnFilterTest.visibleSlices < btnFilterTest.restoredSlices, "Clicking active filters down to active slices only");
      assert.equal(btnFilterTest.restoredAllPressed, "true", "Clicking all restores all-pressed state");
      assert.equal(btnFilterTest.restoredSelectVal, "all", "Backing select restores to all");

      acceptanceResults.push({ width, view, overflow: pageOverflow, repos: metrics.repoCount, horizontal: metrics.reposHorizontal });
    }
  }

  // 5. Test canonical link navigation from work slice
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cmd("Page.navigate", { url: `${url}#overview` });
  await until("Boolean(document.querySelector('#projects a.crew-task'))");

  const navLink = await evaluate(`(() => {
    const link = document.querySelector('#projects a.crew-task');
    return { href: link.getAttribute('href'), text: link.textContent };
  })()`);

  assert.ok(navLink.href.startsWith("#lanes/"), "Task link has canonical #lanes/ prefix");
  assert.ok(navLink.href.includes("/session/"), "Task link has canonical /session/ segment");

  console.log("PASS: Visual organization browser acceptance passed across all viewports!");
  console.log(JSON.stringify(acceptanceResults, null, 2));

} finally {
  clearTimeout(deadline);
  ws?.close();
  chrome.kill("SIGKILL");
  await new Promise((resolve) => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await rm(home, { recursive: true, force: true });
  await rm(statePath, { force: true });
  await new Promise((resolve) => server.close(resolve));
}
