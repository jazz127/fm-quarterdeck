import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeAwaySummary, claudeProjectDirectory, claudeTurns } from "../claude-transcript.js";
import { createCallSource, createChatAskScanner, discoverPrimarySources, memoryStateFile } from "../chat-asks.js";
import { createServer } from "../server.js";
import { awaySummary } from "./helpers/claude-recap.js";

const lines = (...records) => records.map(record => JSON.stringify(record)).join("\n") + "\n";
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "quarterdeck-recap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), config = path.join(root, "config");
  await mkdir(path.join(home, "state"), { recursive: true });
  const directory = claudeProjectDirectory(config, home);
  await mkdir(directory, { recursive: true });
  const lock = path.join(home, "state/.lock-session"), file = path.join(directory, "primary.jsonl");
  await writeFile(lock, "primary\n");
  await writeFile(file, lines(awaySummary()));
  const store = memoryStateFile();
  const scanner = () => createChatAskScanner({ home, claudeConfigDir: config, store, discoverEveryMs: 0, ...options });
  return { root, home, config, directory, lock, file, scanner, chat: scanner() };
}
const recap = chat => chat.view().primaryRecap;

test("away recap uses only top-level string content, strips complete envelopes, never becomes dialogue", () => {
  const text = "[fm-lane Example]\nFirst line <img src=x onerror=alert(1)>\n[keep this]\n[end Example]\n\n[fm-lane General]\nSecond line.\n[end General]";
  const record = awaySummary(text);
  assert.equal(claudeAwaySummary(record), "First line <img src=x onerror=alert(1)>\n[keep this]\n\nSecond line.");
  assert.deepEqual(claudeTurns(record, new Map()), []);
  for (const extra of [{ type: "assistant" }, { subtype: "turn_duration" }, { isSidechain: true }, { isMeta: true }, { isCompactSummary: true }]) {
    assert.equal(claudeAwaySummary(awaySummary("ignored", extra)), undefined);
  }
  for (const content of [undefined, null, {}, ["not a string"], "", " \n "]) assert.equal(claudeAwaySummary(awaySummary(content, { content })), "");
  assert.equal(claudeAwaySummary(awaySummary("[fm-lane Example]\nKeep unmatched markup\n[end Other]")), "[fm-lane Example]\nKeep unmatched markup\n[end Other]");
});

test("current selected primary uses append order, clears on latest empty/missing, and backfills once after restart", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "newer.jsonl"), lines(awaySummary("Do not use another session")));
  await writeFile(f.file, lines(awaySummary("Earlier", { timestamp: "2040-01-01T00:00:00Z" }), awaySummary("Latest", { timestamp: "2000-01-01T00:00:00Z", sessionId: "different-record-id", cwd: "/synthetic/other" })));
  await f.chat.scan();
  assert.deepEqual(recap(f.chat), { text: "Latest", state: "ready" });
  assert.deepEqual(f.chat.asks(), []);
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Latest");
  const restarted = f.scanner();
  await restarted.scan();
  assert.equal(recap(restarted).text, "Latest", "persisted ask cursor cannot hide recap after process restart");
  for (const content of ["", " \n ", null, undefined]) {
    await appendFile(f.file, lines(awaySummary(content, { content })));
    await f.chat.scan();
    assert.deepEqual(recap(f.chat), { text: null, state: "ready" });
  }
  await appendFile(f.file, lines(awaySummary("First equal clock"), awaySummary("Second equal clock"), awaySummary("Ignored", { isSidechain: true }), awaySummary("Ignored", { isMeta: true })));
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Second equal clock");
});

test("selection switch, deletion, inode replacement and truncation never retain another source's recap", async t => {
  const f = await fixture(t);
  await f.chat.scan();
  const other = path.join(f.directory, "second.jsonl");
  await writeFile(other, lines({ type: "user", message: { content: "Neutral session" } }));
  await writeFile(f.lock, "second\n");
  await f.chat.scan();
  assert.equal(recap(f.chat).text, null);
  await appendFile(other, lines(awaySummary("Second session recap")));
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Second session recap");
  await rename(other, path.join(f.root, "old-records"));
  await writeFile(other, lines({ type: "system", subtype: "turn_duration" }));
  await f.chat.scan();
  assert.equal(recap(f.chat).text, null);
  await appendFile(other, lines(awaySummary("Before truncation")));
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Before truncation");
  await writeFile(other, "");
  await f.chat.scan();
  assert.equal(recap(f.chat).text, null);
  await rm(f.file);
  await rm(other);
  await f.chat.scan();
  assert.deepEqual(recap(f.chat), { text: null, state: "unavailable" });
});

