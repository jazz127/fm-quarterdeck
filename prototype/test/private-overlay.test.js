import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink, link, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import vm from "node:vm";
import { migratePrivateExpenses } from "../private-migration.js";
import { verifyPreservedExpenses } from "../private-verification.js";
import { readExpenseOverlay, validateExpenseLedger } from "../private-runtime.js";
import { defaultCostConfiguration, validateCostConfiguration } from "../cost-config.js";
import { createConfiguredCostReader, parseAzure } from "../costs.js";
import { loadExpenses, rollupLedger, createServer } from "../server.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const ledger = { version: 1, default_currency: "USD", entries: [
  { id: "sample-1", date: "2025-01-01", amount: "12.50", project_id: "example", project_name: "Example Store", note: "Synthetic usage", category: "AI services", confidence: "estimate" },
  { id: "sample-2", date: "2025-01-02", amount: "-2.50", project_id: "example", note: "Synthetic credit" },
  { id: "sample-3", date: "2025-01-03", amount: "0.00", project_id: "unknown", note: "Synthetic rate unknown/TBD", currency: "EUR" },
  { id: "sample-4", date: "2025-01-04", amount: "10000000000000000000000000000.01", project_id: "large", note: "[estimate] Synthetic model usage precision check" },
] };
const config = { schema: "fm-agentos-costs.v1", azureTag: "cost-center", attribution: { example: "Example Store", shared: "Shared costs", corporate: "Shared costs" } };
const stamp = "2026-01-10T00:00:00.000Z";
const table = (rows, dimension) => ({ properties: { columns: [{ name: "Cost" }, { name: "Currency" }, ...(dimension ? [{ name: dimension }] : [])], rows } });
const envWithoutHome = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !["FM_HOME", "FM_COST_ATTRIBUTION_TAG"].includes(key)));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-overlay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"); const home = path.join(root, "home");
  await mkdir(path.join(sourceRoot, "expenses"), { recursive: true }); await mkdir(home);
  const source = path.join(sourceRoot, "expenses", "ledger.json");
  const bytes = Buffer.from(JSON.stringify(ledger, null, 4) + "\n");
  await writeFile(source, bytes);
  return { root, home, sourceRoot, source, bytes, directory: path.join(home, "data", "agentos", "expenses"), env: { FM_HOME: home, FM_COST_ATTRIBUTION_TAG: "cost-center" } };
}
const copy = (f, options = {}) => migratePrivateExpenses({ sourceRoot: f.sourceRoot, env: f.env, mode: "copy", ...options });
const verify = (f, options = {}) => migratePrivateExpenses({ sourceRoot: f.sourceRoot, env: f.env, mode: "verify", ...options });
const projectView = async (data) => {
  const sandbox = { window: {} }; vm.createContext(sandbox);
  vm.runInContext(await readFile(path.join(repo, "prototype/public/cost-view-model.js"), "utf8"), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.costViewModel.project(data)));
};

test("copy is byte-preserving, private, idempotent and privately manifested; verify never writes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(verify(f));
  assert.deepEqual(await readdir(f.home), []);
  await copy(f);
  const destination = path.join(f.directory, "ledger.json");
  const before = await stat(destination);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.deepEqual(await readFile(destination), f.bytes);
  const manifest = JSON.parse(await readFile(path.join(f.directory, "migration-manifest.json")));
  assert.deepEqual(manifest.files.map((row) => [row.sourceCategory, row.destination]), [["repository-expense-ledger", "expenses/ledger.json"], ["runtime-cost-configuration", "expenses/costs.json"]]);
  assert.equal(manifest.files[0].sha256, createHash("sha256").update(f.bytes).digest("hex"));
  assert.doesNotMatch(JSON.stringify(manifest), /Synthetic|Example Store|cost-center|12\.50/);
  assert.equal(JSON.stringify(manifest).includes(f.root), false);
  await copy(f); await verify(f);
  assert.deepEqual(await verifyPreservedExpenses(f.env), await readExpenseOverlay(f.env));
  assert.equal((await stat(destination)).ino, before.ino);
  assert.equal((await stat(destination)).mtimeMs, before.mtimeMs);
  if (process.platform !== "win32") {
    for (const name of ["ledger.json", "costs.json", "migration-manifest.json"]) assert.equal((await stat(path.join(f.directory, name))).mode & 0o777, 0o600);
    for (const dir of [path.dirname(f.directory), f.directory]) assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
});

