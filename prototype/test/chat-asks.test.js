import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerEnvelope, formatAnswerNote, validateAnswer } from "../bearings-answer.js";
import { createBearingsHub, normalizeSnapshot } from "../bearings.js";
import { chatAsksPath, chatCard, composeCallModel, createCallSource, createChatAskScanner, extractAsks, extractReplies, mentionsTask } from "../chat-asks.js";
import { claudeProjectDirectory } from "../claude-transcript.js";
import { createServer } from "../server.js";

// Synthetic transcripts only: invented ids, tasks and wording.
const T0 = Date.parse("2030-01-02T10:00:00.000Z");
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const firstmate = (id, minutes, text) => JSON.stringify({ type: "assistant", uuid: id, timestamp: at(minutes), message: { role: "assistant", model: "synthetic-model", content: [{ type: "text", text }] } });
const captain = (id, minutes, text) => JSON.stringify({ type: "user", uuid: id, timestamp: at(minutes), message: { role: "user", content: text } });
const lines = (...records) => `${records.join("\n")}\n`;

async function claudeHome(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qd-chat-asks-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const config = path.join(root, "claude");
  await mkdir(path.join(home, "state"), { recursive: true });
  const directory = claudeProjectDirectory(config, home);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(home, "state", ".lock-session"), "session-one\n");
  const transcript = path.join(directory, "session-one.jsonl");
  await writeFile(transcript, "");
  return { root, home, config, transcript, statePath: path.join(root, "private", "agent-state.json") };
}
const scannerFor = (env, options = {}) => createChatAskScanner({ home: env.home, claudeConfigDir: env.config, statePath: chatAsksPath(env.statePath), now: () => T0 + 3600000, discoverEveryMs: 0, ...options });

test("marker grammar: line-start markers tolerant of markdown; mentions, code and lowercase prose are not asks", () => {
  const text = [
    "Status first.",
    "**APPROVAL NEEDED:** Retire the two idle sample workers. Reply **\"retire both\"**. If you wait, nothing changes.",
    "",
    "**DECISION NEEDED** on the sample rollout:",
    "- **Option A:** ship behind a flag",
    "- **Option B:** wait a week. Reply `flag` or `wait`.",
    "",
    "> - ### ACTION NEEDED — rotate the synthetic token; reply: \"rotated\"",
    "We use `ACTION NEEDED` lines for asks; no action needed here.",
    "1. ACTION NEEDED - confirm the sample window (reply “confirm”)",
    "```",
    "APPROVAL NEEDED: this is only an example",
    "```",
    "[fm-lane sample-project]",
    "APPROVAL NEEDED: merge the sample branch. Reply \"merge\" / \"hold\"",
    "[end sample-project]",
    "ACTION NEEDEDX is not a marker",
  ].join("\n");
  const asks = extractAsks(text);
  assert.deepEqual(asks.map((ask) => [ask.kind, ask.replies]), [
    ["approval", ["retire both"]],
    ["decision", ["flag", "wait"]],
    ["action", ["rotated"]],
    ["action", ["confirm"]],
    ["approval", ["merge", "hold"]],
  ]);
  assert.equal(asks[0].text, "Retire the two idle sample workers. Reply \"retire both\". If you wait, nothing changes.");
  assert.equal(asks[1].text, "on the sample rollout:\n- Option A: ship behind a flag\n- Option B: wait a week. Reply `flag` or `wait`.", "a decision keeps its following list");
  assert.equal(asks[2].text.startsWith("rotate the synthetic token"), true);
  assert.deepEqual(extractReplies("Reply with \"a\", \"b\" or `c`; later reply: \"d\". Unquoted reply yes."), ["a", "b", "c", "d"]);
  assert.equal(mentionsTask("Close sample-task.", "sample-task"), true);
  assert.equal(mentionsTask("Close sample-task-two now", "sample-task"), false);
  assert.equal(mentionsTask("see sample-task.md", "sample-task"), false);
});

