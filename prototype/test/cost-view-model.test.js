import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL("../public/cost-view-model.js", import.meta.url), "utf8"), context);
const project = context.window.costViewModel.project;
test("billing cards preserve unavailable, unknown, partial, actual and stale labels", () => {
  const [azure, github] = project({ azure: { state: "actual", actual: { amount: 0, currency: "USD" }, capturedAt: "2026-09-27T12:00:00Z", period: { start: "2026-09-01", end: "2026-09-27", basis: "Month to date (UTC); billing cycle unknown" }, attribution: { unclassified: { amount: 0, currency: "USD" } } }, github: { state: "stale", stale: true, reason: "GitHub billing access required", actual: { minutes: null }, partial: true } });
  assert.equal(azure.rows.find(([key]) => key === "Actual cost")[1], "0 USD");
  assert.match(azure.rows.find(([key]) => key === "Forecast")[1], /Unknown/);
  assert.equal(azure.period.start, "2026-09-01");
  assert.equal(github.rows.find(([key]) => key === "Consumed minutes (reported)")[1], "Unknown");
  assert.equal(github.stale, true);
  assert.match(project({})[0].rows[0][1], /Unknown/);
});
