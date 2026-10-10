import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import test from "node:test";
import { createServer, dashboardData, rollupLedger } from "../server.js";

test("default document is the full-height conversation product", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(html, /<main id="lanes" class="workspace"/);
  assert.match(html, /class="lane-list"/);
  assert.match(html, /class="[^"]*\bconversation\b/);
  assert.match(html, /class="context-rail"/);
  assert.match(html, /data-view="overview"/);
  assert.match(html, /id="fleet-source" class="source-badge" aria-label="Firstmate activity"/);
  const activityView = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(activityView, /seen\.textContent = `Last seen/);
  assert.match(activityView, /beat\.textContent = `Watcher/);
  assert.doesNotMatch(activityView, /Last activity seen/);
  assert.match(html, /<span>Overview <b id="call-badge"/);
  assert.match(html, /<small>Captain's Call<\/small>/);
  for (const name of ['patch', 'view', 'live']) assert.ok(html.includes(`<script src="/bearings-${name}.js"></script>`));
  assert.match(html, /data-view="work"/);
  assert.match(html, /id="tight-work"/);
  assert.match(html, /id="large-work"/);
  assert.match(html, /<span>Fleet Chats<\/span>/);
  assert.match(html, /<span>Expenses<\/span>/);
  assert.match(html, /id="category-expenses"/);
  assert.match(html, /id="project-expenses"/);
  assert.match(html, /id="expense-entries"/);
  assert.match(html, /data-expense-sort="date"/);
  assert.match(html, /Description \/ note/);
  assert.match(html, /Confidence \/ basis/);
  assert.match(html, /class="lane-chats-row"/);
  assert.match(html, /id="lane-filter-toggle"[^>]+aria-expanded="false"/);
  assert.doesNotMatch(html, /id="lane-select-all"/);
  assert.match(html, /id="lane-bulk-toggle"[^>]*>Select all</);
  assert.match(html, /<script src="\/bulk-controls\.js"><\/script>/);
  assert.match(html, /id="lane-filter-rows"/);
  assert.match(html, /id="closed-lanes-link"/);
  assert.match(html, /id="closed-view"[^>]+aria-label="Closed fleets"/);
  assert.match(html, /id="closed-search"[^>]+type="search"/);
  assert.match(html, /id="closed-lane-list"/);
  assert.match(html, /id="conversation-filter-shortcut"[^>]+aria-controls="lane-filter-controls"[^>]+aria-label="Collapse Included fleets panel"/);
  assert.match(html, /class="feed-actions"/);
  assert.match(html, /id="refresh"[^>]+aria-label="Refresh dashboard and fleets"/);
  assert.equal(html.match(/id="refresh"/g)?.length, 1);
  const sidebarFooter = html.slice(html.indexOf('<footer class="source-status"'), html.indexOf("</footer>") + 9);
  assert.match(sidebarFooter, /id="refresh"/);
  assert.match(html, /id="message-type-filters"/);
  assert.match(html, /id="kinds-bulk-toggle"[^>]*>Select all</);
  assert.match(html, /<script src="\/message-kinds\.js"><\/script>/);
  assert.match(html, /<script src="\/filter-view\.js"><\/script>/);
  assert.doesNotMatch(html, /id="message-types-select-all"/);
  assert.doesNotMatch(html, /id="lane-bulk-all"/);
  assert.match(html, />See closed history</);
  assert.doesNotMatch(html, /Browse history/);
  assert.match(html, /id="lane-filter-info"/);
  assert.match(html, /id="message-format-toggle"[^>]+>View raw text</);
  assert.match(html, /Conversation feed, oldest to newest/);
  assert.doesNotMatch(html, /Live Firstmate feed/);
  assert.match(html, /Task history/);
  assert.match(html, /id="task-filter-chip"/);
  assert.match(html, /Check fleets to include\. Tap a name to solo that fleet\./);
  assert.doesNotMatch(html, /id="(?:lane-count|lane-filter-summary)"/);
  assert.match(html, /<select id="transcript-session"/);
  assert.doesNotMatch(html, /class="(?:app-shell|sidebar|topbar)"/);
  assert.doesNotMatch(html, /<details[^>]+open/);
  assert.match(html, /data-view="quota"/);
  assert.match(html, /id="quota-view"/);
});

