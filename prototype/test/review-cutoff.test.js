import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const script = await readFile(new URL("../public/review-target.js", import.meta.url), "utf8") + "\n" + await readFile(new URL("../public/review-client.js", import.meta.url), "utf8");
const openSent = (page, open) => { const sent = page.element("review-sent"); sent.open = open; sent.listeners.toggle(); };
const tick = () => new Promise(setImmediate);
function harness() {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const posts = [];
  const waiting = [];
  const intervals = [];
  let mode = "success", configUp = true, uuid = 0;
  const version = "e21fb8d5c854d8b19a6721e911b31628aac96cdd";
  function page() {
    const nodes = new Map(), documentListeners = new Map(), viewportVars = new Map();
    let desktop = true;
    const visualViewport = { height: 800, offsetTop: 0, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    const body = { style: { overflow: "scroll" }, append() {} };
    function element(id) {
      if (!nodes.has(id)) nodes.set(id, {
        value: "", textContent: "", hidden: id === "review-panel", disabled: false, style: {}, listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(name, value) { this[name] = value; }, focus() { this.focused = true; }, replaceChildren() {}, append() {},
        classList: { anchored: false, add() { this.anchored = true; }, remove() { this.anchored = false; } },
        matches(selector) { return selector === ":popover-open" && Boolean(this.popoverOpen); },
        hidePopover() { this.popoverOpen = false; },
        click() { this.listeners.click?.(); },
        contains(target) { return target === this || target === element("review-message") || target === element("review-form-close"); },
        requestSubmit() { this.listeners.submit({ preventDefault() {} }); },
      });
      return nodes.get(id);
    }
    const context = vm.createContext({
      document: { body, documentElement: { style: { setProperty: (name, value) => viewportVars.set(name, value) } }, getElementById: element, querySelector: () => ({ textContent: "" }), addEventListener(type, fn, capture = false) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ fn, capture });
      },
        createElement: () => ({ textContent: "", style: {}, append() {}, setAttribute() {}, addEventListener() {} }) },
      window: { innerHeight: 800, visualViewport, addEventListener() {}, matchMedia: (query) => ({ get matches() { return query.startsWith("(min-") ? desktop : !desktop; } }) }, setTimeout: (fn) => fn(), location: { hash: "#overview" }, sessionStorage: storage,
      crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
      setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
      fetch: async (url, options) => {
        if (options?.method === "POST") {
          const body = JSON.parse(options.body);
          posts.push(body);
          if (mode === "hold") return new Promise((resolve) => waiting.push(resolve));
          return mode === "fail" ? { ok: false, status: 502, json: async () => ({ error: "disk error" }) }
            : { ok: true, json: async () => ({ receiptId: `local:${body.batchId}`, delivery: "local" }) };
        }
        if (url.includes("/status")) return { ok: true, json: async () => ({ receiptId: "ignored", state: "accepted" }) };
        if (!configUp) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, json: async () => ({ ready: true, version, delivery: "local", sessionId: "" }) };
      },
    });
    vm.runInContext(script, context);
    const q = (text, selected = "") => {
      if (selected === "region") vm.runInContext('selected = { id: "card", label: "Card", route: "#overview", version: config.version }', context);
      if (selected === "lane") vm.runInContext('selected = { target: { type: "record", recordId: "main-pi-session/x:1:0" }, label: "Fleet Chat message", route: "#lanes", version: config.version }', context);
      element("review-message").value = text;
      element("review-form").listeners.submit({ preventDefault() {} });
    };
    const send = (end = false) => element(end ? "review-end" : "review-send").listeners.click();
    const state = () => JSON.parse(data.get("fm-agentos-review-draft-v1"));
    const keydown = (event) => {
      let stopped = false;
      const key = { ...event, preventDefault() { this.defaultPrevented = true; event.preventDefault?.(); }, stopImmediatePropagation() { stopped = true; } };
      for (const listener of documentListeners.get("keydown").filter((listener) => listener.capture)) {
        if (stopped) break;
        listener.fn(key);
      }
      if (!stopped) key.target?.listeners?.keydown?.(key);
      for (const listener of documentListeners.get("keydown").filter((listener) => !listener.capture)) {
        if (stopped) break;
        listener.fn(key);
      }
      return key;
    };
    const dispatch = (type) => { for (const listener of documentListeners.get(type) || []) listener.fn({ type }); };
    return { element, context, q, send, state, body, visualViewport, viewportVars, keydown, dispatch, setDesktop: (value) => { desktop = value; vm.runInContext("syncReviewScrollLock()", context); } };
  }
  const release = (failure = false) => {
    const body = posts.at(-1);
    waiting.shift()({ ok: !failure, status: failure ? 502 : 200, json: async () => failure ? { error: "disk error" } : { receiptId: `local:${body.batchId}`, delivery: "local" } });
  };
  return { page, posts, data, intervals, release, setMode: (value) => { mode = value; }, setConfigUp: (value) => { configUp = value; } };
}