test("a Firstmate ask surfaces, transcript input that repeats the quoted reply never resolves it, and reads are incremental", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    captain("c-1", 0, "status?"),
    firstmate("f-1", 1, "**APPROVAL NEEDED:** Retire the two idle sample workers. Reply **\"retire both\"**."),
    firstmate("f-2", 2, "**ACTION NEEDED:** Rotate the synthetic token. Reply \"rotated\"."),
    JSON.stringify({ type: "assistant", uuid: "side-1", isSidechain: true, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "APPROVAL NEEDED: a subagent's line" }] } }),
    JSON.stringify({ type: "user", uuid: "hook-1", origin: { kind: "hook" }, timestamp: at(2), message: { role: "user", content: "APPROVAL NEEDED: hook text" } }),
  ));
  const scanner = scannerFor(env);
  assert.equal(await scanner.scan(), true);
  assert.deepEqual(scanner.asks().map((ask) => [ask.kind, ask.replies[0]]), [["approval", "retire both"], ["action", "rotated"]]);
  const keys = scanner.asks().map((ask) => ask.key);

  assert.equal(await scanner.scan(), false, "an unchanged transcript is a stat-only no-op");
  const state = JSON.parse(await readFile(chatAsksPath(env.statePath), "utf8"));
  const cursor = Object.values(state.cursors)[0];
  assert.equal(cursor.offset, (await readFile(env.transcript)).length);

  // A transcript role=user line is unverified input (authorship.js), not the captain's
  // reply: neither a machine envelope nor a matching reply resolves the ask.
  await appendFile(env.transcript, lines(captain("c-2", 3, "FIRSTMATE_OP: retire both"), captain("c-3", 4, "Retire both.")));
  // A trailing partial record is left for the next scan rather than parsed early.
  const partial = firstmate("f-3", 5, "ACTION NEEDED: Restart the sample preview. Reply \"restart\".");
  await appendFile(env.transcript, partial.slice(0, 20));
  await scanner.scan();
  assert.deepEqual(scanner.asks().map((ask) => ask.key), keys);
  assert.equal(Object.values(JSON.parse(await readFile(chatAsksPath(env.statePath), "utf8")).asks).some((ask) => ask.resolvedBy === "reply"), false);
  await appendFile(env.transcript, `${partial.slice(20)}\n${captain("c-4", 6, "rotated")}\n`);
  await scanner.scan();
  assert.deepEqual(scanner.asks().map((ask) => ask.recordId), ["f-1", "f-2", "f-3"]);

  // A fresh process resumes from the persisted cursor without duplicating cards.
  const restarted = scannerFor(env);
  await restarted.scan();
  assert.deepEqual(restarted.asks().map((ask) => ask.recordId), ["f-1", "f-2", "f-3"]);
});

test("keys are stable, dismissals survive a rewritten transcript, re-asks supersede, and backfill skips stale asks", async (context) => {
  const env = await claudeHome(context);
  const ask = firstmate("f-1", 50, "APPROVAL NEEDED: Publish the sample notes. Reply \"publish\".");
  await writeFile(env.transcript, lines(firstmate("f-old", -60 * 24 * 5, "APPROVAL NEEDED: An ask from days ago. Reply \"old\"."), ask));
  const scanner = scannerFor(env);
  await scanner.scan();
  assert.deepEqual(scanner.asks().map((entry) => entry.replies[0]), ["publish"], "backfill leaves asks older than its age bound closed");
  const [key] = scanner.asks().map((entry) => entry.key);
  assert.equal(await scanner.resolve(key, "dismissed"), true);

  // The same record rewritten (new inode) is re-read but never revived.
  await rm(env.transcript);
  await writeFile(env.transcript, lines(ask));
  await scanner.scan();
  assert.deepEqual(scanner.asks(), []);

  // Firstmate repeating an open ask replaces the older card instead of stacking it.
  await appendFile(env.transcript, lines(
    firstmate("f-2", 55, "ACTION NEEDED: Restart the sample preview. Reply \"restart\"."),
    firstmate("f-3", 56, "ACTION NEEDED: Restart the sample preview. Reply \"restart\"."),
  ));
  await scanner.scan();
  assert.deepEqual(scanner.asks().map((entry) => entry.recordId), ["f-3"]);
});