for (const reset of ["restart", "reselection", "recovery"]) {
  for (const growth of ["beyond backfill", "inside backfill"]) {
    test(`recap ${reset} preserves unread asks ${growth}`, async t => {
      let failDiscovery = false;
      const f = await fixture(t, {
        now: () => Date.parse("2030-01-02T12:00:00Z"),
        discover: async (...args) => {
          if (failDiscovery) throw new Error("synthetic discovery failure");
          return discoverPrimarySources(...args);
        },
      });
      await f.chat.scan();
      if (reset === "reselection") {
        await writeFile(path.join(f.directory, "second.jsonl"), lines(awaySummary("Other session")));
        await writeFile(f.lock, "second\n");
        await f.chat.scan();
        assert.equal(recap(f.chat).text, "Other session");
      } else if (reset === "recovery") {
        failDiscovery = true;
        await f.chat.scan();
        assert.equal(f.chat.view().state, "stale");
        failDiscovery = false;
      }
      const ask = { type: "assistant", uuid: "unread-ask", timestamp: growth === "beyond backfill" ? "2030-01-02T11:00:00Z" : "2029-12-30T11:00:00Z",
        message: { role: "assistant", content: "APPROVAL NEEDED: Archive sample notes. Reply \"archive sample\"." } };
      const ordinary = lines({ type: "system", subtype: "turn_duration", padding: "x".repeat(1024) });
      await appendFile(f.file, lines(ask) + ordinary.repeat(growth === "beyond backfill" ? 5000 : 2) + lines(awaySummary("Latest after backlog")));
      if (reset === "reselection") await writeFile(f.lock, "primary\n");
      const chat = reset === "restart" ? f.scanner() : f.chat;
      await chat.scan();
      assert.deepEqual(chat.asks().map(entry => entry.recordId), ["unread-ask"], "recap hydration must retain incremental ask intake, including its age semantics");
      for (let i = 0; i < 4 && chat.view().behind; i++) await chat.scan();
      assert.equal(chat.view().behind, false);
      assert.deepEqual(recap(chat), { text: "Latest after backlog", state: "ready" });
      await chat.scan();
      assert.equal(chat.asks().length, 1);
    });
  }
}

test("partial, malformed, overlong and bounded reads hide uncertainty without a full-history fallback", async t => {
  const f = await fixture(t, { maxLineBytes: 1024, backfillBytes: 2048, maxScanBytes: 1024 });
  await f.chat.scan();
  const partial = JSON.stringify(awaySummary("Completed partial recap"));
  await appendFile(f.file, partial.slice(0, 50));
  await f.chat.scan();
  assert.deepEqual(recap(f.chat), { text: null, state: "limited" });
  await appendFile(f.file, partial.slice(50) + "\n");
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Completed partial recap");
  const ordinary = JSON.stringify({ type: "system", subtype: "turn_duration" });
  await appendFile(f.file, ordinary.slice(0, 10));
  await f.chat.scan();
  assert.equal(recap(f.chat).state, "limited");
  await appendFile(f.file, ordinary.slice(10) + "\n");
  await f.chat.scan();
  assert.equal(recap(f.chat).text, "Completed partial recap");
  await appendFile(f.file, '{"type":"system","subtype":"away_summary",broken}\n');
  await f.chat.scan();
  assert.deepEqual(recap(f.chat), { text: null, state: "limited" });
  await appendFile(f.file, lines(awaySummary("x".repeat(3000))));
  for (let i = 0; i < 4; i++) await f.chat.scan();
  assert.equal(recap(f.chat).text, null);
  await writeFile(f.file, lines(awaySummary("Only in omitted history")) + lines(...Array.from({ length: 100 }, () => ({ type: "system", padding: "x".repeat(100) }))));
  const bounded = f.scanner();
  for (let i = 0; i < 4; i++) await bounded.scan();
  assert.deepEqual(recap(bounded), { text: null, state: "limited" });
});

test("non-Claude primary and missing config never supply a recap; discovery budget failures clear it", async t => {
  const f = await fixture(t);
  const pi = createChatAskScanner({ home: f.home, discover: async () => ({ sources: [{ file: f.file, source: "state/main-session/synthetic.jsonl", origin: "pi" }], warnings: [] }) });
  await pi.scan();
  assert.deepEqual(recap(pi), { text: null, state: "unavailable" });
  const missing = createChatAskScanner({ home: f.home });
  await missing.scan();
  assert.equal(recap(missing).text, null);
  const zero = createChatAskScanner({ home: f.home, claudeConfigDir: f.config, historyLimits: { maxFiles: 0 } });
  await zero.scan();
  assert.equal(recap(zero).state, "unavailable");
  assert.match(zero.view().error, /History exceeds safe read limits/);
});

test("recap-only updates change the composed revision, unchanged API and observed SSE retain the projection", async t => {
  const f = await fixture(t);
  const listeners = new Set();
  const base = { rev: "base", state: "ready", cards: [], coverage: {}, omitted: [], observedAt: null, checkedAt: null };
  const hub = { current: () => base, touch() {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, close() {} };
  const source = createCallSource({ hub, chat: f.chat });
  const revision = "c".repeat(40);
  const server = createServer({}, { revisionResolver: { initial: revision, snapshot: async () => revision }, bearingsSource: source, bearingsStream: { heartbeatMs: 50 } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { source.close(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/bearings`;
  const first = await (await fetch(url)).json();
  assert.equal(first.primaryRecap.text, "The sample checks completed.");
  const unchanged = await (await fetch(`${url}?since=${first.rev}`)).json();
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.primaryRecap, first.primaryRecap);
  await appendFile(f.file, lines(awaySummary("Recap changed without a call")));
  const changed = await (await fetch(`${url}?since=${first.rev}`)).json();
  assert.notEqual(changed.rev, first.rev);
  assert.deepEqual(changed.cards, first.cards);
  assert.equal(changed.primaryRecap.text, "Recap changed without a call");
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${url}/stream`, { signal: abort.signal });
  const reader = response.body.getReader();
  let wire = "";
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    while (!/event: observed\ndata: [^\n]*"primaryRecap"/.test(wire)) wire += new TextDecoder().decode((await reader.read()).value);
    assert.match(wire, /event: model\n/);
    const observed = wire.match(/event: observed\ndata: ([^\n]+)/);
    assert.equal(JSON.parse(observed[1]).primaryRecap.text, changed.primaryRecap.text);
    assert.equal(wire.includes(f.home), false);
    assert.equal(wire.includes(f.config), false);
  } finally { clearTimeout(timer); abort.abort(); }
});