test("favicon is served through the explicit public asset allowlist", async (context) => {
  const revision = "a".repeat(40);
  const server = createServer({ FM_DEPLOYMENT_TIER: "uat" }, {
    revisionResolver: { initial: revision, snapshot: async () => revision },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const parsed = spawnSync("python3", ["-c", `
import json, sys
from html.parser import HTMLParser

class HeadIcons(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_head = False
        self.icons = []

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        if self.in_head and tag == "link":
            attrs = dict(attrs)
            if "icon" in (attrs.get("rel") or "").lower().split():
                self.icons.append(attrs)

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False

parser = HeadIcons()
parser.feed(sys.stdin.read())
print(json.dumps(parser.icons))
`], { input: await page.text(), encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.error?.message || parsed.stderr);
  const icons = JSON.parse(parsed.stdout);
  assert.equal(icons.length, 1);
  assert.equal(icons[0].type, "image/svg+xml");
  assert.ok(icons[0].href);

  const favicon = await fetch(new URL(icons[0].href, page.url));
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/svg+xml");
  assert.match(await favicon.text(), /<svg[^>]+viewBox="0 0 48 48"/);

  assert.equal((await fetch(`${base}/not-allowlisted.svg`)).status, 404);
});

test("Lane Chat has no redundant Options button and preserves desktop identity", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/shell-panel.css", import.meta.url), "utf8");
  const js = await readFile(new URL("../public/shell-panel.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="phone-chat-options"|>Options(?: ▾)?<\/button>/);
  assert.doesNotMatch(css, /phone-chat-options/);
  assert.doesNotMatch(js, /optionsButton|phone-chat-options/);
  assert.match(html, /id="conversation-filter-shortcut"[^>]+aria-controls="lane-filter-controls"[^>]+aria-expanded="true"[^>]+aria-label="Collapse Included fleets panel"/);
  assert.match(js, /window\.addEventListener\("fm-open-chat-options", openChatOptions\)/);
  assert.match(js, /chatSheet\.showModal\(\);[\s\S]*?shortcutButton\(\)\?\.setAttribute\("aria-expanded", "true"\)/);
  assert.match(js, /chatSheet\.addEventListener\("close",[\s\S]*?shortcutButton\(\)\?\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(js, /moveControl\(document\.querySelector\("\.conversation-head-actions"\), chatTools\)/);
  assert.match(js, /moveControl\(document\.querySelector\("\.feed-pagination"\), chatTools\)/);
  assert.match(css, /\.conversation-head:not\(:has\(#task-filter-chip:not\(\[hidden\]\)\)\) \{ display: none; \}/);
  assert.match(js, /document\.querySelector\("#review-send"\)\.textContent = "Send batch"/);
});

test("standalone UAT launch labels its own revision without claiming Main or a gateway", async (context) => {
  assert.throws(() => createServer({ FM_DEPLOYMENT_TIER: "main" }), /UAT-only deployment/);
  assert.throws(() => createServer({ FM_DEPLOYMENT_TIER: "uat" }, { previewRegistry: [
    { id: "main", name: "Main", branch: "main", commit: "a".repeat(40), remoteCheckpoint: "a".repeat(40), validation: "accepted" },
  ] }), /exact stable host revision/);
  const server = createServer({ FM_DEPLOYMENT_TIER: "uat" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const version = (await (await fetch(`${base}/api/review`)).json()).version;
  const html = await (await fetch(base)).text();
  assert.match(html, new RegExp(`window.FM_STANDALONE_UAT=\\{"name":"UAT","source":"local","revision":"${version}","publication":"unpublished","action":"Show version details"\\}`));
  assert.match(html, new RegExp(`<span class="uat-deployment-label" role="status" title="UAT · local, unpublished; not Main · full revision ${version}">UAT · local · ${version.slice(0, 6)}`));
  assert.doesNotMatch(html, /<footer class="uat-deployment-label"|uat-label-desktop|uat-label-phone/);
  assert.match(html, /<script src="\/sidebar-version\.js"><\/script>/);
  assert.doesNotMatch(html, /Active:|Candidate/);
  assert.doesNotMatch(html, /FM_PREVIEW_ID="main"|preview-selector\.js|Warm Main/);
  assert.deepEqual(await (await fetch(`${base}/api/previews`)).json(), []);
  assert.match(await (await fetch(`${base}/styles.css`)).text(), /\.uat-deployment-label/);
  assert.match(await (await fetch(`${base}/sidebar-version.js`)).text(), /FM_STANDALONE_UAT/);
  const servedSelector = await fetch(`${base}/preview-selector.js`);
  assert.equal(servedSelector.status, 200);
  assert.match(await servedSelector.text(), /input\.placeholder = "Message firstmate"/);
  assert.match(html, /id="review-message"[^>]*placeholder="Message firstmate"/);
});

test("JSON API honors gzip negotiation while preserving uncompressed clients", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-gzip-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Compression fixture.\n");
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (encoding) => new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: server.address().port, path: "/api/lanes", headers: encoding ? { "accept-encoding": encoding } : {} }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks), status: response.statusCode }));
      response.on("error", reject);
    }).on("error", reject);
  });
  const plain = await request();
  const compressed = await request("br, gzip;q=1");
  const refused = await request("gzip;q=0");
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers.vary, "Accept-Encoding");
  assert.deepEqual(JSON.parse(gunzipSync(compressed.body)).lanes, JSON.parse(plain.body).lanes);
  assert.ok(compressed.body.length < plain.body.length);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(refused.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(refused.body).lanes, JSON.parse(plain.body).lanes);
});