test("transcript input quoting a suggested reply in any case or punctuation leaves asks open", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    captain("before", 0, "archive sample notes"),
    firstmate("case", 1, 'DECISION NEEDED: Choose the sample host. Shortest reply: "keep it on Vega".'),
    captain("case-answer", 2, "keep it on vega"),
    firstmate("long", 3, 'ACTION NEEDED: Retire the sample notes. Reply "archive sample notes".'),
    captain("not-words", 4, "archive sample notesbook"),
    captain("earlier-clock", 2, "archive sample notes"),
  ));
  const scanner = scannerFor(env);
  await scanner.scan();
  assert.deepEqual(scanner.asks().map(ask => ask.recordId), ["case", "long"]);
  await appendFile(env.transcript, lines(captain("long-answer", 5, "Please ARCHIVE\t sample, notes ---- then check the sample preview.")));
  await scanner.scan();
  assert.deepEqual(scanner.asks().map(ask => ask.recordId), ["case", "long"]);
  const restarted = scannerFor(env);
  await restarted.scan();
  assert.deepEqual(restarted.asks().map(ask => ask.recordId), ["case", "long"]);
});

test("same-marker replies supersede older asks despite changed prose, not different markers", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    firstmate("older", 1, 'APPROVAL NEEDED: Retire idle sample workers. Reply "retire both".'),
    firstmate("different-marker", 2, 'ACTION NEEDED: Verify sample workers. Reply "retire both".'),
    firstmate("newer", 3, 'APPROVAL NEEDED: The sample workers are still idle; shortest reply: "RETIRE, both".'),
  ));
  const scanner = scannerFor(env);
  await scanner.scan();
  assert.deepEqual(scanner.asks().map(ask => ask.recordId), ["different-marker", "newer"]);
  await appendFile(env.transcript, lines(captain("answer", 4, "Please retire both -- inspect the logs too.")));
  await scanner.scan();
  assert.deepEqual(scanner.asks().map(ask => ask.recordId), ["different-marker", "newer"], "transcript input never resolves an ask");
});

test("an upgraded scanner replays a bounded window to repair persisted open asks and repeats", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    firstmate("answered", 1, 'ACTION NEEDED: Archive the sample notes. Reply "archive notes".'),
    firstmate("older", 2, 'APPROVAL NEEDED: Publish the sample manual. Reply "publish manual".'),
  ));
  const scanner = scannerFor(env);
  await scanner.scan();
  const legacy = JSON.parse(await readFile(chatAsksPath(env.statePath), "utf8"));
  await appendFile(env.transcript, lines(
    captain("answer", 3, "archive notes --- then inspect the preview"),
    firstmate("newer", 4, 'APPROVAL NEEDED: The sample manual is ready now. Reply "publish manual".'),
  ));
  await scanner.scan();
  const current = JSON.parse(await readFile(chatAsksPath(env.statePath), "utf8"));
  legacy.cursors = current.cursors;
  const latest = Object.values(current.asks).find(ask => ask.recordId === "newer");
  legacy.asks[latest.key] = latest;
  delete legacy.matchingVersion;
  await writeFile(chatAsksPath(env.statePath), JSON.stringify(legacy));
  const upgraded = scannerFor(env);
  await upgraded.scan();
  assert.deepEqual(upgraded.asks().map(ask => ask.recordId), ["answered", "newer"], "the repeat supersedes; transcript input resolves nothing");
  assert.equal(await upgraded.scan(), false, "repair is one-off; idle scans remain cheap");
});

