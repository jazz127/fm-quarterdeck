import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const window = {};
vm.runInNewContext(await readFile(new URL("../public/call-lifecycle.js", import.meta.url), "utf8"), { window });
const life = window.callLifecycle;

function memoryStorage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key) => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function toggle(names) {
  const buttons = names.map((name) => {
    const attrs = new Map([["data-call-lifecycle", name], ["aria-pressed", "false"]]);
    return {
      textContent: "",
      getAttribute: (key) => attrs.get(key) ?? null,
      setAttribute: (key, value) => attrs.set(key, String(value)),
    };
  });
  return { root: { querySelectorAll: () => buttons }, buttons };
}

test("lifecycle priority is procrastinated, then sent, then queued, then active", () => {
  assert.equal(life.derive({}), "active");
  assert.equal(life.derive({ queued: true }), "queued");
  assert.equal(life.derive({ sent: true }), "sent");
  assert.equal(life.derive({ sent: true, queued: true }), "sent");
  assert.equal(life.derive({ procrastinated: true, sent: true, queued: true }), "procrastinated");
  const card = { key: "decision:alpha-call", answered: false };
  assert.equal(life.cardState({ card }), "active");
  assert.equal(life.cardState({ card, answer: { phase: "compose" } }), "active");
  assert.equal(life.cardState({ card, answer: { phase: "refused" } }), "active");
  assert.equal(life.cardState({ card, answer: { phase: "confirm", path: "answer" } }), "queued");
  assert.equal(life.cardState({ card, answer: { phase: "sending", path: "thread" } }), "queued");
  assert.equal(life.cardState({ card, answer: { phase: "failed", path: "answer" } }), "queued");
  assert.equal(life.cardState({ card, answer: { phase: "sent" } }), "sent");
  assert.equal(life.cardState({ card: { ...card, answered: true } }), "sent");
  assert.equal(life.cardState({ card, thread: { entries: [{ kind: "ask", from: "captain" }] } }), "sent");
  assert.equal(life.cardState({ card, thread: { entries: [{ kind: "answer", from: "captain" }] } }), "sent");
  assert.equal(life.cardState({ card, thread: { captainAsked: true } }), "sent");
  assert.equal(life.cardState({ card, thread: { entries: [{ kind: "chat-ask", from: "firstmate" }, { kind: "reply", from: "firstmate" }] } }), "active");
  assert.equal(life.cardState({ card, answer: { phase: "confirm" }, thread: { captainAsked: true } }), "sent");
  assert.equal(life.cardState({ card, answer: { phase: "sent" }, procrastinated: true }), "procrastinated");
  assert.equal(life.cardState({ card, answer: { phase: "confirm" }, procrastinated: true }), "procrastinated");
});

test("receipt posture moves a sent note from unread to acknowledged to active", () => {
  const card = { key: "decision:alpha-call", answered: false };
  const ask = (state, text) => ({ kind: "ask", from: "captain", state, noteId: "note-1", at: "2026-01-02T10:00:00.000Z", text: "Defer. I will want to test this first" });
  const reply = { kind: "reply", from: "firstmate", noteId: "note-1", at: "2026-01-02T10:05:00.000Z", text: "Noted. It stays open for you." };
  const pending = life.delivery({ card, thread: { entries: [ask("waiting")] } });
  assert.equal(pending.posture, "pending");
  assert.equal(life.sentLabel(pending.posture), "Sent - waiting for Firstmate to read");
  assert.equal(life.cardState({ card, thread: { entries: [ask("waiting")] } }), "sent");
  const acknowledged = life.delivery({ card, thread: { entries: [ask("received")] } });
  assert.equal(acknowledged.posture, "acknowledged");
  assert.equal(life.sentLabel(acknowledged.posture), "Firstmate is on it");
  assert.equal(life.cardState({ card, thread: { entries: [ask("received")] } }), "sent");
  const replied = life.delivery({ card, thread: { entries: [ask("replied"), reply] } });
  assert.equal(replied.posture, "replied");
  assert.equal(replied.reply, "Noted. It stays open for you.");
  assert.equal(life.replyBanner(replied.reply), "Firstmate replied: Noted. It stays open for you.");
  assert.equal(life.cardState({ card, thread: { entries: [ask("replied"), reply] } }), "active");
  assert.equal(life.cardState({ card, thread: { entries: [ask("replied"), reply] }, procrastinated: true }), "procrastinated");
  const followUp = life.delivery({ card, thread: { entries: [ask("replied"), reply, { kind: "ask", from: "captain", state: "waiting", at: "2026-01-02T11:00:00.000Z", text: "One more note" }] } });
  assert.equal(followUp.posture, "pending");
  assert.equal(life.cardState({ card, thread: { entries: [ask("replied"), reply], captainAsked: true } }), "sent");
});

