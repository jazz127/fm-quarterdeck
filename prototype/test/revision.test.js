import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../server.js";
import { reviewVersion } from "../review.js";
import { createRevisionResolver } from "../revision.js";

test("a running server refuses dirty and clean moved HEAD; restart binds new backend identity", async (t) => {
  const initial = "a".repeat(40), next = "b".repeat(40);
  let head = initial, dirty = false;
  const resolver = (startup) => createRevisionResolver("/synthetic/source", startup, { intervalMs: 0, git: async (args) => {
    if (args.includes("--show-toplevel")) return "/synthetic/source";
    if (args[0] === "status") return dirty ? " M prototype/server.js" : "";
    if (args[0] === "rev-parse") return head;
    throw new Error("Ancestry cannot refresh imported modules");
  } });
  const listen = async (startup) => {
    const server = createServer({ FM_DEPLOYMENT_TIER: "uat" }, { revisionResolver: resolver(startup), reviewCount: async () => 0 });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const base = await listen(initial);
  assert.equal((await (await fetch(base + "/api/review")).json()).version, initial);
  assert.ok((await (await fetch(base)).text()).includes(`window.FM_BOOT_REVISION="${initial}"`));
  head = next; dirty = true;
  assert.equal((await fetch(base + "/api/health")).status, 503);
  dirty = false;
  for (const url of ["/", "/app.js", "/manifest.webmanifest", "/icons/quarterdeck-192.png", "/icons/quarterdeck-512.png", "/icons/apple-touch-icon-180.png", "/api/health", "/api/review", "/api/previews"]) {
    assert.equal((await fetch(base + url)).status, 503, `old process refuses ${url}`);
  }
  const restarted = await listen(next);
  assert.equal((await (await fetch(restarted + "/api/review")).json()).version, next);
  const page = await fetch(restarted);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.match(html, new RegExp(`"revision":"${next}"`));
  assert.ok(html.includes(`window.FM_BOOT_REVISION="${next}"`));
  assert.equal((await fetch(restarted + "/manifest.webmanifest")).status, 200);
});

test("fresh initial commit needs no parent; missing Git and dirty identity fail closed", async (t) => {
  const initial = "c".repeat(40);
  const probes = [];
  let unavailable = false;
  const resolver = createRevisionResolver("/synthetic/fresh-source", initial, { intervalMs: 0, git: async (args) => {
    probes.push(args);
    if (unavailable) throw new Error("No Git identity");
    if (args.join(" ") === "rev-parse --show-toplevel") return "/synthetic/fresh-source";
    if (args.join(" ") === "rev-parse --verify HEAD^{commit}") return initial;
    if (args[0] === "status") return "";
    throw new Error("Fresh identity must not need ancestry or a parent");
  } });
  assert.equal(await resolver.snapshot(), initial);
  assert.ok(probes.every((args) => !args.some((arg) => arg === "HEAD^" || arg === "merge-base")));
  const server = createServer({}, { revisionResolver: resolver });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  unavailable = true;
  assert.equal((await fetch(`${base}/api/health`)).status, 503);
});