test("oversized records are skipped to their newline without stalling the cursor", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    JSON.stringify({ type: "user", uuid: "big", timestamp: at(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "NEEDED ".repeat(4000) }] } }),
    firstmate("f-1", 1, "DECISION NEEDED: Choose the sample color. Reply \"blue\"."),
  ));
  const scanner = scannerFor(env, { maxLineBytes: 1024, maxScanBytes: 2048 });
  await scanner.scan();
  for (let i = 0; i < 40 && !scanner.asks().length; i += 1) await scanner.scan();
  assert.deepEqual(scanner.asks().map((entry) => entry.kind), ["decision"]);
});

test("the Pi main session pointer is a source; branch sessions are not", async (context) => {
  const env = await claudeHome(context);
  await rm(path.join(env.home, "state", ".lock-session"));
  await rm(env.transcript);
  await mkdir(path.join(env.home, "state", "main-session"), { recursive: true });
  await mkdir(path.join(env.home, "state", "branch-session"), { recursive: true });
  const pi = (id, minutes, role, text) => JSON.stringify({ type: "message", id, timestamp: at(minutes), message: { role, content: [{ type: "text", text }] } });
  await writeFile(path.join(env.home, "state", "main-session", "main.jsonl"), lines(pi("p-1", 1, "assistant", "APPROVAL NEEDED: Land the sample fix. Reply \"land it\".")));
  await writeFile(path.join(env.home, "state", "branch-session", "branch.jsonl"), lines(pi("b-1", 1, "assistant", "APPROVAL NEEDED: branch text")));
  await writeFile(path.join(env.home, "state", ".main-session"), "state/main-session/main.jsonl\n");
  await writeFile(path.join(env.home, "state", ".branch-session"), "state/branch-session/branch.jsonl\n");
  const scanner = scannerFor(env);
  await scanner.scan();
  assert.deepEqual(scanner.asks().map((ask) => [ask.source, ask.recordId]), [["state/main-session/main.jsonl", "p-1"]]);
});

const snapshot = (decisions) => ({ schema: "fm-bearings.v1", generated: at(0), decisions_open: decisions, omitted: [], contributions: { captain: [], known: 1, checked: 1, proven_clear: false } });
const base = (decisions, state = "ready") => ({ schema: "fm-quarterdeck-call.v1", rev: `r-${decisions.length}-${state}`, state, observedAt: at(0), checkedAt: at(0), generatedAt: at(0), stale: state !== "ready", error: null, ...normalizeSnapshot(snapshot(decisions)) });

test("an ask naming a filed hold is shown inside that card, not twice, and resolves when the hold closes", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    firstmate("f-1", 1, "APPROVAL NEEDED: Approve sample-task's rollout. Reply \"approve\"."),
    firstmate("f-2", 2, "ACTION NEEDED: Unfiled sample ask. Reply \"done\"."),
  ));
  const scanner = scannerFor(env);
  await scanner.scan();
  const held = base([{ id: "sample-task", verb: "decide", summary: "Approve the sample rollout", owner: "(main)" }]);
  await scanner.applySnapshot(["sample-task"], true);
  const model = composeCallModel(held, scanner.asks(), scanner.view());
  assert.deepEqual(model.cards.map((card) => card.key), ["decision:sample-task", scanner.asks().find((ask) => ask.recordId === "f-2").key]);
  assert.deepEqual(model.cards[0].chatAsks.map((entry) => entry.replies), [["approve"]]);
  assert.equal(model.chat.linked, 1);
  const again = composeCallModel(held, scanner.asks(), scanner.view());
  assert.equal(again.rev, model.rev, "an unchanged composition keeps its revision");

  // A stale snapshot never closes a linked ask; a fresh one without the hold does.
  await scanner.applySnapshot([], false);
  assert.equal(scanner.asks().length, 2);
  await scanner.applySnapshot([], true);
  assert.deepEqual(scanner.asks().map((ask) => ask.recordId), ["f-2"]);
});