test("lane filters document and implement All as an override", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(script, /const checked = live\.filter\(\(lane\) => allLanesSelected \|\| selectedLaneIds\.has\(lane\.id\)\)/);
  assert.match(script, /checked\.filter\(\(lane\) => laneStatusFilter === "all" \|\| lane\.status === laneStatusFilter\)/);
  assert.match(script, /if \(input\.matches\("\[data-filter-all\]"\)\)/);
  assert.match(script, /selectedLaneIds = new Set\(liveLanes\(\)\.map/);
  assert.doesNotMatch(script, /LANE_ORDER_KEY|dragstart|draggable=/);
  assert.match(script, /lane\.id !== "general"/);
  assert.doesNotMatch(script, /#lane-select-all/);
  assert.match(script, /window\.bulkControls/);
  assert.match(script, /sync: syncBulkControls/);
  assert.match(script, /filterView\.renderLaneFilters/);
  assert.match(script, /#lane-bulk-toggle/);
  assert.match(script, /conversation-filter-shortcut/);
  assert.match(script, /setLaneFiltersExpanded\(true\)/);
  assert.match(script, /showView\("conversations"/);
  assert.match(script, /return lanes\.filter\(\(lane\) => !lane\.closed\)/);
  assert.match(script, /showView\("closed"\)/);
  assert.match(script, /data-closed-lane/);
  assert.doesNotMatch(script, /<details class="closed-lanes"/);
  assert.doesNotMatch(script, /\$\{chosen\.length\} of \$\{lanes\.length\} lanes/);
});

test("message kinds are independent, persisted feed filters with crew off by default", async () => {
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const kinds = await readFile(new URL("../public/message-kinds.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(kinds, /id: "conversation", label: "Firstmate replies"/);
  assert.match(kinds, /id: "supervision", label: "supervision outcomes"/);
  assert.match(kinds, /id: "thinking", label: "thinking"/);
  assert.match(kinds, /id: "crew", label: "crew status"/);
  assert.match(kinds, /return new Set\(DEFAULT_IDS\)/);
  assert.match(kinds, /DEFAULT_IDS = \["captain", "conversation", "supervision"\]/);
  assert.match(kinds, /message\.role === "captain" \? "captain"/);
  assert.match(html, /<script src="\/message-kinds\.js"><\/script>/);
  assert.match(html, /<script src="\/filter-view\.js"><\/script>/);
  assert.match(script, /savePreference\(MESSAGE_TYPES_KEY/);
  assert.match(script, /selectedMessageTypes\.has\(messageTypeId\(message\)\)/);
  assert.match(script, /#kinds-bulk-toggle/);
  assert.doesNotMatch(script, /#message-types-select-all/);
  assert.match(script, /new Set\(MESSAGE_TYPES\.map\(\(type\) => type\.id\)\)/);
  assert.match(script, /filterView\.renderKindFilters/);
  assert.match(script, /MESSAGE_FORMAT_KEY/);
  assert.match(script, /messageFormat === "markdown" \? renderMarkdown/);
});

test("inbox records keep causal order when mtime is newer than worker activity", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-order-"));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await mkdir(path.join(home, "inbox"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Test causal ordering.\n");
  await writeFile(path.join(home, "state", "alpha-task.meta"), `endpoint_task_id=alpha-task\nproject=${path.join(home, "projects", "Alpha")}\n`);
  const notePath = path.join(home, "inbox", "captain.note");
  await writeFile(notePath, "Drive the worker activity.\n");
  const statusPath = path.join(home, "state", "alpha-task.status");
  await writeFile(statusPath, "working: responding to the captain\n");
  const now = Date.now();
  await utimes(statusPath, new Date(now + 1000), new Date(now + 1000));
  await utimes(notePath, new Date(now + 2000), new Date(now + 2000));

  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const data = await fetch(`http://127.0.0.1:${port}/api/lanes`).then((response) => response.json());

  // A headerless legacy inbox note is unverified input, not the Captain's (authorship.js).
  assert.deepEqual(data.lanes[0].messages.map((message) => message.role), ["input", "crew"]);
  assert.equal(data.lanes[0].messages[0].text, "Drive the worker activity.");
});

test("equal-clock transcript prompts sort before their response and status", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-equal-clock-"));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state", "branch-session"), { recursive: true });
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Verify equal-clock ordering.\n");
  await writeFile(path.join(home, "state", "alpha-task.meta"), `endpoint_task_id=alpha-task\nproject=${path.join(home, "projects", "Alpha")}\n`);
  const statusPath = path.join(home, "state", "alpha-task.status");
  await writeFile(statusPath, "working: consequent status\n");
  const occurredAt = "2026-02-01T12:00:00.000Z";
  await utimes(statusPath, new Date(occurredAt), new Date(occurredAt));
  await writeFile(path.join(home, "state", "branch-session", "equal.jsonl"), [
    JSON.stringify({ type: "custom_message", customType: "fm-main-mirror", content: "[captain] Alpha: driving prompt", timestamp: occurredAt }),
    JSON.stringify({ type: "message", timestamp: occurredAt, message: { role: "assistant", content: [{ type: "text", text: "Alpha response" }] } }),
  ].join("\n"));

  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const data = await fetch(`http://127.0.0.1:${port}/api/lanes`).then((response) => response.json());

  assert.deepEqual(data.lanes[0].messages.map((message) => message.text), [
    "Alpha: driving prompt",
    "Alpha response",
    "working: consequent status",
  ]);
  assert.ok(data.lanes[0].messages.every((message) => message.occurredAt === occurredAt));
});

test("rollupLedger totals exact cents overall and by project", () => {
  const result = rollupLedger({
    default_currency: "USD",
    entries: [
      { amount: "10.10", project_id: "alpha", project_name: "Alpha" },
      { amount: "-0.10", project_id: "alpha" },
      { amount: "7.50", currency: "EUR", project_id: "beta" },
    ],
  });

  assert.deepEqual(result.overall, [
    { currency: "EUR", amount: "7.50" },
    { currency: "USD", amount: "10.00" },
  ]);
  assert.deepEqual(result.projects[0], {
    id: "alpha",
    name: "Alpha",
    totals: [{ currency: "USD", amount: "10.00" }],
  });
});

test("rollupLedger returns category totals and readable ledger detail without combining currencies", () => {
  const result = rollupLedger({
    default_currency: "USD",
    entries: [
      { id: "one", date: "2026-01-01", amount: "20.00", project_id: "quarterdeck", project_name: "Quarterdeck", note: "[estimate] Cloudflare hosting" },
      { id: "two", date: "2026-01-02", amount: "9.00", currency: "EUR", project_id: "quarterdeck", project_name: "Quarterdeck", category: "api", description: "Model API usage", confidence: "high" },
      { id: "three", date: "2026-01-03", amount: "2.00", project_id: "misc", note: "Team lunch" },
    ],
  });

  assert.deepEqual(result.categories, [
    { name: "API", totals: [{ currency: "EUR", amount: "9.00" }] },
    { name: "Hosting", totals: [{ currency: "USD", amount: "20.00" }] },
    { name: "Uncategorized", totals: [{ currency: "USD", amount: "2.00" }] },
  ]);
  assert.deepEqual(result.entries[0], {
    id: "one",
    date: "2026-01-01",
    projectId: "quarterdeck",
    projectName: "Quarterdeck",
    category: "Hosting",
    amount: "20.00",
    currency: "USD",
    description: "Cloudflare hosting",
    confidence: "Estimate",
  });
  assert.equal(result.entries[1].description, "Model API usage");
  assert.equal(result.entries[1].confidence, "High");
  assert.equal(result.entries[2].category, "Uncategorized");
});

test("rollupLedger preserves readable slash-separated category labels", () => {
  const result = rollupLedger({
    default_currency: "USD",
    entries: [{ amount: "10.00", project_id: "example-store", category: "Cloud/Azure" }],
  });

  assert.equal(result.categories[0].name, "Cloud/Azure");
  assert.equal(result.entries[0].category, "Cloud/Azure");
});

test("rollupLedger reports the default currency for an empty ledger", () => {
  assert.deepEqual(rollupLedger({ default_currency: "USD", entries: [] }), {
    entryCount: 0,
    overall: [{ currency: "USD", amount: "0.00" }],
    projects: [],
    categories: [],
    entries: [],
  });
});

test("rollupLedger omits an unused default currency", () => {
  const result = rollupLedger({
    default_currency: "USD",
    entries: [{ amount: "7.50", currency: "EUR", project_id: "alpha" }],
  });

  assert.deepEqual(result.overall, [{ currency: "EUR", amount: "7.50" }]);
});

test("rollupLedger preserves arbitrary-size cents exactly", () => {
  const result = rollupLedger({
    default_currency: "USD",
    entries: [
      { amount: "10000000000000000000000000000.01", project_id: "alpha" },
      { amount: "0.99", project_id: "alpha" },
      { amount: "90071992547409.91", project_id: "beta" },
      { amount: "0.01", project_id: "beta" },
    ],
  });

  assert.deepEqual(result.overall, [{ currency: "USD", amount: "10000000000000090071992547410.92" }]);
  assert.deepEqual(result.projects, [
    { id: "alpha", name: "alpha", totals: [{ currency: "USD", amount: "10000000000000000000000000001.00" }] },
    { id: "beta", name: "beta", totals: [{ currency: "USD", amount: "90071992547409.92" }] },
  ]);
});

test("server starts and serves validated configured fleet data", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-"));
  const fleetPath = path.join(directory, "fleet.json");
  await writeFile(fleetPath, JSON.stringify({
    summary: { activeAgents: 1, openDecisions: 0, completedToday: 0 },
    projects: [{
      id: "test",
      name: "Test Project",
      status: "active",
      mission: "Exercise the configured fleet boundary",
      agents: 1,
      progress: 50,
      items: [{ title: "test-worker", state: "in-progress", taskIntent: "Verify dashboard intent rendering" }],
    }],
  }));

  const server = createServer({ FM_STATUS_PATH: fleetPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, service: "fm-quarterdeck" });

  const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((response) => response.json());
  assert.equal(dashboard.fleet.source, "configured status");
  assert.equal(dashboard.fleet.projects[0].id, "test");
  assert.equal(dashboard.fleet.projects[0].intent, "Exercise the configured fleet boundary");
  assert.equal(dashboard.fleet.projects[0].items[0].taskIntent, "Verify dashboard intent rendering");
  assert.equal("sourcePath" in dashboard.fleet, false);
  assert.equal("sourcePath" in dashboard.expenses, false);
  assert.ok(Array.isArray(dashboard.expenses.overall));
});

test("live lanes and fleet are derived from a fake FM_HOME", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-home-"));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await mkdir(path.join(home, "inbox", "handled"), { recursive: true });
  await mkdir(path.join(home, "state", "alpha-task.inbox", "handled"), { recursive: true });
  await mkdir(path.join(home, "state", "x-outbox"));
  await mkdir(path.join(home, "state", "public-followup", "outbox"), { recursive: true });
  await mkdir(path.join(home, "state", "branch-session"));
  await mkdir(path.join(home, "data", "alpha-task"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha [direct-PR] - Ship the real Alpha work.\n- Beta - Keep Beta visible.\n- Gamma - Preserve completed work.\n- Example Store - Keep synthetic retained work visible.\n");
  await writeFile(path.join(home, "data", "backlog.md"), "# Backlog\n\n## In flight\n- [ ] alpha-task - Do live work (repo: Alpha)\n  Backlog detail for Alpha.\n## Done\n- [x] gamma-task - Completed historical work (repo: Gamma)\n## Queued\n");
  await writeFile(path.join(home, "data", "alpha-task", "brief.md"), "# Task\n## Captain's intent\nMake Alpha useful as a command summary with enough detail to understand the worker.\n\n## Firstmate spec\nImplement it.\n");
  await writeFile(path.join(home, "state", "alpha-task.meta"), `endpoint_task_id=alpha-task\nproject=${path.join(home, "projects", "Alpha")}\n`);
  await writeFile(path.join(home, "state", "example-store-task.meta"), `endpoint_task_id=example-store-task\nproject=${path.join(home, "projects", "Example Store")}\n`);
  const statusPath = path.join(home, "state", "alpha-task.status");
  await writeFile(statusPath, "working: parsed the registry\nneeds-decision [key=choice]: choose a route\n");
  await utimes(statusPath, new Date("2026-01-03T00:00:00Z"), new Date("2026-01-03T00:00:00Z"));
  const closedStatusPath = path.join(home, "state", "gamma-task.status");
  await writeFile(closedStatusPath, "done: completed historical Gamma work\n");
  await utimes(closedStatusPath, new Date("2025-12-31T00:00:00Z"), new Date("2025-12-31T00:00:00Z"));
  const liveDoneStatusPath = path.join(home, "state", "example-store-task.status");
  await writeFile(liveDoneStatusPath, "done: PR signed candidate is still being monitored\n");
  await utimes(liveDoneStatusPath, new Date("2026-01-08T00:00:00Z"), new Date("2026-01-08T00:00:00Z"));
  await writeFile(path.join(home, "state", "alpha-task.inbox", "001.msg"), "schema=fm-task-inbox.v1\nat=2026-01-01T00:00:00Z\n--\nStart with the live inbox.\n");
  await writeFile(path.join(home, "state", "alpha-task.inbox", "handled", "002.msg"), "schema=fm-task-inbox.v1\nat=2026-01-02T00:00:00Z\n--\nKeep the handled steer visible.\n");
  await writeFile(path.join(home, "state", "public-followup", "outbox", "event.json"), JSON.stringify({ work_id: "alpha-task", occurred_at: "2026-01-04T00:00:00Z", outcome_type: "done", public_safe_outcome: "Public follow-up staged." }));
  await writeFile(path.join(home, "state", "x-outbox", "reply.json"), JSON.stringify({ occurred_at: "2026-01-05T00:00:00Z", endpoint: "reply", texts: ["Dry-run reply staged."] }));
  await writeFile(path.join(home, "inbox", "captain.note"), "id=captain\nat=2026-01-06T00:00:00Z\nsource=text\n--\nCaptain note for the fleet.\n");
  await writeFile(path.join(home, "state", "branch-session", "2026-01-07_session.jsonl"), [
    JSON.stringify({ type: "custom_message", customType: "fm-main-mirror", content: "[captain] Alpha: Show my live chat message.", timestamp: "2026-01-07T00:00:00Z" }),
    JSON.stringify({ type: "message", timestamp: "2026-01-07T00:00:01Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Checking the durable Alpha records." },
      { type: "text", text: "[fm-lane Alpha]\nThe Alpha records are live.\n[end Alpha]" },
      { type: "toolCall", name: "read", arguments: {} },
    ] } }),
    JSON.stringify({ type: "custom_message", customType: "fm-main-mirror", content: "[main] This is not captain-authored.", timestamp: "2026-01-07T00:01:00Z" }),
  ].join("\n"));

  const server = createServer({ FM_HOME: home, FM_STATUS_PATH: "/must/not/be/read.json" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const lanesResponse = await fetch(`http://127.0.0.1:${port}/api/lanes`);
  const data = await lanesResponse.json();
  assert.equal(lanesResponse.status, 200);
  assert.equal(data.source, "Firstmate home");
  assert.equal(data.lanes.length, 5);
  assert.equal(data.lanes[0].name, "Alpha");
  assert.equal(data.lanes[0].status, "needs-decision");
  assert.deepEqual(data.lanes[0].items.map(({ classification, ...item }) => item), [{
    title: "alpha-task",
    state: "needs-decision",
    isLive: false,
    taskIntent: "Do live work — Make Alpha useful as a command summary with enough detail to understand the worker.",
  }]);
  assert.equal(data.lanes[0].intent, "Ship the real Alpha work.");
  assert.deepEqual(data.lanes[0].messages.map(({ role, source }) => ({ role, source })), [
    { role: "firstmate", source: "state/alpha-task.inbox/001.msg" },
    { role: "firstmate", source: "state/alpha-task.inbox/handled/002.msg" },
    { role: "crew", source: "state/alpha-task.status" },
    { role: "crew", source: "state/alpha-task.status" },
    { role: "outbox", source: "state/public-followup/outbox/event.json" },
    { role: "outbox", source: "state/x-outbox/reply.json" },
    { role: "input", source: "inbox/captain.note" },
    { role: "input", source: "state/branch-session/2026-01-07_session.jsonl" },
    { role: "firstmate", source: "state/branch-session/2026-01-07_session.jsonl" },
    { role: "firstmate", source: "state/branch-session/2026-01-07_session.jsonl" },
  ]);
  assert.equal(data.lanes[0].messages[0].kind, "steer");
  assert.equal(data.lanes[0].messages[0].author, "Firstmate");
  assert.equal(data.lanes[0].messages[0].text, "Start with the live inbox.");
  assert.equal(data.lanes[0].messages[2].text, "working: parsed the registry");
  assert.equal(data.lanes[0].messages[4].text, "Public follow-up staged.");
  assert.deepEqual([data.lanes[0].messages[6].author, data.lanes[0].messages[7].author], ["Inbox note", "Pi session input"], "neither inbox presence nor a [captain] mirror is authorship");
  assert.equal(data.lanes[0].messages[2].kind, "crew");
  assert.equal(data.lanes[0].messages[4].kind, "crew", "worker outbox broadcasts belong to the crew filter");
  assert.equal(data.lanes[0].messages[2].occurredAt, data.lanes[0].messages[3].occurredAt, "status line order must not be fabricated with mtime padding");
  assert.deepEqual(data.lanes[0].messages.slice(7, 10).map((message) => message.text), [
    "Alpha: Show my live chat message.",
    "Checking the durable Alpha records.",
    "[fm-lane Alpha]\nThe Alpha records are live.\n[end Alpha]",
  ]);
  assert.equal(data.lanes[0].messages[8].kind, "thinking");
  assert.equal(data.lanes[0].sessions[0].id, "alpha-task");
  assert.ok(data.lanes[0].messages.every((message) => !Number.isNaN(Date.parse(message.occurredAt))));
  assert.deepEqual(
    data.lanes[0].messages.map((message) => message.occurredAt),
    data.lanes[0].messages.map((message) => message.occurredAt).toSorted(),
  );
  assert.equal(JSON.stringify(data).includes(home), false);
  assert.deepEqual(data.lanes[1].messages.map((message) => message.role), ["outbox", "input"]);
  assert.equal(data.lanes[2].name, "Gamma");
  assert.equal(data.lanes[2].closed, true);
  assert.equal(data.lanes[2].status, "closed");
  assert.equal(data.lanes[2].sessions[0].id, "gamma-task");
  assert.equal(data.lanes[2].sessions[0].isLive, false);
  assert.equal(data.lanes[3].name, "Example Store");
  assert.equal(data.lanes[3].closed, true);
  assert.equal(data.lanes[3].laneOpen, false);
  assert.equal(data.lanes[3].status, "closed");
  assert.equal(data.lanes[3].crew, 0);
  assert.deepEqual(data.lanes[3].items.map(({ classification, ...item }) => item), [{ title: "example-store-task", state: "done", isLive: false, taskIntent: "Task intent not recorded." }]);
  assert.equal(data.lanes[4].name, "General");
  assert.deepEqual(data.lanes[4].messages.map((message) => message.role), ["outbox", "input", "input", "firstmate", "firstmate", "firstmate"]);
  assert.ok(!data.lanes[4].messages.some((message) => message.text.startsWith("[fm-lane Alpha]")), "explicit Alpha reply is not also General");
  assert.equal(data.lanes[4].messages.at(-1).kind, "conversation");
  assert.equal(data.lanes[4].messages[0].kind, "crew");
  assert.match(data.lanes[4].messages.at(-1).source, /^state\/branch-session\//);

  const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((response) => response.json());
  assert.equal(dashboard.fleet.source, "Firstmate home");
  for (const activity of [data.firstmateActivity, dashboard.firstmateActivity]) {
    assert.deepEqual(Object.keys(activity).sort(), ["heartbeatAt", "lastTurnAt", "lastWakeAt", "readAt", "watcherBeatAt"]);
    assert.equal(activity.lastWakeAt, null);
    assert.equal(activity.watcherBeatAt, null);
    assert.ok(Number.isFinite(Date.parse(activity.readAt)));
  }
  assert.equal(dashboard.fleet.summary.activeAgents, 0, "meta files and captain decisions are not executing workers");
  assert.equal(dashboard.fleet.summary.openDecisions, 1);
  assert.equal(dashboard.fleet.projects[0].name, "Alpha");
  assert.equal(dashboard.fleet.projects[0].intent, "Ship the real Alpha work.");
  assert.match(dashboard.fleet.projects[0].items[0].taskIntent, /Make Alpha useful/);
});

test("done meta without status stays visible but does not invent a completion date", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-done-no-status-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Keep completed tasks visible.\n");
  await writeFile(path.join(home, "data", "backlog.md"), `## Done\n- [x] missing-status - Completed without status history (repo: Alpha) (done ${new Date().toISOString().slice(0, 10)})\n- [x] dated-status - Completed with status history (repo: Alpha)\n`);
  for (const id of ["missing-status", "dated-status"]) {
    await writeFile(path.join(home, "state", `${id}.meta`), `project=${path.join(home, "projects", "Alpha")}\n`);
  }
  await writeFile(path.join(home, "state", "dated-status.status"), "done [at=unknown]: recorded completion\n");
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const lanesResponse = await fetch(`${origin}/api/lanes`);
  assert.equal(lanesResponse.status, 200);
  const lanes = await lanesResponse.json();
  const alpha = lanes.lanes.find((lane) => lane.name === "Alpha");
  assert.deepEqual(alpha.items.map((item) => item.title), ["dated-status", "missing-status"]);
  const { classification, ...missingStatus } = alpha.sessions.find((item) => item.id === "missing-status");
  assert.deepEqual(missingStatus, {
    id: "missing-status", state: "done", eventCount: 0, isLive: false, startedAt: null, updatedAt: null, loaded: true,
  });
  const dashboardResponse = await fetch(`${origin}/api/dashboard`);
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.equal(dashboard.fleet.summary.completedToday, 1, "only the explicitly dated backlog completion counts; a status mtime is not a completion clock");
  assert.equal(dashboard.fleet.projects.find((project) => project.name === "Alpha").items.length, 2);
});

test("work split uses explicit notes and briefs, not titles or a second ledger", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-work-split-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data", "discovery"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Alpha work.\n");
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(path.join(home, "data", "backlog.md"), `# Backlog\n## In flight\n- [ ] discovery - Explore capability (repo: Alpha)\n  This is a large project; implementation path is unfolding.\n- [ ] blocked - New capability (repo: Alpha) (hold: Captain input required)\n  Large project with an open decision.\n- [ ] long-title - Large project title alone (repo: Alpha)\n  One bounded behavior.\n## Queued\n- [ ] brief-only - Expand capability (repo: Alpha)\n- [ ] small - Scoped fix (repo: Alpha)\n## Done\n- [x] landed - Shipped fix (repo: Alpha) (done ${today})\n- [x] historic - Old fix (repo: Alpha) (done 2020-01-01)\n`);
  await mkdir(path.join(home, "data", "brief-only"));
  await writeFile(path.join(home, "data", "brief-only", "brief.md"), "# Task\nThis is a large project.\nStage: Discovery\nWaiting for a design decision.\n");
  await writeFile(path.join(home, "state", "discovery.status"), "working: started\npaused: Waiting for upstream proof\n");
  const split = (await dashboardData({ FM_HOME: home })).fleet.workSplit;
  assert.deepEqual(split.tight.backlog.items.map((item) => item.id), ["small"]);
  assert.deepEqual(split.tight.backlog.items[0], { id: "small", name: "Scoped fix", repository: "Alpha", workGroup: null, waitingOn: null });
  assert.deepEqual(split.tight.inProgress.items.map((item) => item.id), ["long-title"]);
  assert.deepEqual(split.tight.justLanded.items.map((item) => item.id), ["landed"]);
  assert.equal(split.large.count, 3);
  assert.deepEqual(split.large.projects.map(({ id, stage, waitingOn }) => ({ id, stage, waitingOn })), [
    { id: "discovery", stage: "paused", waitingOn: "Waiting for upstream proof" },
    { id: "blocked", stage: "In progress", waitingOn: "Captain input required" },
    { id: "brief-only", stage: "Discovery", waitingOn: "a design decision" },
  ]);
  assert.equal(JSON.stringify(split).includes(home), false);
});