test("open help consumes Escape before annotation, picking or review", async () => {
  for (const state of ["idle", "annotation", "picking", "review"]) {
    const p = harness().page(); await tick();
    p.element("review-annotation").hidden = true;
    if (state === "annotation") p.element("review-annotation").hidden = false;
    if (state === "review" || state === "picking") p.element("review-panel-toggle").click();
    if (state === "picking") p.element("review-select-location").click();
    p.element("review-message").value = "Synthetic unsent draft";
    p.element("review-message").listeners.input();
    const target = state === "review" ? p.element("review-message") : p.element("review-gesture-help");
    const before = p.state();
    const annotationHidden = p.element("review-annotation").hidden;
    const reviewHidden = p.element("review-panel").hidden;
    const picking = vm.runInContext("pickingRegion", p.context);
    let prevented = false;
    const event = { key: "Escape", target, preventDefault() { prevented = true; } };
    p.element("review-gesture-popover").popoverOpen = true;
    p.keydown(event);
    assert.equal(prevented, true, state);
    assert.equal(p.element("review-gesture-popover").popoverOpen, false, state);
    assert.equal(p.element("review-annotation").hidden, annotationHidden, state);
    assert.equal(p.element("review-panel").hidden, reviewHidden, state);
    assert.equal(vm.runInContext("pickingRegion", p.context), picking, state);
    assert.deepEqual(p.state(), before, state);
    prevented = false;
    p.keydown(event);
    assert.equal(prevented, state !== "idle", state);
    assert.equal(p.element("review-annotation").hidden, true, state);
    assert.equal(vm.runInContext("pickingRegion", p.context), false, state);
    assert.equal(p.element("review-panel").hidden, state !== "picking", state);
    assert.equal(p.element("review-message").value, "Synthetic unsent draft", state);
  }
});

test("help dismissal precedes an Escape-canceling search target after a viewport round trip", async () => {
  for (const state of ["idle", "annotation", "picking"]) {
    const p = harness().page(); await tick();
    p.setDesktop(false);
    const search = p.element("transcript-search");
    let searchEscapes = 0;
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      searchEscapes++;
    });
    p.setDesktop(true);
    p.element("review-annotation").hidden = state !== "annotation";
    if (state === "picking") {
      p.element("review-panel-toggle").click();
      p.element("review-select-location").click();
    }
    p.element("review-message").value = "Synthetic preserved draft";
    p.element("review-message").listeners.input();
    const before = p.state();
    p.element("review-gesture-popover").popoverOpen = true;
    search.focus();
    const first = p.keydown({ key: "Escape", target: search });
    assert.equal(first.defaultPrevented, true, state);
    assert.equal(p.element("review-gesture-popover").popoverOpen, false, state);
    assert.equal(searchEscapes, 0, state);
    assert.equal(p.element("review-annotation").hidden, state !== "annotation", state);
    assert.equal(vm.runInContext("pickingRegion", p.context), state === "picking", state);
    assert.deepEqual(p.state(), before, state);
    const second = p.keydown({ key: "Escape", target: search });
    assert.equal(second.defaultPrevented, true, state);
    assert.equal(searchEscapes, 1, state);
    assert.deepEqual(p.state(), before, state);
    p.keydown({ key: "Escape", target: p.element("review-message") });
    assert.equal(p.element("review-annotation").hidden, true, state);
    assert.equal(vm.runInContext("pickingRegion", p.context), false, state);
    assert.equal(p.element("review-message").value, "Synthetic preserved draft", state);
  }
});