test("missing overlay keeps canonical and demo fallback; explicit invalid/partial overlays do not", async (t) => {
  const f = await fixture(t);
  const demoPath = path.join(f.root, "demo.json"); await writeFile(demoPath, JSON.stringify({ ...ledger, entries: [] }));
  const options = { canonicalPath: f.source, demoPath };
  const baseline = await loadExpenses({}, options);
  assert.deepEqual(await loadExpenses(f.env, options), baseline);
  assert.equal((await loadExpenses(f.env, { canonicalPath: path.join(f.root, "missing"), demoPath })).demo, true);
  await copy(f);
  const reading = await loadExpenses(f.env, options);
  assert.deepEqual({ ...reading, source: baseline.source }, baseline);
  assert.deepEqual((await readExpenseOverlay(f.env)).ledger, ledger);
  await rm(path.join(f.directory, "costs.json"));
  assert.match((await loadExpenses(f.env, options)).error, /Private expense overlay/);
  assert.equal((await loadExpenses({ FM_HOME: "relative" }, options)).demo, false);
  assert.ok((await loadExpenses({ FM_HOME: "relative" }, options)).error);
});

test("copying current attribution preserves actual and unavailable browser semantics", async (t) => {
  const f = await fixture(t); await copy(f);
  const stored = (await readExpenseOverlay(f.env)).costs;
  assert.deepEqual(stored, defaultCostConfiguration(f.env));
  const tags = Object.keys(stored.attribution);
  const dimensions = { TagKey: table([...tags.map((tag) => [1, "USD", tag]), [2, "USD", "unknown-tag"]], stored.azureTag) };
  const actual = table([[tags.length + 2, "USD"]]);
  const baseline = parseAzure(actual, dimensions, stamp, stored.azureTag);
  const overlay = parseAzure(actual, dimensions, stamp, stored.azureTag, stored.attribution);
  assert.deepEqual(overlay, baseline);
  assert.deepEqual(await projectView({ azure: overlay }), await projectView({ azure: baseline }));
  const offline = { run: async () => { throw new Error("denied"); } };
  const denied = createConfiguredCostReader(f.env, offline);
  const legacyDenied = createConfiguredCostReader({}, offline);
  assert.deepEqual((await projectView(await denied()))[0].rows, (await projectView(await legacyDenied()))[0].rows);
});

