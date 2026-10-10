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

test("a Sent card shows the underway label and hatch, and only that state does", async () => {
  const view = await readFile(new URL("../public/bearings-view.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.equal(view.match(/data-call-sent-label hidden>Sent - waiting for Firstmate/g).length, 1);
  assert.match(css, /\.call-card\[data-call-lifecycle="sent"\] \{[^}]*repeating-linear-gradient\(-45deg/);
  assert.match(css, /\.call-sent-label\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.call-answer-fields\[data-sent\] :is\(\.call-opt, select\) \{[^}]*repeating-linear-gradient\(-45deg/);
  assert.match(css, /\.call-answer-fields\[data-sent\] \.call-opt:has\(input:checked\) \{[^}]*box-shadow: inset/);
  assert.match(view, /data-call-answer-summary hidden><h4>Your answer<\/h4>/);
  assert.match(css, /\.call-answer-fields\[data-sent\] textarea \{[^}]*user-select: text/);
  assert.match(app, /underway\.hidden = state !== "sent"/);
});
