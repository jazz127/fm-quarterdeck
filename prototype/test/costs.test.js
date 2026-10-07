import test from "node:test";
import assert from "node:assert/strict";
import { azureRows, parseAzure, parseGitHub, readAzure, readGitHub, createCostReader } from "../costs.js";
import { createServer } from "../server.js";

const table = (amount = 12.5, name = null, dimension = null) => ({ properties: { columns: [{ name: "Currency" }, { name: "Cost" }, ...(dimension ? [{ name: dimension }] : [])], rows: [["USD", amount, ...(dimension ? [name] : [])]] } });
const mapping = { "quarterdeck": "Quarterdeck", "example-store": "Example Store" };
const capturedAt = "2026-09-27T12:00:00.000Z";
const envelope = (text) => `api_response:\n  body: ${JSON.stringify(text)}\n  truncated: false\n`;

test("Azure actual remains separate from unproven project allocations, with source period and currency", () => {
  const result = parseAzure(table(), { ServiceName: table(12.5, "Compute", "ServiceName"), ResourceGroupName: table(12.5, "demo", "ResourceGroupName") }, capturedAt);
  assert.equal(result.actual.amount, 12.5);
  assert.equal(result.actual.currency, "USD");
  assert.equal(result.period.start, "2026-09-01");
  assert.deepEqual(Object.keys(result.attribution), ["unclassified"]);
  assert.equal(result.attribution.unclassified.amount, 12.5);
  assert.equal(result.forecast, null);
  assert.equal(result.delayed, "unknown");
});
test("only explicitly matched tag evidence allocates project spend", () => {
  const r = parseAzure(table(), { TagKey: { properties: { columns: [{ name: "cost-center" }, { name: "Cost" }, { name: "Currency" }], rows: [["quarterdeck", 2.5, "USD"], ["example-store", 6, "USD"], ["other", 4, "USD"]] } } }, capturedAt, "cost-center", mapping);
  assert.equal(r.attribution["Quarterdeck"].amount, 2.5);
  assert.equal(r.attribution["Example Store"].amount, 6);
  assert.equal(r.attribution.unclassified.amount, 4);
  assert.equal(parseAzure(table(), { TagKey: table(1, "quarterdeck", "cost-center") }, capturedAt, "cost-center", mapping).attribution["Quarterdeck"], null);
});
test("malformed Cost Management tables fail closed", () => {
  assert.throws(() => azureRows({ properties: { columns: [{ name: "Cost" }], rows: [[3]] } }));
  assert.throws(() => azureRows({ properties: { columns: [{ name: "Cost" }, { name: "Currency" }], rows: [["secret", "USD"]] } }));
  assert.throws(() => azureRows({ ...table(), properties: { ...table().properties, nextLink: "secret" } }));
});
test("Azure reader confines subscription identifier and raw diagnostics", async () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const run = async (_bin, args) => { if (args[0] === "account") return { stdout: JSON.stringify({ id, accessToken: "TOPSECRET" }) }; const group = JSON.parse(args[args.indexOf("--body") + 1]).dataset.grouping?.[0]?.name; return { stdout: JSON.stringify(group ? table(12.5, "demo", group) : table()) }; };
  const reading = await readAzure({ run, now: () => Date.parse(capturedAt) });
  assert.equal(reading.actual.amount, 12.5);
  assert.doesNotMatch(JSON.stringify(reading), /TOPSECRET|aaaaaaaa/);
  const denied = await readAzure({ run: async (_bin, args) => args[0] === "account" ? { stdout: JSON.stringify({ id }) } : Promise.reject({ stdout: "AuthorizationFailed token TOPSECRET" }) });
  assert.match(denied.reason, /Cost Management Reader/);
  assert.doesNotMatch(JSON.stringify(denied), /TOPSECRET|aaaaaaaa/);
});
test("GitHub report separates consumed, billable, and unavailable allowances", () => {
  const reading = parseGitHub([{ product: "Actions", sku: "Actions Linux", unitType: "minutes", quantity: 8, netAmount: 0.08, repositoryName: "owner/repo" }], capturedAt);
  assert.equal(reading.actual.minutes, 8);
  assert.equal(reading.billable.minutes, null);
  assert.equal(reading.billable.amount, 0.08);
  assert.equal(reading.included, null);
  assert.equal(reading.remaining, null);
  assert.equal(reading.breakdowns[0].repository, "owner/repo");
  assert.equal(parseGitHub([], capturedAt).actual.minutes, null);
  assert.throws(() => parseGitHub([{ product: "Actions", unitType: "minutes", quantity: "bad" }], capturedAt));
});
test("GitHub signed-in user report never leaks login or auth diagnostics", async () => {
  let calls = 0;
  const run = async (_bin, args) => { calls++; if (calls === 1) return { stdout: envelope("test-user") }; assert.match(args[1], /test-user\/settings\/billing\/usage/);
    return { stdout: envelope('"Actions"|"Actions Linux"|8|"minutes"|8|<nil>|0.08|0.08|"owner/repo"\n') }; };
  const reading = await readGitHub({ run, now: () => Date.parse(capturedAt) });
  assert.equal(reading.actual.minutes, 8);
  assert.doesNotMatch(JSON.stringify(reading), /test-user/);
  const denied = await readGitHub({ run: async () => Promise.reject({ stdout: "NOT_FOUND token TOPSECRET" }) });
  assert.match(denied.reason, /Plan: read/);
  assert.doesNotMatch(JSON.stringify(denied), /TOPSECRET/);
});
test("server serves only sanitized cost snapshots", async () => {
  const server = createServer({}, { revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) }, costReader: async () => ({ azure: parseAzure(table(), {}, capturedAt), github: { state: "unavailable", reason: "GitHub billing access required", capturedAt: null } }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/costs`);
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.azure.actual.amount, 12.5);
    assert.equal(json.github.state, "unavailable");
    assert.doesNotMatch(JSON.stringify(json), /subscriptionId|accessToken/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("provider failures isolate, concurrent refreshes coalesce and stale snapshot retains timestamp", async () => {
  let reads = 0; let time = Date.parse(capturedAt); let fail = false;
  const reader = createCostReader({ now: () => time, ttlMs: 60000,
    azure: async () => { reads++; return fail ? { state: "unavailable", reason: "Cost Management Reader required", capturedAt: null } : parseAzure(table(), {}, capturedAt); },
    github: async () => parseGitHub([], capturedAt) });
  const [a, b] = await Promise.all([reader(), reader()]);
  assert.equal(reads, 1);
  assert.equal(a.azure.actual.amount, b.azure.actual.amount);
  time += 61000; fail = true;
  const stale = await reader();
  assert.equal(stale.azure.state, "stale");
  assert.equal(stale.azure.capturedAt, capturedAt);
  assert.equal(stale.azure.ageMs, 61000);
  assert.equal(stale.github.state, "partial");
  assert.equal(reads, 2);
});