test("custom mapping, combined labels, unknown totals, cache rebinding and null tag are authoritative", async (t) => {
  const f = await fixture(t); await copy(f, { costConfiguration: config });
  let calls = 0; const requestedTags = [];
  const run = async (bin, args) => {
    calls++;
    if (bin === "gh-axi") return { stdout: `api_response:\n  body: ${JSON.stringify(args[1] === "/user" ? "sample-user" : "")}\n  truncated: false\n` };
    if (args[0] === "account") return { stdout: JSON.stringify({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }) };
    const group = JSON.parse(args[args.indexOf("--body") + 1]).dataset.grouping?.[0];
    if (group?.type === "TagKey") { requestedTags.push(group.name); return { stdout: JSON.stringify(table([[3, "USD", "example"], [1, "USD", "shared"], [2, "USD", "corporate"], [4, "USD", "other"]], group.name)) }; }
    return { stdout: JSON.stringify(table([group ? [10, "USD", "Example"] : [10, "USD"]], group?.name)) };
  };
  const reader = createConfiguredCostReader({ ...f.env, FM_COST_ATTRIBUTION_TAG: "ignored-env-tag" }, { run, now: () => Date.parse(stamp) });
  const reading = await reader(); const count = calls;
  await reader(); assert.equal(calls, count);
  assert.deepEqual(requestedTags, ["cost-center"]);
  assert.equal(reading.azure.attribution["Example Store"].amount, 3);
  assert.equal(reading.azure.attribution["Shared costs"].amount, 3);
  assert.equal(reading.azure.attribution.unclassified.amount, 4);
  const view = await projectView(reading);
  assert.ok(view[0].rows.some(([name, amount]) => name === "Example Store actual" && amount === "3 USD"));
  await writeFile(path.join(f.directory, "costs.json"), JSON.stringify({ ...config, azureTag: null, attribution: {} }));
  const changed = await reader();
  assert.ok(calls > count); assert.deepEqual(requestedTags, ["cost-center"]);
  assert.deepEqual(changed.azure.attribution, { unclassified: { amount: 10, currency: "USD" } });
  await writeFile(path.join(f.directory, "costs.json"), '{"schema":"PRIVATE SENTINEL"}');
  const before = calls; const invalid = await reader();
  assert.equal(calls, before); assert.equal(invalid.azure.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE SENTINEL/);
});

test("server binds expense dashboard to selected home without leaking paths or manifest", async (t) => {
  const f = await fixture(t); await copy(f, { costConfiguration: config });
  await mkdir(path.join(f.home, "state"));
  await writeFile(path.join(f.home, "data", "projects.md"), "- Example - Synthetic project.\n");
  const server = createServer(f.env, { revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) }, costReader: createConfiguredCostReader(f.env, { run: async () => { throw new Error("offline"); } }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await (await fetch(`http://127.0.0.1:${server.address().port}/api/dashboard`)).json();
  assert.deepEqual(result.expenses, { ...rollupLedger(ledger), source: "private overlay (selected FM_HOME)", demo: false });
  assert.equal(JSON.stringify(result.expenses).includes(f.root), false);
  assert.doesNotMatch(JSON.stringify(result.expenses), /sha256|migration-manifest/);
  const costs = await (await fetch(`http://127.0.0.1:${server.address().port}/api/costs`)).json();
  assert.deepEqual(Object.keys(costs.azure.attribution), ["Example Store", "Shared costs", "unclassified"]);
});

for (const name of ["ledger.json", "costs.json", "migration-manifest.json"]) test(`conflicting ${name} is refused before any other files are created`, async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  const file = path.join(f.directory, name); await writeFile(file, "user-authored", { mode: 0o600 });
  await assert.rejects(copy(f));
  assert.deepEqual(await readdir(f.directory), [name]);
  assert.equal(await readFile(file, "utf8"), "user-authored");
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test("matching partial files can complete; edited destinations and stale manifests are never overwritten", async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(f.directory, "ledger.json"), f.bytes, { mode: 0o600 });
  await copy(f); await verify(f);
  await writeFile(path.join(f.directory, "ledger.json"), JSON.stringify({ ...ledger, entries: [] }));
  await assert.rejects(copy(f)); await assert.rejects(verify(f));
  await assert.rejects(verifyPreservedExpenses(f.env), /Preserved expense verification refused/);
  assert.deepEqual((await readExpenseOverlay(f.env)).ledger.entries, [], "manifest is copy evidence, not a ban on intentional private edits");
});