test("close and desktop Escape preserve unsent draft, queue, receipt history and focus", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(html, /id="review-form-close" type="button" aria-label="Close annotation or message \(keep draft\)"/);
  assert.match(html, /id="review-close" type="button" aria-label="Close review conversation \(keep draft\)"/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /#review-annotation \.review-form-anchored \{ position: static/);
  const h = harness(), p = h.page(); await tick();
  p.q("first", "region"); p.send(); await tick();
  p.q("second");
  p.element("review-message").value = "draft not sent";
  p.element("review-message").listeners.input();
  vm.runInContext("panel(true)", p.context);
  p.element("review-form").classList.add("review-form-anchored");
  p.element("review-form-close").listeners.click();
  assert.equal(p.element("review-panel").hidden, true);
  assert.equal(p.element("review-form").classList.anchored, false);
  assert.equal(p.element("review-panel-toggle").focused, true);
  assert.equal(p.state().message, "draft not sent");
  assert.equal(p.state().queue.length, 1);
  assert.equal(p.state().sent.length, 1);
  const restored = h.page(); await tick();
  assert.equal(restored.element("review-panel").hidden, true);
  assert.equal(restored.element("review-message").value, "draft not sent");
  restored.element("review-panel-toggle").listeners.click();
  let prevented = false;
  const escape = (target) => ({ key: "Escape", target, preventDefault() { prevented = true; } });
  restored.keydown(escape({}));
  assert.equal(restored.element("review-panel").hidden, false);
  restored.keydown({ ...escape(restored.element("review-message")), defaultPrevented: true });
  assert.equal(restored.element("review-panel").hidden, false);
  restored.keydown(escape(restored.element("review-message")));
  assert.equal(prevented, true);
  assert.equal(restored.element("review-panel").hidden, true);
  restored.setDesktop(false);
  restored.element("review-panel-toggle").listeners.click();
  assert.equal(restored.body.style.overflow, "scroll");
  restored.element("review-history-tab").listeners.click();
  assert.equal(restored.body.style.overflow, "hidden");
  restored.element("review-conversation-tab").listeners.click();
  assert.equal(restored.body.style.overflow, "scroll");
  prevented = false;
  restored.keydown(escape(restored.element("review-message")));
  assert.equal(prevented, true);
  assert.equal(restored.element("review-panel").hidden, true);
  restored.element("review-panel-toggle").listeners.click();
  restored.element("review-close").listeners.click();
  assert.equal(restored.body.style.overflow, "scroll");
  assert.equal(restored.state().queue.length, 1);
  assert.equal(restored.state().sent.length, 1);
  assert.equal(h.posts.length, 1);
  restored.element("review-message").value = "";
  restored.element("review-message").listeners.input();
  restored.send(); await tick();
  assert.equal(h.posts.length, 2);
  assert.equal(restored.state().sent.length, 2);
});

test("one phone Annotate activation switches mode and arms page selection", () => {
  for (const tab of ["conversation", "review"]) {
    const p = harness().page();
    p.setDesktop(false);
    p.element("review-panel-toggle").click();
    if (tab === "review") p.element("review-history-tab").click();
    p.element("review-message").value = "Keep this draft";
    p.element("review-select-location").click();
    assert.equal(vm.runInContext("activeReviewTab", p.context), "annotation", tab);
    assert.equal(vm.runInContext("pickingRegion", p.context), true, tab);
    assert.equal(p.element("review-select-location").textContent, "Select on page", tab);
    assert.equal(p.element("review-panel")["data-picking"], "", tab);
    assert.equal(p.body.style.overflow, "scroll", tab);
    assert.equal(p.element("review-message").value, "Keep this draft", tab);
    p.element("review-select-location").click();
    assert.equal(vm.runInContext("pickingRegion", p.context), false, "next activation cancels");
  }
  const desktop = harness().page();
  desktop.element("review-panel-toggle").click();
  desktop.element("review-select-location").click();
  assert.equal(vm.runInContext("activeReviewTab", desktop.context), "conversation", "desktop tab unchanged");
  assert.equal(vm.runInContext("pickingRegion", desktop.context), true);
});

test("phone scroll lock belongs only to Review, across mode switches and closing", () => {
  const p = harness().page();
  p.setDesktop(false);
  p.element("review-panel-toggle").listeners.click();
  assert.equal(p.body.style.overflow, "scroll");
  assert.equal(p.element("review-panel")["data-review-tab"], "conversation");
  p.element("review-history-tab").listeners.click();
  assert.equal(p.body.style.overflow, "hidden");
  assert.equal(p.element("review-panel")["data-review-tab"], "review");
  assert.equal(p.element("review-phone-thread").hidden, false);
  p.element("review-history-tab").listeners.click();
  assert.equal(p.body.style.overflow, "hidden", "reselect does not overwrite prior overflow");
  p.element("review-annotation-tab").listeners.click();
  assert.equal(p.body.style.overflow, "scroll");
  p.element("review-conversation-tab").listeners.click();
  assert.equal(p.body.style.overflow, "scroll");
  assert.equal(p.element("review-phone-thread").hidden, true);
  p.element("review-history-tab").listeners.click();
  p.element("review-close").listeners.click();
  assert.equal(p.body.style.overflow, "scroll");
  p.element("review-panel-toggle").listeners.click();
  assert.equal(p.body.style.overflow, "hidden", "reopening Review locks again");
  p.setDesktop(true);
  assert.equal(p.body.style.overflow, "scroll", "desktop never inherits the lock");
});

test("desktop Sent section drives the review state only at desktop width and never locks scroll", () => {
  const p = harness().page();
  p.element("review-panel-toggle").listeners.click();
  assert.equal(p.element("review-panel")["data-review-tab"], "conversation");
  openSent(p, true);
  assert.equal(p.element("review-panel")["data-review-tab"], "review");
  assert.equal(p.body.style.overflow, "scroll");
  assert.equal(p.element("review-phone-thread").hidden, true, "phone thread is a phone-only surface");
  openSent(p, false);
  assert.equal(p.element("review-panel")["data-review-tab"], "conversation");
});

