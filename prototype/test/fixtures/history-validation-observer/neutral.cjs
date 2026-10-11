const assert = require("node:assert/strict");
const test = require("node:test");

test("neutral observer fixture keeps the original assertion", () => {
  assert.equal(2 + 2, 4);
});