test("filed holds win by quoted replies in titles or reasons without task-id mentions", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    firstmate("choice", 1, 'DECISION NEEDED: Choose a sample plan. Shortest reply: "path 2".'),
    firstmate("release", 2, 'APPROVAL NEEDED: Publish the sample package. Reply "publish the 2.3.4 preview".'),
    firstmate("unquoted", 3, 'APPROVAL NEEDED: Restart a sample server. Reply "restart server".'),
    firstmate("partial", 4, 'DECISION NEEDED: Choose a different sample plan. Reply "path 3".'),
  ));
  const scanner = scannerFor(env);
  const held = base([
    { id: "choice-hold", verb: "decide", summary: "Choose the sample plan", title: "Captain choice: 'PATH 2'", owner: "(main)" },
    { id: "release-hold", verb: "approve", summary: "Release the sample package", reason: 'Waiting for “publish the 2.3.4 preview”', owner: "(main)" },
    { id: "unquoted-hold", verb: "approve", summary: "Please restart server", owner: "(main)" },
    { id: "partial-hold", verb: "decide", summary: 'Choose "path 30"', owner: "(main)" },
  ]);
  const hub = { current: () => held };
  const source = createCallSource({ hub, chat: scanner });
  await source.refresh();
  const model = source.current();
  assert.equal(model.cards.length, 6);
  assert.equal(model.chat.linked, 2);
  assert.deepEqual(model.cards[0].chatAsks.map(ask => ask.replies), [["path 2"]]);
  assert.deepEqual(model.cards[1].chatAsks.map(ask => ask.replies), [["publish the 2.3.4 preview"]]);
  assert.deepEqual(model.cards.filter(card => card.type === "chat").map(card => card.replies), [["path 3"], ["restart server"]]);
  await scanner.applySnapshot([], false);
  assert.equal(scanner.asks().length, 4, "stale disappearance cannot close linked asks");
  await scanner.applySnapshot([], true);
  assert.deepEqual(scanner.asks().map(ask => ask.recordId), ["unquoted", "partial"]);
});

test("chat cards answer through the keyed relay as the captain's own reply, even while the snapshot is unavailable", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(firstmate("f-1", 1, "**APPROVAL NEEDED:** Retire the idle sample workers. Reply **\"retire both\"**.")));
  const scanner = scannerFor(env);
  await scanner.scan();
  const model = composeCallModel(base([], "unavailable"), scanner.asks(), scanner.view());
  const [card] = model.cards;
  assert.equal(card.type, "chat");
  assert.deepEqual(card.answer.options, [{ value: "reply-1", label: "retire both", hint: "Firstmate's suggested reply" }]);
  const valid = validateAnswer({ requestId: "00000000-0000-4000-8000-000000000001", key: card.key, cardRev: card.rev, selection: "reply-1", note: "" }, model);
  const envelope = answerEnvelope(valid, model.rev);
  assert.equal(envelope.selection, "");
  assert.equal(envelope.note, "retire both");
  assert.equal(envelope.question, `chat.${card.key.slice(5)}`);
  assert.match(envelope.ask, /^APPROVAL NEEDED: Retire the idle sample workers/);
  const note = formatAnswerNote(envelope);
  assert.match(note.split("\n")[0], /reply to your chat ask: retire both$/);
  assert.deepEqual(note.split("\n").filter((line) => line.startsWith("```")), ["```json fm-bearings-answer", "```"]);
  assert.throws(() => validateAnswer({ requestId: "00000000-0000-4000-8000-000000000002", key: card.key, cardRev: card.rev, selection: "", note: "x" }, { ...model, chat: { ...model.chat, state: "unavailable" } }), /not current/);
});

