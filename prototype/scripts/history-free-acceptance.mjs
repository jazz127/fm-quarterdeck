// Internal entry point for scripts/accept-history-free.py, not a live-home launcher.
// All services bind ephemeral loopback ports and all writes stay in its temp root.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createServer, loadExpenses } from "../server.js";
import { reviewVersion } from "../review.js";
import { previewOnboarding, applyOnboarding } from "../onboarding.js";
import { migratePrivateExpenses } from "../private-migration.js";
import { createConfiguredCostReader } from "../costs.js";
import { createSyntheticHistory, fixtureGit } from "./synthetic-history.mjs";
import { processIdentity } from "../preview-lifecycle.js";

const [root, mode, expected] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(repo, path.join(root, "home/projects/fm-quarterdeck"));
assert.match(path.basename(root), /^history-free-/);
assert.ok(["no-git", "first-commit", "identity-only"].includes(mode));
assert.equal(process.env.FM_HOME, undefined);
const home = path.join(root, "home");
const offline = { run: async () => { throw new Error("Synthetic offline account boundary"); } };
const options = { quotaReader: async () => ({ available: false, subscriptions: [], providers: [] }),
  costReader: createConfiguredCostReader({}, offline), reviewCount: async () => 0 };
const listen = async (server) => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { await server.shutdownPreviews(); server.closeAllConnections(); await new Promise((r) => server.close(r)); };
const wait = async (predicate) => { const end = Date.now() + 12000; while (!await predicate()) { assert.ok(Date.now() < end, "bounded fixture deadline"); await new Promise((r) => setTimeout(r, 30)); } };

