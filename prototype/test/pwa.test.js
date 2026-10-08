import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { createServer } from "../server.js";

const revision = "a".repeat(40);
const icons = [
  ["/icons/quarterdeck-192.png", 192],
  ["/icons/quarterdeck-512.png", 512],
  ["/icons/apple-touch-icon-180.png", 180],
];

async function listen(t, env = {}, options = {}) {
  const server = createServer(env, {
    revisionResolver: { initial: revision, snapshot: async () => revision },
    reviewCount: async () => 0,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await server.shutdownPreviews();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function assertPwaHead(html) {
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<link rel="manifest" href="\/manifest.webmanifest" \/>/);
  assert.match(head, /<link rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon-180.png" \/>/);
  assert.match(head, /<meta name="theme-color" content="#0b1f2a" \/>/);
  assert.match(head, /<meta name="apple-mobile-web-app-capable" content="yes" \/>/);
  assert.match(head, /<meta name="apple-mobile-web-app-title" content="Quarterdeck" \/>/);
  assert.match(head, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" \/>/);
  assert.match(head, /viewport-fit=cover/);
  assert.equal(head.match(/window\.FM_BOOT_REVISION=/g)?.length, 1);
  assert.ok(head.includes(`window.FM_BOOT_REVISION="${revision}"`));
}

test("manifest defines an online-only standalone Quarterdeck and serves opaque PNG icons", async (t) => {
  const base = await listen(t);
  const response = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/manifest+json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const manifest = await response.json();
  assert.deepEqual(manifest, {
    id: "/", name: "Firstmate Quarterdeck", short_name: "Quarterdeck",
    start_url: "/#lanes", scope: "/", display: "standalone",
    theme_color: "#0b1f2a", background_color: "#eef1f4",
    icons: icons.slice(0, 2).map(([src, size]) => ({ src, sizes: `${size}x${size}`, type: "image/png", purpose: "any" })),
  });
  for (const [route, size] of icons) {
    const image = await fetch(base + route);
    assert.equal(image.status, 200, route);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "no-store");
    const png = Buffer.from(await image.arrayBuffer());
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.equal(png[24], 8, "8-bit channels");
    assert.equal(png[25], 2, "RGB without an alpha channel");
    // An RGB PNG can still declare transparent colors in a tRNS chunk.
    for (let offset = 8; offset < png.length;) {
      assert.notEqual(png.toString("ascii", offset + 4, offset + 8), "tRNS");
      offset += png.readUInt32BE(offset) + 12;
    }
  }
  for (const route of ["/icons/quarterdeck-256.png", "/sw.js", "/pwa.js"]) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
});

test("all public root assets and HTML are no-store outside dev mode", async (t) => {
  const base = await listen(t);
  const files = await readdir(new URL("../public/", import.meta.url), { withFileTypes: true });
  for (const file of files.filter((entry) => entry.isFile() && entry.name !== "dev-reload.js")) {
    const route = file.name === "index.html" ? "/" : `/${file.name}`;
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get("cache-control"), "no-store", route);
    await response.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/dev-reload.js`)).status, 404);
});

for (const mode of ["main", "dev", "uat", "registered-main"]) {
  test(`PWA tags and boot revision coexist with ${mode} document rewriting`, async (t) => {
    const env = mode === "dev" ? { FM_DEV: "1" } : mode === "uat" ? { FM_DEPLOYMENT_TIER: "uat" } : {};
    const options = mode === "registered-main" ? { previewRegistry: [
      { id: "main", name: "Main", branch: "main", commit: revision, remoteCheckpoint: revision, validation: "accepted" },
    ] } : {};
    const base = await listen(t, env, options);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assertPwaHead(html);
    assert.equal((await (await fetch(`${base}/api/review`)).json()).version, revision);
    if (mode === "dev") {
      assert.match(html, /src="\/dev-reload.js"/);
      assert.equal((await fetch(`${base}/dev-reload.js`)).headers.get("cache-control"), "no-store");
    }
    if (mode === "uat") assert.match(html, /window.FM_STANDALONE_UAT=/);
    if (mode === "registered-main") {
      assert.ok(html.includes(`window.FM_SERVED_COMMIT="${revision}"`));
      const preview = await fetch(`${base}/preview/main/`);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("cache-control"), "no-store");
      assertPwaHead(await preview.text());
      // PWA resources stay rooted at Main; do not widen the preview allowlist.
      assert.equal((await fetch(`${base}/preview/main/manifest.webmanifest`)).status, 404);
      assert.equal((await fetch(`${base}/preview/main/icons/quarterdeck-192.png`)).status, 404);
    }
  });
}