test("lettered decision lines are radios, and a quoted reply keeps its own description", () => {
  const sample = (overrides) => ({
    key: "chat:sampleletter", kind: "decision", marker: "DECISION NEEDED",
    text: "Choose the sample window.\na) Staged rollout\nb) Wait a week",
    replies: [], source: "session-one.jsonl", offset: 0, part: 0, at: at(1), ...overrides,
  });
  const lettered = chatCard(sample({}));
  assert.deepEqual(lettered.answer.options, [
    { value: "a", label: "a", hint: "Staged rollout" },
    { value: "b", label: "b", hint: "Wait a week" },
  ]);
  assert.deepEqual(lettered.replies, ["a", "b"]);
  assert.deepEqual(chatCard(sample({ kind: "approval", marker: "APPROVAL NEEDED", key: "chat:approvalletter" })).answer.options, [{ value: "a", label: "a", hint: "Staged rollout" }, { value: "b", label: "b", hint: "Wait a week" }]);
  const described = chatCard(sample({
    key: "chat:described",
    text: 'Choose.\n- "stay on Lyra": continue the current setup\nReply "pause work".',
    replies: ["stay on Lyra", "pause work"],
  }));
  assert.deepEqual(described.answer.options.map((option) => [option.value, option.label, option.hint]), [
    ["reply-1", "stay on Lyra", "continue the current setup"],
    ["reply-2", "pause work", "Firstmate's suggested reply"],
  ]);
  assert.deepEqual(described.replies, ["stay on Lyra", "pause work"]);
  assert.equal(chatCard(sample({ text: 'Choose. Reply "stay".', replies: ["stay"] })).answer.options[0].hint, "Firstmate's suggested reply");
  assert.deepEqual(extractReplies('Reply with "a", "b" or `c`; later reply: "d". Unquoted reply yes.'), ["a", "b", "c", "d"]);
  assert.deepEqual(extractAsks("DECISION NEEDED: pick a sample plan.\n- Option A: ship behind a flag\n- Option B: wait a week. Reply `flag` or `wait`.")[0].replies, ["flag", "wait"]);
  const optionLines = chatCard(sample({ text: "pick a sample plan.\n- Option A: ship behind a flag\n- Option B: wait a week" }));
  assert.deepEqual(optionLines.answer.options.map((option) => [option.value, option.hint]), [["A", "ship behind a flag"], ["B", "wait a week"]]);
  const valid = validateAnswer({ requestId: "00000000-0000-4000-8000-000000000011", key: lettered.key, cardRev: lettered.rev, selection: "a", note: "" }, { state: "ready", cards: [lettered], chat: { state: "ready" } });
  const envelope = answerEnvelope(valid, "model");
  assert.equal(envelope.selection, "");
  assert.equal(envelope.note, "a");
});

test("a filed decision with no options takes lettered lines from a linked decision ask", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(
    firstmate("letters", 1, "DECISION NEEDED: [task:hold-letters] Choose the sample window.\na) Staged rollout\nb) Wait a week"),
    firstmate("approval-letters", 2, "APPROVAL NEEDED: [task:hold-approval] Approve the sample window.\na) yes now\nb) not yet"),
    firstmate("described", 3, 'DECISION NEEDED: [task:hold-described] Choose the sample plan.\n- "stay on Lyra": continue the current setup\n- "pause work": wait for the check'),
    firstmate("structured", 4, "DECISION NEEDED: [task:hold-structured] Keep or change the filed options.\na) staged rollout\nb) wait a week"),
  ));
  const scanner = scannerFor(env);
  await scanner.scan();
  const model = composeCallModel(base([
    { id: "hold-letters", verb: "decide", summary: "Choose the sample window", owner: "(main)" },
    { id: "hold-approval", verb: "approve", summary: "Approve the sample", owner: "(main)" },
    { id: "hold-described", verb: "decide", summary: "Choose the sample plan", owner: "(main)" },
    { id: "hold-structured", verb: "decide", summary: "Keep the filed options", owner: "(main)", options: [{ value: "later", label: "Later", hint: "Not now" }, { value: "now", label: "Now", hint: "Ship" }] },
  ]), scanner.asks(), scanner.view());
  const card = (task) => model.cards.find((entry) => entry.task === task);
  assert.equal(model.chat.linked, 4);
  assert.equal(model.chat.open, 0);
  assert.deepEqual(card("hold-letters").answer.options.map((option) => [option.value, option.hint]), [["a", "Staged rollout"], ["b", "Wait a week"]]);
  assert.deepEqual(scanner.asks().find((ask) => ask.recordId === "letters").replies, []);
  assert.deepEqual(card("hold-approval").answer.options, [{ value: "yes", label: "Yes", hint: "Approve or confirm" }, { value: "no", label: "No", hint: "Reject or discard" }]);
  assert.deepEqual(card("hold-described").answer.options, [{ value: "yes", label: "Yes", hint: "Approve or confirm" }, { value: "no", label: "No", hint: "Reject or discard" }]);
  assert.deepEqual(card("hold-described").chatAsks[0].replyHints, { "stay on Lyra": "continue the current setup", "pause work": "wait for the check" });
  assert.deepEqual(card("hold-structured").answer.options.map((option) => option.value), ["later", "now"]);
});