test("work split uses only explicit backlog theme/epic and durable repo metadata", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-work-groups-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Work.\n- Beta - Work.\n");
  await writeFile(path.join(home, "data", "backlog.md"), `# Backlog
## Queued
- [ ] alpha - Bounded task (repo: Alpha) (epic: Checkout <safe>)
- [ ] beta - Other task (repo: Beta) (theme: Reliability)
- [ ] empty - Fix reliability checkout (repo: Alpha)
- [ ] orphan - Without repository (theme: Reliability)
## In flight
- [ ] large - Capability (repo: Wrong) (epic: Checkout <safe>)
  This is a large project.
`);
  await writeFile(path.join(home, "state", "large.meta"), `project=${path.join(home, "projects", "Beta")}\n`);
  const split = (await dashboardData({ FM_HOME: home })).fleet.workSplit;
  assert.deepEqual(split.tight.backlog.items.map(({ id, repository, workGroup }) => ({ id, repository, workGroup })), [
    { id: "alpha", repository: "Alpha", workGroup: { kind: "epic", name: "Checkout <safe>" } },
    { id: "beta", repository: "Beta", workGroup: { kind: "theme", name: "Reliability" } },
    { id: "empty", repository: "Alpha", workGroup: null },
    { id: "orphan", repository: null, workGroup: { kind: "theme", name: "Reliability" } },
  ]);
  assert.deepEqual(split.large.projects.map(({ repository, workGroup, phase }) => ({ repository, workGroup, phase })), [
    { repository: "Beta", workGroup: { kind: "epic", name: "Checkout <safe>" }, phase: "inProgress" },
  ]);
  assert.equal(JSON.stringify(split).includes(home), false);
});