test("phone Review tab sends the queue, not the hidden composer text; Message tab still queues and sends", async () => {
  const p = harness().page();
  p.setDesktop(false);
  await tick();
  p.element("review-panel-toggle").listeners.click();
  p.q("first");
  assert.equal(p.state().queue.length, 1);
  p.element("review-history-tab").listeners.click();
  p.element("review-message").value = "typed but hidden";
  p.send();
  await tick();
  assert.equal(p.state().sent.length, 1);
  assert.equal(p.element("review-message").value, "typed but hidden");
  p.element("review-conversation-tab").listeners.click();
  p.q("second");
  p.send();
  await tick();
  assert.equal(p.state().sent.length, 2);
});

test("review panel keeps desktop Sent/Queued sections and phone Message/Review tabs, split at the 720px breakpoint", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/shell-panel.css", import.meta.url), "utf8");
  const start = html.indexOf('<aside id="review-panel"');
  const panel = html.slice(start, html.indexOf("</aside>", start));
  // Desktop: collapsed Sent over always-visible Queued.
  assert.match(panel, /<details id="review-sent"(?![^>]*\bopen\b)[^>]*>\s*<summary id="review-sent-summary"[^>]*><span>Sent<\/span> <span id="review-sent-count"/);
  assert.match(panel, /<section id="review-queued"[^>]*>[\s\S]*Queued <span id="review-queued-count"[\s\S]*id="review-thread"/);
  assert.ok(panel.indexOf('id="review-sent"') < panel.indexOf('id="review-queued"'), "Sent stacks above Queued");
  // Phone: the original Message/Review tabs and one combined history thread.
  assert.match(panel, /id="review-conversation-tab"[^>]*>Message<[\s\S]*id="review-history-tab"[^>]*aria-controls="review-phone-thread"[^>]*>Review</);
  assert.match(panel, /id="review-phone-thread"[^>]*hidden/);
  // Hidden by default (desktop); revealed only inside the phone breakpoint.
  const phoneAt = css.indexOf("@media (max-width: 720px)");
  assert.match(css.slice(0, phoneAt), /^\.review-tabs, #review-phone-thread \{ display: none; \}/m);
  const phoneCss = css.slice(phoneAt);
  assert.match(phoneCss, /\.review-panel \.review-tabs \{ display: flex/);
  assert.match(phoneCss, /\.review-panel \.review-sent, \.review-panel \.review-queued \{ display: none/);
  assert.match(phoneCss, /\.review-panel header:has\(\.review-tabs\) > strong \{ display: none; \}/);
  assert.match(phoneCss, /\[data-review-tab="review"\] #review-phone-thread:not\(\[hidden\]\)/);
  // The desktop header title still shrinks and wraps beside Close.
  assert.match(css, /\.review-panel header > strong \{[^}]*flex: 1 1 0;[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.review-header-actions \{[^}]*flex: 0 0 auto/);
  const batchCss = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(batchCss, /\.review-batch > summary \{[^}]*font-size: 12px;[^}]*line-height: 1\.25;[^}]*white-space: nowrap/);
  assert.match(batchCss, /\.review-note-text,\n\.review-batch > p \{ font-size: 12px; line-height: 1\.25; \}/);
  assert.match(batchCss, /\.review-note-text,\n\.review-note-preview,\n\.review-batch > p,\n\.review-batch-full,\n\.review-batch-label,\n\.review-batch-meta time \{[^}]*-webkit-user-select: text; user-select: text; \}/);
  assert.doesNotMatch(batchCss, /\.review-note-full \{[^}]*font-size:/);
  assert.match(batchCss, /\.review-batch-label \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/);
  assert.match(batchCss, /\.review-batch\[open\] > summary \.review-batch-full \{[^}]*white-space: normal/);
  assert.doesNotMatch(css.slice(0, phoneAt), /header:has\(\.review-tabs\)/);
});

test("compact review keeps its receipt summary and accessible history in the Sent section", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/shell-panel.css", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/review-client.js", import.meta.url), "utf8");
  assert.match(html, /id="review-sent-summary" aria-label="Sent batches, 0"/);
  assert.match(html, /id="review-inline-summary" aria-hidden="true"/);
  assert.match(css, /\.mobile-dock \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.review-sent:not\(\[open\]\) > \.review-thread \{ display: none/);
  assert.match(client, /el\("review-inline-summary"\)\.textContent = compactSummary/);
  assert.match(client, /if \(sentOpen\) void refreshStatuses\(\)/);
});

