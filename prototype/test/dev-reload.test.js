import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "../server.js";

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

function subscribe(port) {
  let response;
  let buffer = "";
  const events = [];
  const waiters = [];
  const request = http.get(`http://127.0.0.1:${port}/api/dev-reload`, (stream) => {
    response = stream;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const version = block.match(/(?:^|\n)event: version\ndata: ([^\n]+)/)?.[1];
        if (version) {
          if (waiters.length) waiters.shift()(version);
          else events.push(version);
        }
      }
    });
  });
  request.on("error", () => {}); // Destroying a test connection is intentional.
  return {
    next() {
      if (events.length) return Promise.resolve(events.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for reload event")), 3000);
        waiters.push((version) => { clearTimeout(timer); resolve(version); });
      });
    },
    stop() { response?.destroy(); request.destroy(); },
  };
}

test("dev mode serves the real configured home, announces changed assets, and reconnects after restart", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-dev-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const publicDir = path.join(root, "public");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await mkdir(publicDir);
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha - Live home fixture.\n");
  await writeFile(path.join(publicDir, "index.html"), "<body>dev fixture</body>");
  await writeFile(path.join(publicDir, "styles.css"), "body { color: red; }");
  await writeFile(path.join(publicDir, "dev-reload.js"), "// dev reload fixture");
  const env = { FM_DEV: "1", FM_HOME: home, FM_REFRESH_MS: "15000" };
  let server = createServer(env, { publicDir });
  await listen(server);
  const port = server.address().port;
  const first = subscribe(port);
  try {
    const initial = await first.next();
    const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => {
      assert.equal(res.headers.get("cache-control"), "no-store");
      return res.text();
    });
    assert.match(html, new RegExp(`data-version="${initial}"`));
    assert.match(html, /src="\/dev-reload.js"/);
    const dashboard = await fetch(`http://127.0.0.1:${port}/api/dashboard`).then((res) => res.json());
    assert.equal(dashboard.refreshMs, 15000);
    assert.equal(dashboard.fleet.source, "Firstmate home");
    assert.equal(dashboard.fleet.projects[0].name, "Alpha");
    await writeFile(path.join(publicDir, "styles.css"), "body { color: blue; }");
    const changed = await first.next();
    assert.notEqual(changed, initial);
    first.stop();
    await close(server);

    server = createServer(env, { publicDir });
    await listen(server, port); // The browser keeps this URL through node --watch restarts.
    const reconnected = subscribe(port);
    try {
      assert.notEqual(await reconnected.next(), changed);
    } finally {
      reconnected.stop();
    }
  } finally {
    first.stop();
    if (server.listening) await close(server);
  }
});

test("browser reload client ignores same-version reconnects and reloads on a new server version", async () => {
  const source = await readFile(new URL("../public/dev-reload.js", import.meta.url), "utf8");
  let reloads = 0;
  const connections = [];
  class FakeEventSource {
    constructor(url) { this.url = url; connections.push(this); }
    addEventListener(type, callback) { this.callback = callback; assert.equal(type, "version"); }
    close() { this.closed = true; }
  }
  vm.runInNewContext(source, {
    document: { currentScript: { dataset: { version: "original" } } },
    EventSource: FakeEventSource,
    window: { location: { reload: () => { reloads++; } } },
  });
  assert.equal(connections[0].url, "/api/dev-reload");
  connections[0].callback({ data: "original" }); // Initial handshake or reconnection.
  assert.equal(reloads, 0);
  assert.equal(connections[0].closed, undefined);
  connections[0].callback({ data: "after-restart" });
  assert.equal(reloads, 1);
  assert.equal(connections[0].closed, true);
});

test("production mode has no reload endpoint or injected script", async (context) => {
  const server = createServer({});
  await listen(server);
  context.after(() => close(server));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/dev-reload`)).status, 404);
  assert.equal((await fetch(`${base}/dev-reload.js`)).status, 404);
  assert.doesNotMatch(await fetch(base).then((res) => res.text()), /dev-reload\.js/);
});