if (mode === "no-git") {
  assert.equal(reviewVersion, "unknown");
  const server = createServer({}, options), url = await listen(server);
  try { assert.equal((await fetch(`${url}/api/health`)).status, 503); }
  finally { await close(server); }
  console.log("PASS: nested Git-free export refuses parent/inherited Git identity at startup and health (503)");
} else if (mode === "identity-only") {
  assert.equal(reviewVersion, expected);
  const server = createServer({}, options), url = await listen(server);
  try {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    assert.equal((await (await fetch(`${url}/api/review`)).json()).version, expected);
  } finally { await close(server); }
  console.log("PASS: inherited Git redirection cannot replace the actual clean source identity");
} else {
  assert.equal(reviewVersion, expected);
  assert.equal(fixtureGit(repo, "rev-list", "--parents", "-n", "1", "HEAD"), expected);
  assert.equal(fixtureGit(repo, "remote"), "");
  const env = { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(root, "presentation-state.json") };
  await mkdir(path.join(home, "data"), { recursive: true }); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Example Store - Synthetic first-run project\n");
  await writeFile(path.join(home, "data/backlog.md"), "## Queued\n");
  const preview = previewOnboarding(home, { authoritativeHome: home });
  assert.equal(applyOnboarding(preview, `seed ${home}`).changed, true);
  assert.equal(previewOnboarding(home, { authoritativeHome: home }).changed, false);
  await migratePrivateExpenses({ sourceRoot: repo, env, mode: "copy" });
  const ledger = path.join(home, "data/agentos/expenses/ledger.json");
  const synthetic = { version: 1, default_currency: "USD", entries: [{ id: "synthetic", date: "2000-01-01", amount: "12.34", project_id: "example", project_name: "Example", note: "Synthetic acceptance only" }] };
  await writeFile(ledger, JSON.stringify(synthetic), { mode: 0o600 });
  assert.equal((await stat(ledger)).mode & 0o077, 0);
  assert.equal((await loadExpenses({ HOME: home })).entryCount, 0); // explicit FM_HOME is the only connection
  assert.equal((await loadExpenses(env)).entryCount, 1);
  assert.deepEqual((await readdir(home)).sort(), ["data", "projects", "state"]); // no saved/circular home pointer
  assert.throws(() => createServer({ ...env, FM_QUARTERDECK_STATE_PATH: path.join(home, "data/state.json") }, options), /outside FM_HOME/);

  // These are independent exports with their own synthetic parent/child objects.
  const previewRoot = path.join(root, "previews");
  const { head, ancestor } = await createSyntheticHistory(path.join(previewRoot, "one"));
  await createSyntheticHistory(path.join(previewRoot, "bad"));
  fixtureGit(path.join(previewRoot, "bad"), "checkout", "-q", "--detach", ancestor);
  const reserve = net.createServer(); await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port; await new Promise((r) => reserve.close(r));
  const registry = [
    { id: "main", name: "Synthetic host", branch: "main", commit: expected, remoteCheckpoint: expected, validation: "captured" },
    { id: "uat", name: "Synthetic alternate", branch: "uat", commit: head, remoteCheckpoint: ancestor, validation: "captured", checkout: "one", port },
    { id: "dev-bad", name: "Wrong checkout", branch: "dev/bad", commit: head, remoteCheckpoint: head, validation: "captured", checkout: "bad", port },
    { id: "dev-uncaptured", name: "Uncaptured", branch: "dev/uncaptured", commit: head, remoteCheckpoint: ancestor, validation: "captured", checkout: "one", port },
  ];
  assert.throws(() => createServer(env, { ...options, previewRegistry: [{ ...registry[0], commit: "a".repeat(40) }] }), /exact stable host/);
  const server = createServer({ ...env, FM_PREVIEW_ROOT: previewRoot, FM_PREVIEW_PORT_MIN: String(port), FM_PREVIEW_PORT_MAX: String(port), FM_PREVIEW_START_MS: "10000" }, { ...options, previewRegistry: registry });
  const url = await listen(server);
  let child;
  try {
    const health = await fetch(`${url}/api/health`);
    assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
    assert.equal((await (await fetch(`${url}/api/review`)).json()).version, expected);
    assert.equal((await fetch(url)).status, 200);
    for (const provider of ["grok", "openai", "gemini", "anthropic"])
      assert.equal((await fetch(`${url}/assets/providers/${provider}.svg`)).status, 404);
    const dashboard = await (await fetch(`${url}/api/dashboard`)).json();
    assert.equal(dashboard.expenses.source, "private overlay (selected FM_HOME)");
    assert.equal(dashboard.expenses.entryCount, 1);
    assert.deepEqual(dashboard.expenses.overall, [{ currency: "USD", amount: "12.34" }]);
    assert.equal((await fetch(`${url}/api/preferences`)).status, 200);
    const post = (id, origin = url, extra = {}) => fetch(`${url}/api/previews/select`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ id, ...extra }) });
    assert.equal((await post("uat", "https://evil.example")).status, 403);
    assert.equal((await post("uat", url, { command: "forbidden" })).status, 400);
    assert.equal((await post("dev-bad")).status, 200);
    await wait(() => server.previewLifecycle.status("dev-bad").state === "revision-mismatch");
    assert.equal(server.previewLifecycle.owned, null);
    await post("dev-uncaptured");
    await wait(() => server.previewLifecycle.status("dev-uncaptured").state === "revision-mismatch");
    assert.equal(server.previewLifecycle.owned, null);
    await post("uat");
    await wait(() => ["ready", "idling"].includes(server.previewLifecycle.status("uat").state));
    child = server.previewLifecycle.owned.child.pid;
    assert.equal(server.previewLifecycle.status("uat").relation, "local-ahead");
    assert.equal((await fetch(`${url}/preview/uat/api/health`)).status, 200);
    assert.equal((await (await fetch(`${url}/preview/uat/api/review`)).json()).version, head);
    // No revision bypass: even this initial-commit server fails closed when dirty.
    const readme = path.join(repo, "README.md"), clean = await readFile(readme);
    try {
      await writeFile(readme, Buffer.concat([clean, Buffer.from("\nSynthetic dirty guard\n")]));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal((await fetch(`${url}/api/health`)).status, 503);
    } finally { await writeFile(readme, clean); }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  } finally { await close(server); }
  if (child) await wait(async () => await processIdentity(child) === null);
  assert.equal(fixtureGit(repo, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(fixtureGit(repo, "rev-list", "--count", "--all"), "1");
  assert.equal(fixtureGit(repo, "rev-parse", "HEAD"), expected);
  console.log("PASS: first commit; onboarding; explicit synthetic FM_HOME/private data; health/revision; dirty/origin/registry guards; exact owned preview startup/proxy/shutdown");
}