test("an answer receipt and the card receipt use the same three postures", () => {
  const card = { key: "decision:alpha-call" };
  const accepted = life.delivery({ card, answer: { phase: "sent", receipt: { state: "accepted" } } });
  assert.equal(accepted.posture, "pending");
  assert.equal(accepted.reply, "");
  assert.equal(life.cardState({ card, answer: { phase: "sent", receipt: { state: "received" } } }), "sent");
  assert.equal(life.sentLabel("acknowledged"), "Firstmate is on it");
  const answered = life.delivery({ card, answer: { phase: "sent", sentAt: "2026-01-02T12:00:00.000Z", receipt: { state: "replied", reply: "Holding until Tuesday" } } });
  assert.equal(answered.posture, "replied");
  assert.equal(life.replyBanner(answered.reply), "Firstmate replied: Holding until Tuesday");
  assert.equal(life.cardState({ card, answer: { phase: "compose", heldReply: "Holding until Tuesday", heldAt: "2026-01-02T12:00:00.000Z" } }), "active");
  assert.equal(life.delivery({ card: { ...card, sentReceipt: "acknowledged" } }).posture, "acknowledged");
  assert.equal(life.delivery({ card: { ...card, answered: true } }).posture, "pending");
  assert.equal(life.delivery({ card: { ...card, sentReceipt: "replied", sentReply: "Done for now" } }).reply, "Done for now");
  assert.equal(life.cardState({ card: { ...card, sentReceipt: "replied", sentReply: "Done for now" } }), "active");
  assert.equal(life.replyBanner(""), "Firstmate replied");
  assert.equal(life.cardState({ card: { key: "decision:closed" } }), "active", "a call with no captain note is not Sent; a closed call is absent");
});

test("BEARINGS lifecycle keeps an older tab receipt behind a newer captain note", () => {
  for (const kind of ["answer", "ask"]) {
    for (const receiptState of ["received", "replied"]) {
      for (const at of ["2026-01-02T11:00:00.000Z", null]) {
        const latest = { kind, from: "captain", noteId: "new-note", state: "waiting", at };
        const answer = { phase: "sent", noteId: "old-note", sentAt: "2026-01-02T10:00:00.000Z", receipt: { state: receiptState, reply: "Old reply" } };
        const facts = { answer, thread: { entries: [latest] } };
        assert.equal(life.delivery(facts).posture, "pending");
        assert.equal(life.delivery(facts).reply, "");
        assert.equal(life.sentLabel(life.delivery(facts).posture), "Sent - waiting for Firstmate to read");
        assert.equal(life.cardState(facts), "sent");
      }
    }
  }
});

test("BEARINGS lifecycle reconciles the same note and a send not yet in history", () => {
  const latest = { kind: "answer", from: "captain", noteId: "same-note", state: "waiting", at: "2026-01-02T10:00:00.000Z" };
  const answer = { phase: "sent", noteId: "same-note", sentAt: latest.at, receipt: { state: "received" } };
  assert.equal(life.delivery({ answer, thread: { entries: [latest] } }).posture, "acknowledged");
  answer.receipt = { state: "replied", reply: "" };
  const staleReply = { kind: "reply", from: "firstmate", noteId: "older-note", text: "Old reply" };
  assert.equal(life.delivery({ answer, thread: { entries: [staleReply, latest] } }).reply, "");
  assert.equal(life.delivery({ answer, thread: { entries: [staleReply, latest] } }).posture, "replied");
  const held = { phase: "compose", heldNoteId: answer.noteId, heldAt: answer.sentAt, heldReply: "" };
  assert.equal(life.delivery({ answer: held, thread: { entries: [latest] } }).posture, "replied");
  const newer = { ...answer, noteId: "new-note", sentAt: "2026-01-02T11:00:00.000Z", receipt: { state: "accepted" } };
  assert.equal(life.delivery({ answer: newer, thread: { entries: [{ ...latest, state: "replied" }] } }).posture, "pending");
});

test("empty or absent latest replies never display a different note's reply", () => {
  const old = { kind: "answer", from: "captain", noteId: "old-note", state: "replied", at: "2026-01-02T10:00:00.000Z" };
  const oldReply = { kind: "reply", from: "firstmate", noteId: old.noteId, text: "Old reply" };
  const latest = { ...old, noteId: "new-note", at: "2026-01-02T11:00:00.000Z" };
  for (const reply of [null, { kind: "reply", from: "firstmate", noteId: latest.noteId, text: "" }]) {
    const entries = [old, oldReply, latest, ...(reply ? [reply] : [])];
    for (const answer of [null,
      { phase: "sent", noteId: latest.noteId, sentAt: latest.at, receipt: { state: "replied", reply: "Stale local text" } },
      { phase: "compose", heldNoteId: old.noteId, heldAt: old.at, heldReply: oldReply.text }]) {
      const facts = { answer, thread: { entries } };
      assert.equal(life.delivery(facts).posture, "replied");
      assert.equal(life.delivery(facts).reply, "");
      assert.equal(life.replyBanner(life.delivery(facts).reply), "Firstmate replied");
      assert.equal(life.cardState(facts), "active");
    }
  }
});

