import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSnapshot } from "../bearings.js";
import { answerEnvelope, validateAnswer } from "../bearings-answer.js";
import { prefixHold, prefixReason, binaryQuestionReasons } from "./helpers/prefix-hold.js";

const values = model => model.cards[0].answer?.options.map(option => option.value);
const choice = (value, label = value) => ({ value, label });

test("complete selected-home canonical Yes/No prefix supplies existing options without changing hold identity", async () => {
  const { model, raw } = await prefixHold();
  const card = model.cards[0];
  assert.deepEqual(card.answer.options, [{ value: "yes", label: "Yes", hint: null }, { value: "no", label: "No", hint: null }]);
  assert.equal(card.reason, prefixReason);
  assert.equal(card.backlogReason, prefixReason);
  assert.equal(card.task, "sample-call");
  assert.equal(card.clock.at, "2030-01-02T10:00:00.000Z");
  const before = structuredClone(raw); delete before.decisions_open[0].options;
  const original = normalizeSnapshot(before).cards[0];
  assert.equal(card.holdVersion, original.holdVersion);
  assert.deepEqual(card.clock, original.clock);
  assert.equal(card.answer.recommend, null);
  assert.equal(card.answer.close, null);
  for (const selection of ["yes", "no"]) {
    const body = { requestId: "00000000-0000-4000-8000-000000000001", key: card.key, cardRev: card.rev, ...(card.holdVersion ? { holdVersion: card.holdVersion } : {}), selection, note: "" };
    const accepted = validateAnswer(body, model);
    const envelope = answerEnvelope(accepted, model.rev);
    assert.equal(envelope.selection, selection);
    assert.equal(envelope.task, card.task);
    assert.equal(envelope.holdVersion, card.holdVersion);
    assert.equal(envelope.cardRev, card.rev);
    for (const [patch, current, code] of [
      [{ selection: "maybe" }, model, "bad-option"],
      [{ key: "decision:other-call" }, model, "gone"],
      [{ cardRev: "0".repeat(16) }, model, "changed"],
      [{}, { ...model, state: "stale" }, "not-current"],
      [{}, { ...model, cards: [{ ...card, answer: null }] }, "not-answerable"],
    ]) assert.throws(() => validateAnswer({ ...body, ...patch }, current), error => error.code === code);
  }
});

test("canonical binary held questions offer both choices even with only a No consequence", async () => {
  for (const reason of [...binaryQuestionReasons, "Should we archive sample notes?", "Can the sample notes be archived?", "Is the sample preview acceptable?", "Should we archive sample notes? No: keep copies. Yes: archive copies.", "SHOULD we archive sample notes? Yes: archive copies."]) {
    const { model, raw } = await prefixHold({ reason });
    const card = model.cards[0];
    assert.deepEqual(values(model), ["yes", "no"], reason);
    assert.equal(card.reason, reason);
    assert.equal(card.backlogReason, reason);
    const withoutOptions = structuredClone(raw); delete withoutOptions.decisions_open[0].options;
    const original = normalizeSnapshot(withoutOptions).cards[0];
    assert.equal(card.task, original.task);
    assert.equal(card.holdVersion, original.holdVersion);
    assert.deepEqual(card.clock, original.clock);
    assert.equal(card.answer.recommend, null);
    assert.equal(card.answer.close, null);
    for (const selection of ["yes", "no"]) {
      const body = { requestId: "00000000-0000-4000-8000-000000000001", key: card.key, cardRev: card.rev, ...(card.holdVersion ? { holdVersion: card.holdVersion } : {}), selection, note: "" };
      const envelope = answerEnvelope(validateAnswer(body, model), model.rev);
      assert.equal(envelope.selection, selection);
      assert.equal(envelope.task, card.task);
      assert.equal(envelope.holdVersion, card.holdVersion);
      assert.equal(envelope.cardRev, card.rev);
      for (const [patch, current, code] of [
        [{ selection: "proceed" }, model, "bad-option"],
        [{ key: "decision:other-call" }, model, "gone"],
        [{ cardRev: "0".repeat(16) }, model, "changed"],
        [{}, { ...model, state: "stale" }, "not-current"],
        [{}, { ...model, cards: [{ ...card, answer: null }] }, "not-answerable"],
      ]) assert.throws(() => validateAnswer({ ...body, ...patch }, current), error => error.code === code);
    }
  }
});

test("question fallback preserves explicit choices, invalid refusal and canonical home provenance", async () => {
  const reason = binaryQuestionReasons[0];
  for (const options of [[choice("later")], [choice("reconcile")], [choice("bad value")], [choice("same"), choice("same")], { yes: "Yes" }]) {
    assert.deepEqual(values((await prefixHold({ reason, row: { options } })).model), Array.isArray(options) && options[0].value === "later" ? ["later"] : []);
  }
  assert.deepEqual(values((await prefixHold({ reason: `${reason}\na) Archive\nb) Keep` })).model), ["a", "b"]);
  const board = { schema: "fm-bearings-board.v1", home: "synthetic-home", generated: "2030-01-02T11:00:00Z",
    captains_call: [{ key: "sample-call", type: "decision", options: [choice("stage"), choice("wait")] }] };
  assert.deepEqual(values((await prefixHold({ reason, board })).model), ["stage", "wait"]);
  assert.deepEqual(values((await prefixHold({ reason, board: { ...board, generated: "2030-01-01T11:00:00Z" } })).model), ["yes", "no"]);
  for (const field of ["reason", "backlogReason", "title", "backlogTitle", "summary", "body"]) {
    assert.deepEqual(values((await prefixHold({ reason: "No choices recorded.", row: { [field]: reason } })).model), [], field);
  }
  for (const row of [{ owner: "child-home" }, { id: "other-call" }]) {
    assert.deepEqual(values((await prefixHold({ reason, row })).model) || [], []);
  }
  assert.deepEqual(values((await prefixHold({ reason, checked: true })).model), []);
});