test("concurrent copies never replace one another's files", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([copy(f), copy(f)]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  await verify(f);
  assert.deepEqual((await readdir(f.directory)).sort(), ["costs.json", "ledger.json", "migration-manifest.json"]);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test("independent selected homes never share data and source changes refuse a recopy", async (t) => {
  const f = await fixture(t); await copy(f);
  const other = await fixture(t);
  assert.equal(await readExpenseOverlay(other.env), null);
  await copy(other, { costConfiguration: config });
  assert.deepEqual((await readExpenseOverlay(other.env)).costs, config);
  assert.deepEqual((await readExpenseOverlay(f.env)).costs, defaultCostConfiguration(f.env));
  await writeFile(f.source, JSON.stringify({ ...ledger, entries: [] }));
  await assert.rejects(copy(f)); await assert.rejects(verify(f));
  assert.deepEqual((await readExpenseOverlay(f.env)).ledger, ledger);
});

test("explicit home and safe source are required; no environment or user-home guessing", async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { HOME: f.home }, { FM_HOME: "relative" }, { FM_HOME: "/" }, { FM_HOME: `${f.home}/../home` }, { FM_HOME: f.sourceRoot }]) await assert.rejects(copy(f, { env }));
  assert.equal(await readExpenseOverlay({ HOME: f.home }), null);
  await writeFile(f.source, "not-json PRIVATE SENTINEL");
  await assert.rejects(copy(f)); assert.deepEqual(await readdir(f.home), []);
});

for (const target of ["home", "data", "agentos", "expenses", "ledger.json", "costs.json", "migration-manifest.json"]) test(`symlink at ${target} is refused by migration and resolver`, async (t) => {
  const f = await fixture(t); await copy(f);
  const file = ({ home: f.home, data: path.join(f.home, "data"), agentos: path.dirname(f.directory), expenses: f.directory })[target] || path.join(f.directory, target);
  const outside = path.join(f.root, "outside");
  await rm(file, { recursive: true });
  // Dangling link proves ENOENT is not mistaken for an absent overlay.
  await symlink(outside, file);
  await assert.rejects(copy(f)); await assert.rejects(readExpenseOverlay(f.env));
  assert.equal(await readFile(f.source, "utf8"), f.bytes.toString());
});

test("hardlinks, unsafe permissions, oversized/nonregular inputs and active locks fail closed", async (t) => {
  const f = await fixture(t); await copy(f);
  const destination = path.join(f.directory, "ledger.json");
  const alias = path.join(f.root, "alias"); await link(destination, alias);
  await assert.rejects(readExpenseOverlay(f.env)); await assert.rejects(copy(f)); await rm(alias);
  if (process.platform !== "win32") {
    await chmod(destination, 0o644); await assert.rejects(readExpenseOverlay(f.env)); await assert.rejects(copy(f)); await chmod(destination, 0o600);
    await chmod(path.dirname(f.directory), 0o755); await assert.rejects(copy(f)); await chmod(path.dirname(f.directory), 0o700);
  }
  await writeFile(path.join(path.dirname(f.directory), ".expense-migration.lock"), "occupied", { mode: 0o600 });
  await assert.rejects(copy(f)); await verify(f);
  assert.equal(await readFile(path.join(path.dirname(f.directory), ".expense-migration.lock"), "utf8"), "occupied");
  await writeFile(f.source, "x".repeat(4 * 1024 * 1024 + 1)); await assert.rejects(copy(f));
  await rm(f.source); await mkdir(f.source); await assert.rejects(copy(f));
});

test("source symlinks are rejected without touching the home", async (t) => {
  const f = await fixture(t); await rm(f.source); await symlink(path.join(f.root, "missing"), f.source);
  await assert.rejects(copy(f)); assert.deepEqual(await readdir(f.home), []);
});

test("schema rejects malformed ledgers and unsafe attribution, while allowing empty defaults", () => {
  validateExpenseLedger({ version: 1, default_currency: "USD", entries: [] });
  validateCostConfiguration({ ...config, azureTag: null, attribution: {} });
  for (const row of [{ ...ledger.entries[0], amount: 12.5 }, { ...ledger.entries[0], date: "2025-02-30" }, { ...ledger.entries[0], note: "line\nbreak" }]) assert.throws(() => validateExpenseLedger({ ...ledger, entries: [row] }));
  for (const value of [{ ...config, azureTag: "bad/tag" }, { ...config, extra: "secret" }, { ...config, attribution: { example: "unclassified" } }, { ...config, attribution: JSON.parse('{"__proto__":"Example"}') }]) assert.throws(() => validateCostConfiguration(value));
});