test("lanes fail closed with a useful error when FM_HOME is unset", async (context) => {
  const server = createServer({});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/lanes`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /set FM_HOME/);
  assert.doesNotMatch(body.error, /demo/i);
});

test("lanes fail closed without exposing an unreadable FM_HOME path", async (context) => {
  const privatePath = path.join(os.tmpdir(), "private-firstmate-does-not-exist");
  const server = createServer({ FM_HOME: privatePath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/lanes`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.error, /unreadable/);
  assert.equal(body.error.includes(privatePath), false);
});

test("server rejects malformed configured fleet data", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-invalid-"));
  const fleetPath = path.join(directory, "fleet.json");
  await writeFile(fleetPath, JSON.stringify({ summary: null, projects: [{ items: [{ title: "x" }] }] }));

  const server = createServer({ FM_STATUS_PATH: fleetPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  const dashboard = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(dashboard, { error: "Quarterdeck could not load data" });
});

test("server does not expose a missing configured fleet path", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-missing-"));
  const fleetPath = path.join(directory, "private-fleet.json");
  const server = createServer({ FM_STATUS_PATH: fleetPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  const dashboard = await response.json();
  assert.equal(response.status, 500);
  assert.deepEqual(dashboard, { error: "Quarterdeck could not load data" });
});

test("/api/lanes includes transcript metadata, disk sessions, and source details", async (context) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-home-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await mkdir(path.join(home, "state", "branch-session"), { recursive: true });
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Ship the Alpha work.\n");
  await writeFile(path.join(home, "state", "alpha-task.status"), "working: task started\n");
  await writeFile(path.join(home, "state", "branch-session", "2026-01-01_session.jsonl"), JSON.stringify({
    type: "message",
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "Alpha task loaded." }] },
  }) + "\n");

  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/lanes`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.transcript, "transcript metadata must be present in /api/lanes");
  assert.ok(Array.isArray(data.transcript.sessions));
  assert.ok(Array.isArray(data.transcript.warnings));
  assert.ok(Array.isArray(data.transcript.outcomeSources));
  assert.equal(typeof data.transcript.note, "string");
  assert.equal(data.transcript.sessions.length > 0, true);
  assert.equal(data.transcript.sessions[0].id, "state/branch-session/2026-01-01_session.jsonl");
});
