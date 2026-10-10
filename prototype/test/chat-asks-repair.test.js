import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backlogHoldReasons, createBearingsHub, createSnapshotRunner, normalizeSnapshot } from "../bearings.js";
import { createCallSource, createChatAskScanner, extractReplies, memoryStateFile, recordTurns } from "../chat-asks.js";

// All dialogue, ids and ledger fields here are invented, never captured runtime data.
const time = Date.parse("2030-03-04T10:00:00Z");
const at = n => new Date(time + n * 60000).toISOString();
const assistant = (id, n, text) => ({ type: "assistant", uuid: id, timestamp: at(n), message: { content: [{ type: "text", text }] } });
const user = (id, n, text) => ({ type: "user", uuid: id, timestamp: at(n), message: { role: "user", content: text } });
const queued = (id, n, prompt, kind = "human") => ({ type: "attachment", uuid: id, timestamp: at(n), attachment: { type: "queued_command", prompt, origin: { kind } } });
const jsonl = records => records.map(r => JSON.stringify(r)).join("\n") + "\n";
const snapshot = decisions => ({ schema: "fm-bearings.v1", decisions_open: decisions, contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] });
const hold = (id, reason) => `- [ ] ${id} - Synthetic choice (hold: fm-hold-v1:${Buffer.from(reason).toString("base64")}) (hold-kind: captain)`;
async function fixture(t, records, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-ask-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "main.jsonl");
  await writeFile(file, jsonl(records));
  const store = memoryStateFile();
  const make = () => createChatAskScanner({ home: root, store, now: () => time + 3600000, discover: async () => ({ sources: [{ file, source: "claude-main-session/synthetic", origin: "claude" }], warnings: [] }), ...options });
  return { root, file, store, make, scanner: make() };
}

test("quoted line/list option labels and single-quoted suggested replies are explicit alternatives", () => {
  assert.deepEqual(extractReplies('on a sample plan:\n- **"stay on Lyra"**: continue\n- “pause work”: wait'), ["stay on Lyra", "pause work"]);
  assert.deepEqual(extractReplies('"route A" keeps the existing setup; "route B" changes it. Reply \'route A\' or \'route B\'.'), ["route A", "route B"]);
  assert.deepEqual(extractReplies('A prose mention of "not a label" is not an option.'), []);
});

test("queued human attachments answer every matching earlier ask; tools, hooks, machine text and future asks do not", async t => {
  const f = await fixture(t, [
    assistant("one", 1, 'DECISION NEEDED: Pick a sample host.\n- "stay on Lyra": continue\n- "pause work": wait'),
    assistant("two", 2, 'ACTION NEEDED: Archive sample threads. Reply "archive threads".'),
    assistant("three", 3, 'APPROVAL NEEDED: Archive another sample thread. Reply "archive threads".'),
    queued("hook", 4, "stay on Lyra; archive threads", "hook"),
    queued("machine", 4, "FIRSTMATE_OP: stay on Lyra; archive threads"),
    { type: "user", uuid: "tool", timestamp: at(4), message: { content: [{ type: "tool_result", content: "stay on Lyra; archive threads" }] } },
  ]);
  await f.scanner.scan();
  assert.equal(f.scanner.asks().length, 3);
  await appendFile(f.file, jsonl([
    queued("answer", 5, "<system-reminder>unrelated harness note</system-reminder>stay on lyra -- please archive threads, then inspect the sample preview"),
    assistant("future", 6, 'ACTION NEEDED: New sample thread. Reply "archive threads".'),
  ]));
  await f.scanner.scan();
  assert.deepEqual(f.scanner.asks().map(a => a.recordId), ["future"]);
  assert.equal(recordTurns(queued("nonhuman", 7, "archive threads", "hook"), "claude").length, 0);
});

test("captain records above 64 KiB still resolve, including pasted blocks and reminder wrappers", async t => {
  const f = await fixture(t, [
    assistant("ask", 1, 'ACTION NEEDED: Inspect the sample plot. Reply "plot checked".'),
    user("answer", 2, `<system-reminder>machine context</system-reminder>\n<pasted>\n${"synthetic detail ".repeat(6000)}\n</pasted>\nplot checked`),
  ]);
  await f.scanner.scan();
  assert.deepEqual(f.scanner.asks(), []);
  assert.equal(Object.values((await f.store.read()).asks)[0].resolvedBy, "reply");
});

test("record ceiling is enforced even when an oversized record ends in the current chunk", async t => {
  const f = await fixture(t, [
    assistant("ask", 1, 'ACTION NEEDED: Inspect the sample plot. Reply "plot checked".'),
    user("over-cap", 2, `${"x".repeat(4000)} plot checked`),
    user("small", 3, "not yet"),
  ], { maxLineBytes: 1024 });
  await f.scanner.scan();
  assert.equal(f.scanner.asks().length, 1);
  assert.equal(Object.values((await f.store.read()).cursors)[0].offset, (await readFile(f.file)).length);
  await appendFile(f.file, jsonl([user("valid", 4, "plot checked")]));
  await f.scanner.scan();
  assert.deepEqual(f.scanner.asks(), []);
});