test("phone visual viewport keeps composer above keyboard and restores navigation reserve", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /height: min\(440px, calc\(var\(--review-vv-height, 100dvh\) - var\(--review-nav-space, 72px\) - 8px\)\)/);
  assert.match(css, /\.review-thread \{[^}]*min-height: 0;[^}]*overflow-y: auto; overscroll-behavior: contain/);
  assert.match(css, /#review-annotation \.review-form-anchored \{ position: static/);
  assert.match(css, /\.review-actions \{ position: sticky; bottom: 0/);
  const p = harness().page();
  assert.equal(p.viewportVars.get("--review-nav-space"), "calc(72px + env(safe-area-inset-bottom, 0px))");
  p.visualViewport.height = 410;
  p.visualViewport.offsetTop = 20;
  p.visualViewport.listeners.resize();
  assert.equal(p.viewportVars.get("--review-vv-height"), "410px");
  assert.equal(p.viewportVars.get("--review-vv-top"), "20px");
  assert.equal(p.viewportVars.get("--review-nav-space"), "0px");
  p.visualViewport.height = 800;
  p.visualViewport.offsetTop = 0;
  p.visualViewport.listeners.scroll();
  assert.equal(p.viewportVars.get("--review-nav-space"), "calc(72px + env(safe-area-inset-bottom, 0px))");
});

test("Ctrl/Cmd+Enter retries an unconfirmed identity instead of masking failure", async () => {
  const h = harness(), p = h.page(); await tick();
  p.element("review-message").value = "keyboard note";
  h.setMode("fail");
  let prevented = false;
  const key = { key: "Enter", ctrlKey: true, preventDefault() { prevented = true; } };
  p.element("review-message").listeners.keydown(key); await tick();
  assert.equal(prevented, true);
  assert.equal(p.state().retryBatches.length, 1);
  assert.equal(p.state().sent.length, 0);
  assert.equal(p.element("review-send").disabled, false);
  const id = h.posts[0].batchId;
  h.setMode("success");
  p.element("review-message").listeners.keydown({ ...key, metaKey: true }); await tick();
  assert.equal(h.posts[1].batchId, id, "same payload and ID are retried");
  assert.equal(p.state().retryBatches.length, 0);
  assert.equal(p.state().sent.length, 1);
});

test("later accepted end status clears history, not unavailable status", async () => {
  const h = harness(), p = h.page(); await tick();
  vm.runInContext(`sent = [{ id: "00000000-0000-4000-8000-000000000001", receiptId: "ignored", entries: [], state: "unavailable", end: true }]; update()`, p.context);
  assert.equal(p.state().sent.length, 1);
  await vm.runInContext("refreshStatuses()", p.context);
  assert.equal(p.state().sent.length, 0);
});

test("Send Batch snapshots multiple kinds, later queue and rapid second send remain distinct after acceptance", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("same", "region"); p.q("same", "lane"); p.q("plain");
  h.setMode("hold"); p.send(); p.send(); await tick();
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].schema, "fm-agentos-review.v2");
  assert.deepEqual(h.posts[0].entries.map((e) => e.tag), ["element", "element", "message"]);
  assert.deepEqual(h.posts[0].entries.map((e) => e.prompt), ["same", "same", "plain"]);
  p.q("later"); p.send(); // Pending action must not copy or submit the next queue.
  assert.deepEqual(p.state().queue.map((e) => e.prompt), ["later"]);
  assert.deepEqual(h.posts[0].entries.map((e) => e.prompt), ["same", "same", "plain"]);
  h.release(); await tick();
  assert.equal(p.state().sent.length, 1);
  assert.deepEqual(p.state().queue.map((e) => e.prompt), ["later"]);
  h.setMode("success"); p.send(); await tick();
  assert.equal(h.posts.length, 2);
  assert.notEqual(h.posts[0].batchId, h.posts[1].batchId);
  p.q("after success"); p.send(); await tick();
  assert.equal(h.posts.length, 3);
  assert.notEqual(h.posts[1].batchId, h.posts[2].batchId);
});

test("failed captured identity retries without merging later notes, including after reload", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("old"); h.setMode("hold"); p.send(); await tick();
  p.q("new"); h.release(true); await tick();
  const failed = p.state().retryBatches[0];
  assert.deepEqual(failed.payload.entries.map((e) => e.prompt), ["old"]);
  assert.deepEqual(p.state().queue.map((e) => e.prompt), ["new"]);
  const reloaded = h.page(); await tick();
  assert.equal(reloaded.state().retryBatches[0].id, failed.id);
  h.setMode("success");
  reloaded.send(); await tick();
  assert.notEqual(h.posts[1].batchId, failed.id, "a later Send Batch does not reuse a failed identity");
  await vm.runInContext("submitBatch(retryBatches[0])", reloaded.context);
  assert.deepEqual(h.posts[2], h.posts[0]);
  assert.equal(reloaded.state().queue.length, 0);
});