test("CLI copy and verification use only synthetic input and report no private values", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.sourceRoot, "prototype", "scripts"), { recursive: true });
  await writeFile(path.join(f.sourceRoot, "prototype", "package.json"), '{"type":"module"}');
  for (const name of ["private-migration.js", "private-runtime.js", "private-verification.js", "cost-config.js", "scripts/private-overlay.mjs"]) await copyFile(path.join(repo, "prototype", name), path.join(f.sourceRoot, "prototype", name));
  const script = path.join(f.sourceRoot, "prototype", "scripts", "private-overlay.mjs");
  const env = { ...envWithoutHome(), ...f.env };
  for (const arg of ["--copy", "--copy", "--verify", "--verify-preserved"]) {
    const output = execFileSync(process.execPath, [script, arg], { env, encoding: "utf8" });
    assert.doesNotMatch(output, /Synthetic|Example Store|cost-center|sha256|12\.50/);
    assert.equal(output.includes(f.root), false);
  }
  const result = spawnSync(process.execPath, [script, "--copy"], { env: envWithoutHome(), encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /refused/);
});

test("Python helper reads and edits the selected overlay, locks there and leaves source untouched", async (t) => {
  const f = await fixture(t); await copy(f);
  const tracker = path.join(f.sourceRoot, "expenses", "expense_tracker.py");
  await copyFile(path.join(repo, "expenses/expense_tracker.py"), tracker);
  const env = { ...envWithoutHome(), ...f.env, PYTHONDONTWRITEBYTECODE: "1" };
  const run = (...args) => execFileSync("python3", [tracker, ...args], { env, encoding: "utf8" });
  assert.match(run("check"), /valid: 4/);
  assert.match(run("rollup"), /10000000000000000000000000010.01/);
  run("update", "sample-1", "--amount", "15.00");
  run("add", "--date", "2025-01-10", "--amount", "1.00", "--project", "example", "--note", "Synthetic addition");
  const overlay = await readExpenseOverlay(f.env);
  assert.equal(overlay.ledger.entries[0].amount, "15.00"); assert.equal(overlay.ledger.entries.length, 5);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.equal((await stat(path.join(f.directory, "ledger.json"))).mode & 0o777, 0o600);
  assert.ok((await readdir(f.directory)).includes(".expense_tracker.lock"));
  assert.deepEqual((await readdir(path.dirname(f.source))).sort(), ["expense_tracker.py", "ledger.json"]);
  await rm(path.join(f.directory, "costs.json"));
  const invalid = spawnSync("python3", [tracker, "add", "--date", "2025-01-10", "--amount", "1.00", "--project", "example", "--note", "No fallback"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1); assert.deepEqual(await readFile(f.source), f.bytes);
  await symlink(path.join(f.root, "missing"), path.join(f.directory, "costs.json"));
  assert.equal(spawnSync("python3", [tracker, "check"], { env, encoding: "utf8" }).status, 1);
  await rm(path.join(f.directory, "costs.json"));
  await writeFile(path.join(f.directory, "costs.json"), "{}", { mode: 0o600 });
  assert.equal(spawnSync("python3", [tracker, "check"], { env, encoding: "utf8" }).status, 1);
  await writeFile(path.join(f.directory, "costs.json"), JSON.stringify(config));
  await rm(path.join(f.directory, ".expense_tracker.lock"));
  await symlink(f.source, path.join(f.directory, ".expense_tracker.lock"));
  assert.equal(spawnSync("python3", [tracker, "check"], { env, encoding: "utf8" }).status, 1);
  assert.deepEqual(await readFile(f.source), f.bytes);
});