test("server: a refresh surfaces new asks; dismiss and a confirmed answer resolve them in Quarterdeck state only", async (context) => {
  const env = await claudeHome(context);
  await writeFile(env.transcript, lines(firstmate("f-1", 1, "APPROVAL NEEDED: First sample ask. Reply \"one\".")));
  const hub = createBearingsHub({ runner: async () => JSON.stringify(snapshot([])), watchRecords: null, fingerprint: null });
  const source = createCallSource({ hub, chat: scannerFor(env) });
  const notes = [];
  const relay = { submit: async (body, model) => {
    const valid = validateAnswer(body, model);
    notes.push(formatAnswerNote(answerEnvelope(valid, model.rev)));
    return { state: "accepted", requestId: body.requestId, key: body.key, noteId: "n-1", replay: false, sentAt: at(9), envelope: answerEnvelope(valid, model.rev) };
  } };
  const revision = "c".repeat(40);
  const server = createServer({}, { revisionResolver: { initial: revision, snapshot: async () => revision }, bearingsSource: source, answerRelay: relay });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const read = async () => (await fetch(`${url}/api/bearings`)).json();
  const post = (route, body) => fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json", origin: url }, body: JSON.stringify(body) });

  let model = await read();
  assert.deepEqual(model.cards.map((card) => card.type), ["chat"]);
  await appendFile(env.transcript, lines(firstmate("f-2", 2, "ACTION NEEDED: Second sample ask. Reply \"two\".")));
  model = await read();
  assert.equal(model.cards.length, 2, "a plain refresh evaluates the new transcript lines");
  const [second, first] = model.cards;

  assert.equal((await post("/api/bearings/dismiss", { key: first.key, cardRev: "0".repeat(16) })).status, 409);
  assert.equal((await post("/api/bearings/dismiss", { key: "decision:x", cardRev: first.rev })).status, 400);
  assert.equal((await fetch(`${url}/api/bearings/dismiss`, { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.invalid" }, body: "{}" })).status, 403);
  assert.equal((await post("/api/bearings/dismiss", { key: first.key, cardRev: first.rev })).status, 200);
  assert.deepEqual((await read()).cards.map((card) => card.key), [second.key]);

  const answered = await post("/api/bearings/answer", { requestId: "00000000-0000-4000-8000-000000000003", key: second.key, cardRev: second.rev, selection: "reply-1", note: "" });
  assert.equal(answered.status, 202);
  assert.match(notes[0], /reply to your chat ask: two/);
  assert.deepEqual((await read()).cards, []);
  const state = JSON.parse(await readFile(chatAsksPath(env.statePath), "utf8"));
  assert.equal(state.asks[first.key].resolvedBy, "dismissed");
  assert.equal(state.asks[second.key].resolvedBy, "answered");
  assert.equal(path.relative(env.home, chatAsksPath(env.statePath)).startsWith(".."), true, "state lives outside the Firstmate home");
});
