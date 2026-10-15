import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { chatCard, composeCallModel, createChatAskScanner, emptyChatState, extractAsks, memoryStateFile } from "../chat-asks.js";
import { shortHash } from "../bearings.js";
import { validateAnswer, answerEnvelope } from "../bearings-answer.js";

const now = Date.parse("2030-01-02T10:00:00Z");
async function scan(t, records, store = memoryStateFile()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const scanner = createChatAskScanner({ home: root, store, now: () => now,
    discover: async () => ({ sources: [{ file, source: "main-pi-session/synthetic.jsonl", origin: "pi" }], warnings: [] }) });
  await scanner.scan();
  return scanner;
}
const record = (id, content, role = "assistant") => ({ type: "message", id, timestamp: new Date(now).toISOString(), message: { role, content } });
const textPart = (text) => ({ type: "text", text });
const base = { cards: [], coverage: {}, omitted: [], state: "ready" };

test("same original part only; preceding paragraphs survive while summary, revision and routing stay exact", async (t) => {
  const marker = 'DECISION NEEDED: Choose the sample recovery path.';
  const prefix = 'The sample folder cannot be read.\n\nPlan A keeps recovery state; reply "invented" is context, not an option.\n\n';
  const scanner = await scan(t, [record("prior", "Not this earlier message."), record("question", [
    textPart("Not this earlier text part."), { type: "thinking", thinking: "Not thinking." }, textPart(prefix + marker),
    textPart("Not this later text part."),
  ]), record("later", "The prior question is superseded; choose A.", "user")]);
  const [ask] = scanner.asks();
  assert.equal(ask.part, 2);
  assert.equal(ask.sourceContext.text, prefix.replace(/\s+/g, " ").trim());
  assert.deepEqual(extractAsks(prefix + marker), extractAsks(marker), "canonical extraction is identical");
  assert.equal(ask.key, `chat:${shortHash(["question", 2, marker])}`);
  const card = chatCard(ask);
  const { sourceContext, ...identity } = card;
  assert.equal(card.rev, shortHash(Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "rev"))));
  assert.deepEqual(card.answer.options, [], "context cannot invent radios");
  assert.deepEqual(card, { ...chatCard({ ...ask, sourceContext: undefined }), sourceContext });
  const withReply = chatCard({ ...ask, text: 'Choose. Reply "keep".', replies: ["keep"] });
  const payload = { requestId: "00000000-0000-4000-8000-000000000010", key: withReply.key, cardRev: withReply.rev, selection: "reply-1", note: "" };
  const model = { ...base, cards: [withReply], chat: { state: "ready" } };
  const envelope = answerEnvelope(validateAnswer(payload, model), "model");
  assert.equal(envelope.question, `chat.${ask.key.slice(5)}`);
  assert.equal(envelope.note, "keep");
  assert.equal(JSON.stringify(envelope).includes("recovery state"), false);
  assert.equal(ask.status, "open", "later unverified input never auto-closes the ask");
});

test("siblings have independent context; bounded/absent context and path reduction are explicit", async (t) => {
  const long = "x".repeat(4500) + " nearest preceding evidence";
  const scanner = await scan(t, [record("siblings", [textPart(
    `First explanation.\n\nACTION NEEDED: First ask.\n\nSecond explanation.\n\nAPPROVAL NEEDED: Second ask.\n\nDECISION NEEDED: Third ask.`),
    textPart(`Dropped prefix. ${long}\n\nACTION NEEDED: Fourth ask.`),
    textPart("Path /srv/synthetic/private/folder.txt\n\nACTION NEEDED: Fifth ask.")])]);
  const asks = scanner.asks();
  assert.equal(asks.length, 5);
  assert.deepEqual(asks.slice(0, 3).map((ask) => ask.sourceContext.text), ["First explanation.", "Second explanation.", null]);
  assert.equal(asks[3].sourceContext.text.length, 4000);
  assert.equal(asks[3].sourceContext.limited, true);
  assert.equal(asks[3].sourceContext.text.endsWith("nearest preceding evidence"), true);
  assert.equal(asks[4].sourceContext.text, "Path …/folder.txt");
  await scanner.resolve(asks[0].key, "dismissed");
  assert.deepEqual(scanner.asks().map((ask) => ask.key), asks.slice(1).map((ask) => ask.key));
});

test("linked asks attribute each excerpt without changing filed-card identity; stored absence stays honest", async (t) => {
  const scanner = await scan(t, [record("linked", "Recorded explanation.\n\nDECISION NEEDED: [task:sample-hold] Choose. Reply \"keep\".")]);
  const [ask] = scanner.asks();
  const filed = { key: "decision:sample-hold", task: "sample-hold", type: "decision", summary: "Filed summary", answer: { options: [] }, rev: "base" };
  const model = composeCallModel({ ...base, cards: [filed] }, [ask], scanner.view());
  assert.equal(model.cards.length, 1);
  const card = model.cards[0];
  assert.equal(card.summary, "Filed summary");
  assert.equal(card.chatAsks[0].sourceContext.text, "Recorded explanation.");
  assert.equal(card.chatAsks[0].sourceContext.part, 0);
  const withoutContext = { ...card, chatAsks: card.chatAsks.map(({ sourceContext, ...entry }) => entry) };
  delete withoutContext.rev;
  assert.equal(card.rev, shortHash(withoutContext));
  const state = emptyChatState();
  state.asks[ask.key] = { ...ask };
  delete state.asks[ask.key].sourceContext;
  const old = await scan(t, [record("linked", "Recorded explanation.\n\nDECISION NEEDED: [task:sample-hold] Choose. Reply \"keep\".")], memoryStateFile(state));
  assert.equal(chatCard(old.asks()[0]).sourceContext.captured, false);
});

test("standard renderer escapes source text and discloses limited, absent and uncaptured evidence", async () => {
  const window = {};
  vm.runInNewContext(await readFile(new URL("../public/bearings-view.js", import.meta.url), "utf8"), { window });
  const ask = { key: "chat:sample", kind: "action", marker: "ACTION NEEDED", text: "Canonical ask", replies: [], source: "main-pi-session/synthetic.jsonl", part: 2, offset: 123, at: new Date(now).toISOString(), sourceContext: { text: '<script>not executable</script> & "literal"', limited: true } };
  const html = window.bearingsView.cardHtml(chatCard(ask));
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.match(html, /Limited excerpt: only the last 4000/);
  assert.match(html, /main-pi-session · record byte 123 · text part 3/);
  assert.match(window.bearingsView.cardHtml(chatCard({ ...ask, sourceContext: { text: null, limited: false } })), /No preceding text/);
  assert.match(window.bearingsView.cardHtml(chatCard({ ...ask, sourceContext: undefined })), /not captured/);
});
