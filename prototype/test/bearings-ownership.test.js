import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { normalizeSnapshot } from "../bearings.js";
import { createAnswerRelay } from "../bearings-answer.js";
import { createThreadRelay, formatThreadNote, taggedEnvelope, threadRequestId } from "../bearings-thread.js";
import { createProcrastinationStore } from "../call-procrastination.js";
import { createServer } from "../server.js";
import { callDom } from "./helpers/call-dom.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const receipts = async () => ({ pending: [], handled: [], replies: [] });
const transcript = async () => ({ turns: [], omitted: false });
const snapshot = (decisions_open = [], landed = []) => ({ schema: "fm-bearings.v1", decisions_open, landed,
  contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] });
const decision = (id, owner) => ({ id, owner, summary: "Choose the rollout window", options: [{ value: "blue", label: "Blue" }] });

test("remote decisions display in their own home while local scoped calls keep all controls", async (context) => {
  const model = { state: "ready", ...normalizeSnapshot(snapshot([
    decision("mate/rollout", "mate"), decision("unscoped-remote", "mate"), decision("unknown/rollout"),
    decision("rollout", "(main)"), decision(`${"h".repeat(160)}/local-rollout`, "(main)"),
  ])) };
  const dom = callDom();
  const window = { document: dom.document };
  vm.runInNewContext(await readFile(new URL("../public/bearings-view.js", import.meta.url), "utf8"), { window, URL });
  const sent = [];
  const note = async (_home, id, body) => { sent.push({ id, body }); return { id: `note-${sent.length}`, outcome: "created" }; };
  const relay = createThreadRelay({ home: "/synthetic/home", receipts, transcript, note });
  const answers = createAnswerRelay({ home: "/synthetic/home", receipts, note });
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-ownership-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const env = { FM_QUARTERDECK_STATE_PATH: path.join(root, "presentation.json") };
  const now = () => Date.parse("2026-06-01T00:00:00Z");
  const store = createProcrastinationStore(env, now);
  const revision = "c".repeat(40);
  const server = createServer(env, {
    revisionResolver: { initial: revision, snapshot: async () => revision },
    bearingsSource: { current: () => model, close() {} }, procrastination: store,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/bearings/procrastinate`, { method: "POST",
    headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  let request = 0;
  for (const [index, card] of model.cards.entries()) {
    const node = dom.document.createElement("article");
    node.innerHTML = window.bearingsView.cardHtml(card);
    const remote = index < 3;
    const body = { requestId: uuid(++request), key: card.key, text: "More context?" };
    const answer = { requestId: uuid(++request), key: card.key, cardRev: card.rev, selection: "blue", note: "" };
    if (remote) {
      assert.match(node.textContent, /This call is answered in its own home/);
      assert.equal(node.querySelector("textarea"), null);
      assert.equal(node.querySelector("[data-call-procrastinate]"), null);
      assert.equal(node.querySelector("[data-call-thread-expand]"), null);
      assert.equal(node.querySelector("input"), null);
      assert.equal(card.answer, null);
      await assert.rejects(relay.submit(body, model), (error) => error.code === "read-only");
      await assert.rejects(answers.submit(answer, model), (error) => error.code === "not-answerable");
      for (const action of [{ duration: "3h" }, { clear: true }]) {
        const response = await post({ key: card.key, ...action });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "read-only");
      }
      assert.equal(sent.length, 0);
    } else {
      assert.ok(node.querySelector("textarea"));
      assert.ok(node.querySelector("[data-call-procrastinate]"));
      assert.ok(node.querySelector("[data-call-thread-expand]"));
      const sentThread = await relay.submit(body, model);
      assert.equal(sentThread.key, card.key);
      assert.equal(taggedEnvelope(sent.at(-1).body, "fm-quarterdeck-thread").key, card.key);
      assert.equal((await relay.history(card.key, model)).transcript.state, "ready");
      const sentAnswer = await answers.submit(answer, model);
      assert.equal(sentAnswer.key, card.key);
      const envelope = taggedEnvelope(sent.at(-1).body, "fm-bearings-answer");
      assert.equal(envelope.question, index === 3 ? "rollout" : "local-rollout");
      const saved = await post({ key: card.key, duration: "3h" });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).until[card.key], "2026-06-01T03:00:00.000Z");
      const reloaded = createProcrastinationStore(env, now);
      assert.equal((await reloaded.read()).until[card.key], "2026-06-01T03:00:00.000Z");
      assert.equal((await reloaded.view(new Set(model.cards.map((entry) => entry.key)))).until[card.key], "2026-06-01T03:00:00.000Z");
      const extended = await post({ key: card.key, duration: "6h" });
      assert.equal((await extended.json()).until[card.key], "2026-06-01T09:00:00.000Z");
      assert.equal((await post({ key: card.key, clear: true })).status, 200);
      assert.equal((await reloaded.read()).until[card.key], undefined);
    }
  }
});

test("two remote landings never borrow a local task's transcript or each other's exact-key notes", async () => {
  const model = normalizeSnapshot(snapshot([], [
    { id: "cached-landed", owner: "mate-a", what: "A landed" },
    { id: "cached-landed", owner: "mate-b", what: "B landed" },
    { id: "cached-landed", owner: "(main)", what: "Local landed" },
  ]));
  const [a, b, local] = model.landed;
  const note = { id: "note-a", request_id: threadRequestId(a.key, uuid(1)),
    body: formatThreadNote({ key: a.key, card: a, text: "Explain A", requestId: uuid(1) }) };
  assert.equal(taggedEnvelope(note.body, "fm-quarterdeck-thread").owner, "mate-a");
  let reads = 0;
  const relay = createThreadRelay({ home: "/synthetic/home", receipts: async () => ({ pending: [note], handled: [], replies: [] }),
    transcript: async () => { reads += 1; return { turns: [{ at: "2026-01-02T08:00:00Z", text: "The local cached-landed release is ready." }], omitted: false }; } });
  assert.deepEqual((await relay.history(a.key, model)).entries.map((entry) => entry.text), ["Explain A"]);
  assert.deepEqual((await relay.history(b.key, model)).entries, []);
  assert.equal(reads, 0);
  assert.deepEqual((await relay.history(local.key, model)).entries.map((entry) => entry.text), ["The local cached-landed release is ready."]);
  assert.equal((await relay.history(a.key, { landed: [] })).transcript.state, "not-applicable");
});
