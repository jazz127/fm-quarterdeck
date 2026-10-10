import assert from "node:assert/strict";
import test from "node:test";
import { enumeratedLetterOptions, replyDescription } from "../enumerated-options.js";

test("lettered lines become one choice per letter, with the rest of the line as the description", () => {
  const text = [
    "Choose the release window.",
    "a) Staged rollout — fewer users at once",
    "- **b** — Ship now — faster delivery",
    "Option C: Wait for another check",
    "(d) Hold the credential",
    "- \"e\": Keep the current plan",
    "f. Use the smaller patch",
  ].join("\n");
  assert.deepEqual(enumeratedLetterOptions(text), [
    { value: "a", label: "a", hint: "Staged rollout — fewer users at once" },
    { value: "b", label: "b", hint: "Ship now — faster delivery" },
    { value: "C", label: "C", hint: "Wait for another check" },
    { value: "d", label: "d", hint: "Hold the credential" },
    { value: "e", label: "e", hint: "Keep the current plan" },
    { value: "f", label: "f", hint: "Use the smaller patch" },
  ]);
});

test("a sentence, a single letter, a duplicate, a fenced list, and more than eight lines are not choices", () => {
  assert.deepEqual(enumeratedLetterOptions("A. The ship sails tomorrow.\nB. The tide turns at noon."), []);
  assert.deepEqual(enumeratedLetterOptions("a) only one choice"), []);
  assert.deepEqual(enumeratedLetterOptions("a) first\na) again\nb) second"), []);
  assert.deepEqual(enumeratedLetterOptions("```\na) hidden\nb) also hidden\n```\nSee a) inside the sentence."), []);
  const nine = Array.from({ length: 9 }, (_, index) => `${String.fromCharCode(97 + index)}) choice ${index + 1}`).join("\n");
  assert.deepEqual(enumeratedLetterOptions(nine), []);
  assert.equal(replyDescription('Pick.\n- "stay on Lyra": continue the current setup\n"route B" changes it.', "stay on Lyra"), "continue the current setup");
  assert.equal(replyDescription('Pick.\n- "stay on Lyra": continue the current setup', "route B"), null);
});
