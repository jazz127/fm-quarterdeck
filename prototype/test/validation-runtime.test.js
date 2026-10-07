import test from "node:test";
import assert from "node:assert/strict";
import { assertValidationRuntime } from "../scripts/check-validation-runtime.mjs";

test("full suite runs on the maintained Node 24 validation baseline", () => {
  assertValidationRuntime();
  for (const version of ["18.20.0", "20.19.0", "22.20.0", "25.0.0", "24.0.0-rc.1", "unknown"])
    assert.throws(() => assertValidationRuntime(version), /Node 24 LTS/);
  for (const version of ["24.0.0", "24.21.0"]) assert.doesNotThrow(() => assertValidationRuntime(version));
});