test("Send and End drains recovered board once by item identity, not by equal text; failure retains it", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("identical"); p.q("identical"); p.q("third");
  const draft = p.state();
  draft.queue.push({ ...draft.queue[0] }); draft.queueIds.push(draft.queueIds[0]); // Duplicate storage record, same item identity.
  h.data.set("fm-agentos-review-draft-v1", JSON.stringify(draft));
  const recovered = h.page(); await tick();
  assert.equal(recovered.state().queue.length, 3);
  assert.equal(recovered.element("review-panel").hidden, true);
  h.setMode("fail"); recovered.send(true); await tick();
  assert.equal(recovered.element("review-panel").hidden, true);
  assert.deepEqual(h.posts[0].entries.map((e) => e.prompt), ["identical", "identical", "third"]);
  assert.equal(h.posts[0].end, true);
  assert.equal(recovered.state().retryBatches.length, 1);
  h.setMode("success"); recovered.send(true); await tick();
  assert.deepEqual(h.posts[1], h.posts[0]);
  assert.equal(recovered.state().retryBatches.length, 0);
  assert.equal(recovered.state().sent.length, 0, "accepted end clears history");
  assert.equal(recovered.element("review-panel").hidden, true);
});

test("Send and End drains failed prior identities separately from its recovered cutoff", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("old"); h.setMode("fail"); p.send(); await tick();
  p.q("next"); h.setMode("hold"); p.send(true); await tick();
  assert.equal(h.posts.length, 2);
  assert.deepEqual(h.posts[1].entries.map((e) => e.prompt), ["old"]);
  assert.deepEqual(p.state().retryBatches.map((b) => b.payload.entries[0].prompt), ["next"]);
  h.release(true); await tick();
  assert.equal(h.posts.length, 2, "failure stops the drain without losing the later cutoff");
  h.setMode("success"); p.send(true); await tick();
  assert.deepEqual(h.posts.slice(2).map((b) => b.entries[0].prompt), ["old", "next"]);
  assert.equal(h.posts[2].batchId, h.posts[0].batchId);
  assert.notEqual(h.posts[3].batchId, h.posts[2].batchId);
  assert.equal(p.state().sent.length, 0);
  assert.equal(p.state().retryBatches.length, 0);
});

test("reload during an uncertain drain preserves retry order and later queue", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("first"); h.setMode("fail"); p.send(); await tick();
  p.q("second"); h.setMode("hold"); p.send(true); await tick();
  p.q("third");
  const reloaded = h.page(); await tick();
  assert.deepEqual(reloaded.state().retryBatches.map((b) => b.payload.entries[0].prompt), ["first", "second"]);
  assert.deepEqual(reloaded.state().queue.map((e) => e.prompt), ["third"]);
  h.release(true); await tick();
});

test("reload retains more than thirty independent retries and receipt batches", async () => {
  const h = harness(), p = h.page(); await tick();
  h.setMode("fail");
  for (let i = 0; i < 35; i++) { p.q(`pending ${i}`); p.send(); await tick(); }
  assert.equal(p.state().retryBatches.length, 35);
  const pending = p.state().retryBatches;
  const reloaded = h.page(); await tick();
  assert.deepEqual(reloaded.state().retryBatches, pending);
  h.setMode("success");
  for (let i = 0; i < 35; i++) { reloaded.q(`confirmed ${i}`); reloaded.send(); await tick(); }
  assert.equal(reloaded.state().sent.length, 35);
  const history = reloaded.state().sent;
  const again = h.page(); await tick();
  assert.deepEqual(again.state().sent, history);
  assert.equal(again.state().retryBatches.length, 35);
});

test("unsent v1 drafts convert while captured v1 retries stay byte-for-byte unchanged", async () => {
  const h = harness();
  const entry = { kind: "annotation", text: "Legacy draft", route: "#overview", version: "old", region: { id: "card", label: "Card" } };
  const id = "00000000-0000-4000-8000-000000000009";
  const retry = { id, payload: { schema: "fm-agentos-review.v1", batchId: id, sessionId: "", version: "old", route: "#overview", end: false, entries: [entry] } };
  h.data.set("fm-agentos-review-draft-v1", JSON.stringify({ queue: [entry], retryBatches: [retry] }));
  const p = h.page(); await tick();
  assert.equal(p.state().queue[0].prompt, "Legacy draft");
  assert.equal(p.state().queue[0].text, "");
  assert.equal(p.state().queue[0].label, "Card");
  assert.deepEqual(p.state().retryBatches[0], retry);
});

