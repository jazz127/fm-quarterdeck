import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadExpenses, createServer } from "../server.js";
import { createConfiguredCostReader } from "../costs.js";
import { migratePrivateExpenses } from "../private-migration.js";
import { verifyPreservedExpenses } from "../private-verification.js";
import { defaultCostConfiguration } from "../cost-config.js";

const empty = { version: 1, default_currency: "USD", entries: [] };
const revisionResolver = { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) };

test("public source is empty, neutral and does not discover a home", async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL("../../expenses/ledger.json", import.meta.url))), empty);
  const expenses = await loadExpenses({ HOME: "/must/not/be/read", FM_COST_ATTRIBUTION_TAG: "cost-center" });
  assert.equal(expenses.demo, false);
  for (const key of ["entries", "categories", "projects"]) assert.deepEqual(expenses[key], []);
  assert.deepEqual(expenses.overall, [{ currency: "USD", amount: "0.00" }]);
  assert.deepEqual(defaultCostConfiguration({}).attribution, {});
  const costs = await createConfiguredCostReader({}, { run: async () => { throw new Error("Synthetic offline refusal"); } })();
  assert.deepEqual(costs.azure.attribution, { unclassified: null });
});

test("fresh synthetic homes use public defaults; nested source can initialize separate private data without a saved home pointer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-public-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["one", "two"]) {
    const home = path.join(root, name);
    const sourceRoot = path.join(home, "projects", "fm-quarterdeck");
    await mkdir(path.join(sourceRoot, "expenses"), { recursive: true });
    await mkdir(path.join(home, "data"));
    await mkdir(path.join(home, "state"));
    await writeFile(path.join(home, "data/projects.md"), "- Example Store - Synthetic project\n");
    await writeFile(path.join(sourceRoot, "expenses/ledger.json"), JSON.stringify(empty));
    const env = { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(root, `${name}-state.json`) };
    assert.equal((await loadExpenses(env)).entryCount, 0);
    await migratePrivateExpenses({ sourceRoot, env, mode: "copy" });
    assert.deepEqual((await verifyPreservedExpenses(env)).ledger, empty);
    assert.deepEqual((await verifyPreservedExpenses(env)).costs.attribution, {});
    assert.deepEqual((await readdir(home)).sort(), ["data", "projects", "state"]);
    assert.deepEqual((await readdir(path.join(home, "data"))).sort(), ["agentos", "projects.md"]);
    const server = createServer(env, { revisionResolver, costReader: async () => ({}), quotaReader: async () => ({}) });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.expenses.entryCount, 0);
      assert.equal(data.expenses.source, "private overlay (selected FM_HOME)");
    } finally { await new Promise((resolve) => server.close(resolve)); }
    assert.throws(() => createServer({ ...env, FM_QUARTERDECK_STATE_PATH: path.join(home, "data/unsafe-state.json") }, { revisionResolver }), /outside FM_HOME/);
  }
});

test("injected expense reader does not change production fallback or revision guards", async (t) => {
  let available = true;
  const server = createServer({}, { expenseReader: async () => ({ synthetic: true }), revisionResolver: { initial: revisionResolver.initial, snapshot: async () => available ? revisionResolver.initial : null } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/dashboard`;
  assert.deepEqual((await (await fetch(url)).json()).expenses, { synthetic: true });
  available = false;
  assert.equal((await fetch(url)).status, 503);
});
