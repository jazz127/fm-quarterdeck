import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto, createHash } from "node:crypto";
import vm from "node:vm";

const script = await readFile(new URL("../public/review-target.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(script, { window, crypto: webcrypto, TextEncoder, Uint8Array });
const helpers = window.QuarterdeckReviewTarget;
class Element {
  constructor(tag, parent = null, attrs = {}, text = "") {
    this.tagName = tag.toUpperCase(); this.nodeType = 1; this.parentElement = this.parentNode = parent; this.children = []; this.childNodes = this.children; this.attrs = attrs; this.textContent = text; this.id = attrs.id || "";
    parent?.children.push(this);
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  matches(selector) { return selector.split(/,\s*/).some((part) => part.startsWith(".") ? this.attrs.class === part.slice(1) : part === "[data-review-id]" ? this.attrs["data-review-id"] : part === this.tagName.toLowerCase()); }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { return this.children.flatMap((node) => [...(node.matches?.(selector) ? [node] : []), ...(node.querySelectorAll?.(selector) || [])]); }
}

test("selectors stop at review anchors/body and nth-of-type counts only the same tag", () => {
  const root = new Element("main", null, { class: "product-view", "data-review-id": "card" });
  const p = new Element("p", root); new Element("span", root); const second = new Element("p", root);
  assert.equal(helpers.cssSelector(second), '[data-review-id="card"] > p:nth-of-type(2)');
  assert.equal(helpers.cssSelector(p), '[data-review-id="card"] > p:nth-of-type(1)');
  const body = new Element("div", root, { class: "message-content" }); const list = new Element("ul", body);
  new Element("li", list); new Element("li", list); const li = new Element("li", list);
  assert.equal(helpers.cssSelector(li), ".message-content > ul > li:nth-of-type(3)");
});

test("text range uses node paths, true offsets and quote prefix/suffix", () => {
  const root = new Element("main", null, { class: "product-view" });
  const body = new Element("div", root, { class: "message-content" });
  const p = new Element("p", body, {}, "Merged the build fix; CI is green on main.");
  const textNode = { nodeType: 3, parentElement: p, parentNode: p }; p.childNodes.push(textNode);
  const range = { collapsed: false, commonAncestorContainer: textNode, startContainer: textNode, endContainer: textNode, startOffset: 22, endOffset: 33,
    cloneRange() { let start = 0, end = p.textContent.length; return { selectNodeContents() {}, setEnd(_, offset) { end = offset; }, setStart(_, offset) { start = offset; }, toString() { return p.textContent.slice(start, end); } }; } };
  const context = helpers.textRangeTarget({ rangeCount: 1, getRangeAt: () => range, toString: () => "CI is green" });
  assert.equal(context.tag, "text");
  assert.equal(context.target.prefix, "Merged the build fix; ");
  assert.equal(context.target.suffix, " on main.");
  // The supplied spec's example offsets are 22/33; boundaries must preserve them exactly.
  assert.equal(context.target.start.offset, 22); assert.equal(context.target.end.offset, 33);
  assert.deepEqual(Array.from(context.target.start.path), [0]);
  assert.equal(helpers.textRangeTarget({ rangeCount: 0 }), null);
});

test("table labels match the grid and ambiguous rowspans don't guess labels", () => {
  const table = new Element("table"); const head = new Element("thead", table); const header = new Element("tr", head);
  new Element("th", header, {}, "Fleet"); new Element("th", header, {}, "State");
  const body = new Element("tbody", table); const row = new Element("tr", body);
  const first = new Element("td", row, {}, "demo"); const cell = new Element("td", row, {}, "working");
  assert.equal(helpers.tableCellTarget(cell).rowLabel, "demo");
  assert.equal(helpers.tableCellTarget(cell).columnLabel, "State");
  first.attrs.rowspan = "2";
  const next = new Element("tr", body); const shifted = new Element("td", next, {}, "blocked");
  assert.equal(helpers.tableCellTarget(shifted).columnLabel, "");
  assert.equal(helpers.tableCellTarget(shifted).rowLabel, "");
});

test("no-ID fingerprint is SHA-256 prefix; unsent migration never keeps the whole quote", async () => {
  const text = "status ".repeat(1000);
  assert.equal(await helpers.recordFingerprint(text), createHash("sha256").update(text).digest("hex").slice(0, 16));
  const migrated = helpers.migrateEntry({ kind: "lane-message-annotation", text: "Fix", target: { type: "quote", text, time: "12:00", lanes: ["demo"] }, route: "#lanes", version: "old" });
  for (let i = 0; i < 100 && !migrated.record.sha256; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(migrated.prompt, "Fix"); assert.equal(migrated.text.length, 240);
  assert.equal(migrated.record.sha256.length, 16);
  assert.ok(JSON.stringify(migrated).length < 1000);
});