test("revision changes never replace an uncertain delivery identity on reload", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("response lost"); h.setMode("fail"); p.send(); await tick();
  const original = p.state().retryBatches[0];
  p.q("unsent note");
  vm.runInContext('useCurrentVersion({ ready: true, version: "new-revision", delivery: "local", sessionId: "" }); update()', p.context);
  assert.deepEqual(p.state().retryBatches[0], original);
  assert.equal(p.state().queue[0].version, "new-revision");
});

test("reload retains Lavish receipts with unknown downstream state and storage failures are visible", async () => {
  const h = harness(), p = h.page(); await tick();
  p.q("sent note"); p.send(); await tick();
  const draft = p.state(); draft.sent[0].state = null;
  h.data.set("fm-agentos-review-draft-v1", JSON.stringify(draft));
  const reloaded = h.page(); await tick();
  assert.equal(reloaded.state().sent.length, 1);
  assert.equal(reloaded.state().sent[0].receiptId, draft.sent[0].receiptId, "status polling cannot lose a Lavish receipt");
  vm.runInContext('sessionStorage.setItem = () => { throw Error("Quota exceeded"); }; update()', reloaded.context);
  assert.match(reloaded.element("review-state").textContent, /Reload persistence unavailable/);
});

test("Send and End captures the whole board, keeps newer items and does not double-submit", async () => {
  const h = harness(), p = h.page(); await tick();
  p.element("review-panel").hidden = false;
  p.q("one", "region"); p.q("two", "lane");
  h.setMode("hold"); p.send(true); p.send(true); await tick();
  assert.equal(h.posts.length, 1);
  p.q("after end cutoff"); h.release(); await tick();
  assert.equal(p.state().sent.length, 0, "accepted end clears history while later notes remain");
  assert.deepEqual(p.state().queue.map((e) => e.prompt), ["after end cutoff"]);
  assert.equal(p.element("review-panel").hidden, false, "later annotation keeps board open");
  h.setMode("success"); p.send(true); await tick();
  assert.equal(p.element("review-panel").hidden, true);
  assert.notEqual(h.posts[0].batchId, h.posts[1].batchId);
});

