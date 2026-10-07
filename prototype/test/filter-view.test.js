import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const code = await readFile(new URL("../public/filter-view.js", import.meta.url), "utf8");
const bulk = await readFile(new URL("../public/bulk-controls.js", import.meta.url), "utf8");

function load() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(bulk, context);
  vm.runInContext(code, context);
  return context.window;
}

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const stateLabel = (state) => String(state).replaceAll("-", " ");

test("filter-view builds kind and lane markup and collapsed rail", () => {
  const { filterView: view } = load();
  const types = [
    { id: "captain", label: "captain", icon: "captain", svg: '<svg class="message-kind-svg"></svg>' },
    { id: "conversation", label: "Firstmate replies", icon: "conversation", svg: '<svg class="message-kind-svg"></svg>' },
  ];
  const kindHtml = view.kindFiltersHtml(types, new Set(["captain"]), escapeHtml);
  assert.match(kindHtml, /value="captain"[^>]*checked/);
  assert.doesNotMatch(kindHtml, /value="conversation"[^>]*checked/);
  assert.match(kindHtml, /message-kind-glyph[\s\S]*message-kind-svg/);
  assert.match(kindHtml, /aria-label="Previous captain message"/);
  assert.match(kindHtml, /aria-label="Next Firstmate reply message"/);
  assert.equal((kindHtml.match(/class="kind-message-jump"/g)||[]).length,4);
  assert.match(kindHtml, /<\/label><div class="kind-message-jumps"/,'arrows are outside checkbox labels');
  assert.match(kindHtml, /data-kind-step="-1"[^>]*disabled/);
  const escaped=view.kindFiltersHtml([{id:'"unsafe',label:'<unsafe>'}],new Set(),escapeHtml);
  assert.match(escaped,/data-kind-jump="&quot;unsafe"/);
  assert.doesNotMatch(escaped,/<unsafe>/);

  assert.equal(view.laneShortName("Quarterdeck"), "Quar");
  assert.equal(view.laneShortName(""), "?");
  const laneHtml = view.laneOptionHtml({ id: "general", name: "General", status: "active" }, true, escapeHtml, stateLabel);
  assert.match(laneHtml, /data-lane-id="general"/);
  assert.match(laneHtml, /is-selected/);
  assert.match(laneHtml, /Pinned/);

  const rail = view.collapsedRailHtml(
    [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta Lane" }],
    new Set(["alpha"]),
    escapeHtml,
  );
  assert.match(rail, /data-lane-id="alpha"[^>]*aria-pressed="true"/);
  assert.match(rail, /data-lane-id="beta"[^>]*aria-pressed="false"/);
  assert.match(rail, />Alpha</);
  assert.match(rail, />Beta Lane</);
  assert.equal(view.laneRailLabel("a-very-long-lane-name"), "a-very-long-l\u2026");
});

test("filter-view kind bulk toggle labels follow Select all/Clear lock", () => {
  const { filterView: view, bulkControls } = load();
  const toggle = { disabled: false, dataset: {}, textContent: "", setAttribute() {} };
  view.syncKindsBulk({
    types: [{ id: "a" }, { id: "b" }],
    selectedIds: new Set(["a"]),
    syncBulk: bulkControls.sync,
    nodes: { toggle },
  });
  assert.equal(toggle.dataset.mode, "select");
  assert.equal(toggle.textContent, "Select all");
  view.syncKindsBulk({
    types: [{ id: "a" }, { id: "b" }],
    selectedIds: new Set(["a", "b"]),
    syncBulk: bulkControls.sync,
    nodes: { toggle },
  });
  assert.equal(toggle.dataset.mode, "clear");
  assert.equal(toggle.textContent, "Clear");
});