test("question grammar refuses incomplete, truncated, quoted, conditional and genuinely nonbinary reasons", async () => {
  for (const reason of [
    "Should?", "Should we?", "Should we archive sample notes", "Should we archive sample…?", "Should we archive sample...?",
    '"Should we archive sample notes?"', "Example: Should we archive sample notes?", "We discussed: Should we archive sample notes?",
    "If approved, should we archive sample notes?", "Should we archive sample notes if approved?", "Should we archive sample notes? If yes, use the sandbox.",
    "Which sample should we archive?", "Should we archive or retain sample notes?", "Should we archive sample notes? Maybe: keep copies.",
    "Should we archive sample notes? Yes: archive. No: retain. Later: defer.", "Should we archive sample notes? Yes: archive. Yes: retain.",
    "Should we archive sample notes? No:", "Should we archive sample notes? Yes: No: retain.", "Should we archive sample notes?\nNo: retain.",
    "Should we archive sample notes? Yes: archive or retain.", 'Should we archive sample notes? Reply "stage" or "wait".',
    "Should we archive sample notes? Who should do it?", "Should we archive sample notes? a) Archive a) Retain",
    "Should we choose a) archive b) retain?", "Should we choose a) archive a) retain?", "Should we choose a. archive b. retain?", "Should we archive sample\u0000notes?", "Should we archive sample\u2028notes?", "Should we -- ?",
  ]) assert.deepEqual(values((await prefixHold({ reason })).model), [], reason);
});

test("prefix fallback preserves structured, lettered and fresh board precedence and invalid refusal", async () => {
  for (const options of [[choice("later")], [choice("reconcile")], [choice("bad value")], [choice("same"), choice("same")]]) {
    const { model } = await prefixHold({ row: { options } });
    assert.deepEqual(values(model), options[0].value === "later" ? ["later"] : []);
  }
  const lettered = await prefixHold({ reason: `${prefixReason}\na) Archive\nb) Keep` });
  assert.deepEqual(values(lettered.model), ["a", "b"]);
  const inSummary = await prefixHold({ row: { summary: "Choose:\na) Stage\nb) Wait" } });
  assert.deepEqual(values(inSummary.model), ["a", "b"]);
  const board = { schema: "fm-bearings-board.v1", home: "synthetic-home", generated: "2030-01-02T11:00:00Z",
    captains_call: [{ key: "sample-call", type: "decision", options: [choice("stage"), choice("wait")] }] };
  assert.deepEqual(values((await prefixHold({ board })).model), ["stage", "wait"]);
  assert.deepEqual(values((await prefixHold({ board: { ...board, generated: "2030-01-01T11:00:00Z" } })).model), ["yes", "no"]);
  assert.deepEqual(values((await prefixHold({ board: { ...board, captains_call: [{ ...board.captains_call[0], key: "other-call" }] } })).model), ["yes", "no"]);
});

test("no prefix choices from generic, conditional, quoted, example, empty, variant, truncated or competing prose", async () => {
  for (const reason of [
    "Archive sample notes?", "On yes, archive sample notes.", "If approved, archive sample notes.",
    '"Yes/No: archive sample notes."', "Example: Yes/No: archive sample notes.", "Please answer Yes/No: archive sample notes.",
    "Yes/No:", "Yes/No:   ", "Yes/No: archive sample…", "Yes/No: archive sample...", "yes/no: archive sample notes.",
    "Yes / No: archive sample notes.", 'Yes/No: archive sample notes. Reply "ship" or "wait".',
    "Yes/No: choose ship or wait.", "Yes/No: archive sample notes.\nShip: archive\nWait: retain",
    "Yes/No: archive sample notes.\na) Archive\na) Wait",
  ]) assert.deepEqual(values((await prefixHold({ reason })).model), [], reason);
});

test("only canonical selected-home reason can supply prefix options, not snapshot fields or another task/home", async () => {
  for (const field of ["reason", "backlogReason", "title", "backlogTitle", "summary", "body"]) {
    const { model } = await prefixHold({ reason: "No choices recorded.", row: { [field]: prefixReason } });
    assert.deepEqual(values(model), [], field);
  }
  for (const row of [{ owner: "child-home" }, { id: "other-call" }, { id: "child-home/sample-call", owner: "child-home", key: "sample-call" }]) {
    assert.deepEqual(values((await prefixHold({ row })).model) || [], []);
  }
  assert.deepEqual(values((await prefixHold({ checked: true })).model), []);
  assert.deepEqual(values((await prefixHold({ reason: "No choices.", body: `  ${prefixReason}\n` })).model), []);
});