test("status counts and the remembered filter default to Active", () => {
  const tally = life.counts(["active", "active", "queued", "sent", "procrastinated"]);
  assert.deepEqual({ ...tally }, { active: 2, queued: 1, sent: 1, procrastinated: 1, all: 5 });
  assert.equal(life.emptyText("active", tally), "");
  assert.equal(life.emptyText("queued", { active: 1, queued: 0, sent: 0, procrastinated: 0, all: 1 }), "No Queued cards.");
  assert.equal(life.emptyText("all", { active: 0, queued: 0, sent: 1, procrastinated: 0, all: 1 }), "");
  assert.equal(life.emptyText("active", life.counts([])), "");
  assert.equal(life.visible("queued", "active"), false);
  assert.equal(life.visible("queued", "queued"), true);
  assert.equal(life.visible("sent", "all"), true);

  const storage = memoryStorage();
  assert.equal(life.readFilter(storage), "active");
  assert.equal(life.readFilter(memoryStorage({ [life.STORAGE_KEY]: "nope" })), "active");
  assert.equal(life.writeFilter(storage, "sent"), "sent");
  assert.equal(life.readFilter(storage), "sent");
  assert.equal(storage.getItem(life.STORAGE_KEY), "sent");
  assert.equal(life.writeFilter(storage, "later"), "sent", "an unknown choice does not replace the stored filter");
  assert.equal(life.writeFilter(memoryStorage(), "all"), "all");

  const thrown = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(life.readFilter(thrown), "active");
  assert.equal(life.writeFilter(thrown, "queued"), "queued");

  const controls = toggle(life.FILTERS);
  life.paintToggle(controls.root, tally, "queued");
  assert.deepEqual([...controls.buttons].map((button) => [String(button.textContent), String(button.getAttribute("aria-pressed"))]), [
    ["Active (2)", "false"],
    ["Queued (1)", "true"],
    ["Sent (1)", "false"],
    ["Procrastinated (1)", "false"],
    ["All (5)", "false"],
  ]);
  life.paintToggle(controls.root, tally, "queued");
  assert.equal(controls.buttons[1].textContent, "Queued (1)");
});

function sendButton() {
  const attrs = new Map();
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    getAttribute: (key) => attrs.get(key) ?? null,
    setAttribute: (key, value) => attrs.set(key, String(value)),
  };
}

test("Send queued is only on Active, counts staged answers, and disables while sending", () => {
  const view = (options) => JSON.parse(JSON.stringify(life.sendQueuedControl(options)));
  assert.deepEqual(view({ filter: "active", count: 0 }), { hidden: true, disabled: false, text: "Send queued (0)", label: "Send 0 queued Captain's Call answers" });
  assert.equal(life.sendQueuedControl({ filter: "queued", count: 3 }).hidden, true);
  assert.equal(life.sendQueuedControl({ filter: "sent", count: 3 }).hidden, true);
  assert.equal(life.sendQueuedControl({ filter: "procrastinated", count: 1 }).hidden, true);
  assert.equal(life.sendQueuedControl({ filter: "all", count: 4 }).hidden, true);
  assert.deepEqual(view({ filter: "active", count: 2 }), { hidden: false, disabled: false, text: "Send queued (2)", label: "Send 2 queued Captain's Call answers" });
  assert.deepEqual(view({ filter: "active", count: 1, sending: true }), { hidden: false, disabled: true, text: "Send queued (1)", label: "Sending 1 queued Captain's Call answer" });
  assert.equal(life.sendQueuedControl({ filter: "active", count: 2.8 }).text, "Send queued (2)");
  assert.equal(life.sendQueuedControl({ filter: "active", count: -4 }).hidden, true);

  const button = sendButton();
  life.paintSendQueued(button, { filter: "active", count: 2, sending: false });
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Send queued (2)");
  assert.equal(button.getAttribute("aria-label"), "Send 2 queued Captain's Call answers");
  life.paintSendQueued(button, { filter: "active", count: 2, sending: true });
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("aria-label"), "Sending 2 queued Captain's Call answers");
  life.paintSendQueued(button, { filter: "queued", count: 2 });
  assert.equal(button.hidden, true);
  life.paintSendQueued(null, { filter: "active", count: 2 });
});
