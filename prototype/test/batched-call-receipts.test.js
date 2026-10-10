import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../server.js";
import { taggedEnvelope } from "../bearings-thread.js";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Use the default server/composed source and guarded inbox adapter, not an injected
// bearings source. Only the Firstmate executables and their data are synthetic.
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qd-call-receipts-"));
  const home = path.join(directory, "home");
  for (const dir of ["bin", "data", "state"]) await mkdir(path.join(home, dir), { recursive: true });
  const snapshot = JSON.parse(await readFile(new URL("./fixtures/bearings/two-calls.json", import.meta.url), "utf8"));
  await writeFile(path.join(home, "snapshot.json"), JSON.stringify(snapshot));
  await writeFile(path.join(home, "receipts.json"), JSON.stringify({ schema: "fm-inbox-receipts.v1", pending: [], handled: [], replies: [] }));
  await writeFile(path.join(home, "bin/fm-bearings-snapshot.sh"), '#!/bin/sh\ncat "$FM_HOME/snapshot.json"\n');
  await writeFile(path.join(home, "bin/fm-inbox.sh"), '#!/bin/sh\nexec node "$FM_HOME/inbox.mjs" "$@"\n');
  for (const name of ["fm-bearings-snapshot.sh", "fm-inbox.sh"]) await chmod(path.join(home, "bin", name), 0o755);
  await writeFile(path.join(home, "inbox.mjs"), `
import { readFile, writeFile } from "node:fs/promises";
const file = process.env.FM_HOME + "/receipts.json";
const data = JSON.parse(await readFile(file, "utf8"));
if (process.argv[2] === "receipts") console.log(JSON.stringify(data));
else if (process.argv[2] === "note") {
  let body = ""; for await (const chunk of process.stdin) body += chunk;
  const request_id = process.argv[4];
  const note = { id: "note-" + (data.pending.length + data.handled.length + 1), request_id, body, at: new Date().toISOString() };
  data.pending.push(note);
  await writeFile(file, JSON.stringify(data));
  console.log(JSON.stringify({ schema: "fm-inbox-note.v1", ...note, saved: true, announced: true, outcome: "created" }));
} else process.exit(2);
`);
  let server, base;
  async function restart() {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(directory, "state.json"), CLAUDE_CONFIG_DIR: path.join(directory, "claude") }, {
      revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    server.bearings.subscribe(() => {});
    for (let n = 0; n < 100 && server.bearings.current().state !== "ready"; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.bearings.current().state, "ready");
  }
  t.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const get = async (route) => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };
  const receipts = async () => JSON.parse(await readFile(path.join(home, "receipts.json"), "utf8"));
  const saveReceipts = async (data) => writeFile(path.join(home, "receipts.json"), JSON.stringify(data));
  await restart();
  return { get, post, restart, receipts, saveReceipts };
}

for (const combined of [false, true]) test(`${combined ? "combined" : "individual"} submissions retain per-call answers through pending, acknowledgement and reply`, async (t) => {
  const f = await fixture(t);
  const before = await f.get("/api/bearings");
  const calls = before.cards.filter((card) => card.type === "decision").slice(0, combined ? 2 : 1);
  assert.equal(calls.length, combined ? 2 : 1);
  const submissions = calls.map((card, index) => ({ requestId: uuid(index + 1), key: card.key, cardRev: card.rev, selection: "", note: `Answer ${index + 1}\nKeep the example-app context.` }));
  const sends = submissions.map((body) => f.post("/api/bearings/answer", body));
  let pending;
  for (let n = 0; n < 100; n++) {
    pending = await f.get("/api/inbox/pending");
    if (pending.items.length === calls.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(pending.items.map((item) => item.key).sort(), calls.map((card) => card.key).sort());
  assert.ok((await f.get("/api/bearings")).cards.every((card) => !card.answered), "saved work is queued until durable inbox intake");
  await f.post("/api/inbox/send-now", {});
  const accepted = await Promise.all(sends);
  assert.ok(accepted.every((answer) => answer.noteId === accepted[0].noteId));
  assert.deepEqual((await f.get("/api/inbox/pending")).items, []);
  const receipts = await f.receipts();
  assert.equal(receipts.pending.length, 1, "one guarded inbox note and wake");
  const outer = receipts.pending[0];
  const batch = taggedEnvelope(outer.body, "fm-quarterdeck-batch");
  const items = combined ? batch.items : [{ requestId: outer.request_id, text: outer.body }];
  assert.equal(outer.request_id.startsWith("quarterdeck-batch:"), combined);
  for (const [index, item] of items.entries()) {
    assert.equal(item.requestId, `quarterdeck-call:${submissions[index].requestId}`);
    const envelope = taggedEnvelope(item.text, "fm-bearings-answer");
    assert.equal(envelope.note, submissions[index].note);
    assert.equal(envelope.task, calls[index].task);
    assert.equal(envelope.question, calls[index].answer.question);
    assert.equal(envelope.cardRev, calls[index].rev);
  }
  async function check(posture) {
    await f.restart(); // Recover saved membership; also read fresh receipt evidence.
    const model = await f.get("/api/bearings");
    for (const card of calls) {
      const updated = model.cards.find((entry) => entry.key === card.key);
      assert.equal(updated.answered, true, card.key);
      assert.equal(updated.sentReceipt, posture, card.key);
      assert.equal(updated.sentReply, posture === "replied" ? "Both answers recorded." : undefined);
      const history = await f.get(`/api/bearings/thread?key=${encodeURIComponent(card.key)}`);
      assert.equal(history.entries.filter((entry) => entry.kind === "answer").length, 1);
    }
    for (const card of model.cards.filter((entry) => !calls.some((call) => call.key === entry.key))) {
      assert.equal(card.answered, undefined, "unanswered calls remain independent");
      assert.equal(card.sentReceipt, undefined);
    }
  }
  await check("pending");
  await f.saveReceipts({ ...receipts, pending: [], handled: [outer] });
  await check("acknowledged");
  await f.saveReceipts({ ...receipts, pending: [], handled: [outer], replies: [{ id: outer.id, body: "Both answers recorded." }] });
  await check("replied");
  if (combined) {
    const thread = f.post("/api/bearings/thread", { requestId: uuid(3), key: calls[0].key, text: "Please check only this call." });
    for (let n = 0; n < 100; n++) {
      if ((await f.get("/api/inbox/pending")).items.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await f.post("/api/inbox/send-now", {});
    await thread;
    await f.restart();
    const model = await f.get("/api/bearings");
    const first = model.cards.find((card) => card.key === calls[0].key);
    const second = model.cards.find((card) => card.key === calls[1].key);
    assert.equal(first.answered, true, "a follow-up preserves the original answer");
    assert.equal(first.sentReceipt, "pending", "only the call with a new thread note waits again");
    assert.equal(second.sentReceipt, "replied");
    const status = await f.get(`/api/bearings/answer/status?ids=${submissions.map((item) => item.requestId).join(",")}`);
    assert.ok(Object.values(status.answers).every((answer) => answer.state === "replied"), "answer receipts remain independent of follow-up posture");
    const data = await f.receipts();
    const followup = data.pending[0];
    await f.saveReceipts({ ...data, pending: [], handled: [...data.handled, followup] });
    await f.restart();
    const acknowledged = await f.get("/api/bearings");
    assert.equal(acknowledged.cards.find((card) => card.key === calls[0].key).sentReceipt, "acknowledged");
    assert.equal(acknowledged.cards.find((card) => card.key === calls[1].key).sentReceipt, "replied");
  }
});
