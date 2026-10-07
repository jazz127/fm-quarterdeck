// Validation baseline, not the product's historical Node API floor.
import path from "node:path";
import { fileURLToPath } from "node:url";

export function assertValidationRuntime(version = process.versions.node) {
  if (!/^24\.\d+\.\d+$/.test(version)) throw new Error("Full validation requires maintained Node 24 LTS; use that baseline before running the suite or history-free fixture");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertValidationRuntime();
  console.log("PASS: Node 24 LTS validation baseline");
}
