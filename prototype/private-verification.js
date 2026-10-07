// Read-only initial-copy verification independent of public source defaults.
import path from "node:path";
import { createHash } from "node:crypto";
import { OVERLAY_FILES, selectedHome, readConfinedFile, validateExpenseLedger, validateManifest } from "./private-runtime.js";
import { validateCostConfiguration } from "./cost-config.js";

export async function verifyPreservedExpenses(env) {
  try {
    const root = path.join(selectedHome(env, true), "data", "agentos");
    const bytes = await Promise.all(OVERLAY_FILES.map((name) => readConfinedFile(path.join(root, "expenses", name), { privateFrom: root })));
    if (bytes.some((value) => value === null)) throw new Error();
    const manifest = validateManifest(JSON.parse(bytes[2]));
    for (const [index, entry] of manifest.files.entries()) {
      if (createHash("sha256").update(bytes[index]).digest("hex") !== entry.sha256) throw new Error();
    }
    return { ledger: validateExpenseLedger(JSON.parse(bytes[0])), costs: validateCostConfiguration(JSON.parse(bytes[1])) };
  } catch {
    // No JSON excerpts, filesystem paths, fingerprints or private values.
    throw new Error("Preserved expense verification refused");
  }
}