test("version repair refreshes existing option extraction, replays queued answers and preserves dismissals", async t => {
  const f = await fixture(t, [
    assistant("option", 1, 'DECISION NEEDED: Choose a host.\n- "stay on Lyra": continue'),
    assistant("dismissed", 2, 'ACTION NEEDED: Sample dismiss. Reply "dismiss".'),
  ]);
  await f.scanner.scan();
  await f.scanner.resolve(f.scanner.asks().find(a => a.recordId === "dismissed").key, "dismissed");
  await appendFile(f.file, jsonl([queued("answer", 3, "stay on Lyra")]));
  await f.scanner.scan();
  await f.store.update(state => {
    state.matchingVersion = 2;
    const option = Object.values(state.asks).find(a => a.recordId === "option");
    option.status = "open"; option.replies = []; delete state.tombstones[option.key];
    return { write: true };
  });
  const repaired = f.make();
  await repaired.scan();
  assert.deepEqual(repaired.asks(), []);
  const state = await f.store.read();
  assert.equal(Object.values(state.asks).find(a => a.recordId === "option").resolvedBy, "reply");
  assert.equal(Object.values(state.asks).find(a => a.recordId === "dismissed").resolvedBy, "dismissed");
  assert.equal(await repaired.scan(), false);
});

test("legacy main-home reasons supplement only snapshot-authorized tasks; late cold snapshots dedup without a subscriber", async t => {
  const f = await fixture(t, [
    assistant("route", 1, 'DECISION NEEDED: "route A" keeps the sample setup; another route changes it.'),
    assistant("release", 2, 'APPROVAL NEEDED: Publish the sample preview. Reply "publish sample preview".'),
  ]);
  await mkdir(path.join(f.root, "bin")); await mkdir(path.join(f.root, "data"));
  const ledger = [hold("route-hold", "Reply 'route A'."), hold("release-hold", 'Waiting for “publish sample preview”.'), hold("not-filed", "Reply 'route A'."), hold("other-task", "Reply 'route A'."), hold("source-reason", "Must not replace upstream")].join("\n");
  await writeFile(path.join(f.root, "data/backlog.md"), ledger);
  const raw = snapshot([
    { id: "route-hold", owner: "(main)", summary: "Choose a sample route…" },
    { id: "release-hold", owner: "(main)", summary: "Publish a sample preview…" },
    { id: "other-task", owner: "other", summary: "Other source row" },
    { id: "source-reason", owner: "(main)", summary: "Source choice", reason: "Upstream reason wins" },
  ]);
  await writeFile(path.join(f.root, "bin/fm-bearings-snapshot.sh"), `#!/bin/sh\ncat <<'SYNTHETIC'\n${JSON.stringify(raw)}\nSYNTHETIC\n`, { mode: 0o755 });
  const enriched = JSON.parse(await createSnapshotRunner(f.root)());
  assert.equal(enriched.decisions_open[0].reason, "Reply 'route A'.");
  assert.equal(enriched.decisions_open[2].reason, undefined);
  assert.equal(enriched.decisions_open[3].reason, "Upstream reason wins");
  assert.equal(await readFile(path.join(f.root, "data/backlog.md"), "utf8"), ledger);
  assert.equal(normalizeSnapshot(enriched).cards.length, 4, "ledger never creates calls");

  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const hub = createBearingsHub({ runner: () => pending, watchRecords: null, fingerprint: null });
  const source = createCallSource({ hub, chat: f.scanner });
  t.after(() => source.close());
  source.touch(); await source.refresh();
  assert.equal(source.current().cards.filter(c => c.type === "chat").length, 2, "chat does not wait for snapshot");
  release(JSON.stringify(enriched));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const model = source.current();
  assert.equal(model.state, "ready");
  assert.equal(model.chat.open, 0);
  assert.equal(model.chat.linked, 2);
  assert.equal(model.cards.filter(c => c.type === "chat").length, 0);
  await source.refresh();
  assert.deepEqual(f.scanner.asks().map(a => a.linkedTasks), [["route-hold", "not-filed", "other-task"], ["release-hold"]], "selected-home ledger holds link even when omitted by the snapshot; snapshot row enrichment still respects owner");
});

test("encoded hold reasons reject closed/noncaptain, duplicate, malformed, oversized and invalid UTF-8 fields", () => {
  const encoded = (id, bytes) => `- [ ] ${id} - Synthetic (hold: fm-hold-v1:${bytes}) (hold-kind: captain)`;
  assert.deepEqual([...backlogHoldReasons([
    hold("closed", "Closed").replace("[ ]", "[x]"),
    hold("noncaptain", "Not captain").replace("hold-kind: captain", "hold-kind: blocked"),
    hold("duplicate", "First"), hold("duplicate", "Second"), hold("duplicate", "Third"),
    encoded("noncanonical", "A==="), encoded("invalid-utf8", Buffer.from([255]).toString("base64")),
    encoded("oversized", Buffer.from("x".repeat(17000)).toString("base64")),
    "- [ ] prose - Text\n  (hold: fm-hold-v1:U2FtcGxl) (hold-kind: captain)",
  ].join("\n"))], []);
});