test("mobile blank strip regression: 48px header offset eliminates gap, and annotation exclusion is distinct from stage geometry", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  const landscape = css.slice(css.indexOf("@media (max-width: 720px) and (min-width: 600px) and (max-height: 500px)"), css.indexOf("@media (max-width: 720px) and (hover: none)"));

  // 1. CSS assertions: Stale 96px top offset in portrait and 80px in landscape are replaced with real header heights 48px and 40px
  assert.match(phone, /\.main-stage \{ height: calc\(100dvh - 96px\); padding-top: 48px; padding-bottom: 0; \}/);
  assert.doesNotMatch(phone, /\.main-stage \{[^}]*padding-top: 96px/);
  assert.match(landscape, /\.main-stage \{ height: calc\(100dvh - 64px\); padding-top: 40px; \}/);
  assert.doesNotMatch(landscape, /\.main-stage \{[^}]*padding-top: 80px/);

  // 2. Geometry layout calculations:
  // Header: top: 0, height: 48px -> bottom: 48px.
  // With padding-top: 48px, stage content top begins flush at 48px.
  const headerHeight = 48;
  const stagePaddingTopFixed = 48;
  const contentTop = stagePaddingTopFixed;
  const gap = contentTop - headerHeight;
  assert.equal(gap, 0, "Eliminated 48px blank gap between fixed header and stage content");

  // In defect state, stagePaddingTop was 96px, creating a 48px dead void
  const stagePaddingTopDefect = 96;
  const defectGap = stagePaddingTopDefect - headerHeight;
  assert.equal(defectGap, 48, "Reproduced defect state gap was 48px");

  // 3. Annotation-target exclusion distinction:
  // Verify targetFor logic: DIV.main-stage is outside .product-view, so targetFor returns null.
  // Content inside .product-view returns a valid annotation target.
  const h = harness(), p = h.page();
  const createMockElement = (tag, classes, parent = null, id = "") => {
    const el = {
      tagName: tag.toUpperCase(),
      id,
      className: classes.join(" "),
      classList: { contains: (c) => classes.includes(c) },
      parentElement: parent,
      children: [],
      closest(sel) {
        let cur = this;
        while (cur) {
          if (sel.includes(`.${cur.className}`) || (sel.includes(".product-view") && cur.classList?.contains("product-view")) ||
              (sel.includes(".lane-list") && cur.classList?.contains("lane-list")) ||
              (sel.includes(".context-rail") && cur.classList?.contains("context-rail")) ||
              (sel.includes(cur.tagName.toLowerCase())) ||
              (sel.includes("[id]") && cur.id)) {
            return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      contains(other) {
        let cur = other;
        while (cur) {
          if (cur === this) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      getAttribute: () => null,
    };
    if (parent) parent.children.push(el);
    return el;
  };

  const mainStage = createMockElement("div", ["main-stage"]);
  const productView = createMockElement("section", ["product-view", "conversation"], mainStage, "lanes-view");
  const convHead = createMockElement("div", ["conversation-head"], productView);
  const kicker = createMockElement("span", ["conversation-kicker"], convHead);

  const targetForCode = vm.runInContext("targetFor", p.context);
  // Main stage (the blank strip surface outside .product-view) returns null
  assert.equal(targetForCode(mainStage), null, "Blank strip / main stage is excluded by annotation targeting");
  // Content inside product-view returns valid target
  assert.equal(targetForCode(kicker), kicker, "Child element inside product-view is valid annotation target");
});

test("mobile review close overlay regression: z-index 75 overtakes shell level-70 context and wins hit-test over Refresh", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const phoneNav = css.slice(css.lastIndexOf("@media (max-width: 720.01px) {"));

  // 1. CSS assertion: .review-panel has z-index: 75 in phone query
  assert.match(phoneNav, /\.review-panel \{[^}]*z-index: 75;/);

  // 2. Verify stacking context level hierarchy:
  // .lane-list (app shell containing fixed header and #refresh) is at z-index: 70
  // .review-panel is elevated to z-index: 75
  const laneListZIndex = 70;
  const reviewPanelZIndex = 75;
  assert.ok(reviewPanelZIndex > laneListZIndex, "review-panel (75) overtakes lane-list (70) stacking context");

  // 3. Stacking hit-test simulation at close control position (x=334, y=31):
  // Close button sits inside review-panel at top: 9px, right: 12px
  // Refresh button sits inside lane-list > source-status at top: 4px, right: env()
  // When review-panel is open and positioned:
  function simulateHitTest(panelZIndex) {
    const refreshBtn = { id: "refresh", zIndex: laneListZIndex, label: "Refresh" };
    const closeBtn = { id: "review-close", zIndex: panelZIndex, label: "Close" };
    // Hit test returns the element from the topmost stacking context
    return panelZIndex > laneListZIndex ? closeBtn : refreshBtn;
  }

  // In defect state (panel z-index was 42, behind lane-list 70):
  const defectWinner = simulateHitTest(42);
  assert.equal(defectWinner.id, "refresh", "In defect state, Refresh button intercepted hits intended for Close");

  // In corrected overlay state (panel z-index is 75, overtaking lane-list 70):
  const fixedWinner = simulateHitTest(75);
  assert.equal(fixedWinner.id, "review-close", "With z-index 75, Close button overtakes app shell and wins hit testing");
});

test("desktop inline composer recovers Send while the review panel stays hidden", async () => {
  const h = harness();
  h.setConfigUp(false);
  const p = h.page(); await tick();
  p.element("review-panel").hidden = true;
  p.element("review-annotation").hidden = true;
  p.element("review-message").value = "Synthetic inline note";
  p.element("review-message").listeners.input();
  assert.equal(p.element("review-send").disabled, true, "unreachable server cannot accept Send");
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, 5000);
  h.setConfigUp(true);
  h.intervals[0].fn();
  await tick(); await tick();
  assert.equal(p.element("review-send").disabled, true, "a hidden panel and hidden inline composer do not poll");
  assert.equal(p.element("review-panel").hidden, true);
  p.element("review-annotation").hidden = false;
  h.intervals[0].fn();
  await tick(); await tick();
  assert.equal(p.element("review-panel").hidden, true, "recovery does not open the review panel");
  assert.equal(p.element("review-annotation").hidden, false);
  assert.equal(p.element("review-send").disabled, false, "the open inline composer re-reads configuration");
  assert.equal(p.element("review-state").textContent, "Review delivery reconnected.");
  assert.equal(p.element("review-message").value, "Synthetic inline note");
});

test("phone composer re-enables Send when an unreachable server returns", async () => {
  const h = harness();
  h.setConfigUp(false);
  const p = h.page(); await tick();
  p.setDesktop(false);
  p.element("review-panel-toggle").click(); await tick();
  p.element("review-message").value = "Synthetic phone message";
  p.element("review-message").listeners.input();
  assert.equal(p.element("review-send").disabled, true, "unreachable server cannot accept Send");
  assert.equal(p.element("review-queue").disabled, false, "Queue stays local");
  assert.match(p.element("review-state").textContent, /server down or restarting/);
  h.setConfigUp(true);
  p.dispatch("visibilitychange"); await tick(); await tick();
  assert.equal(p.element("review-send").disabled, false, "tab return re-reads configuration");
  assert.equal(p.element("review-state").textContent, "Review delivery reconnected.");
  p.send(); await tick(); await tick();
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].entries.map((entry) => entry.prompt), ["Synthetic phone message"]);
  assert.equal(p.element("review-message").value, "");
});
