#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { migratePrivateExpenses } from "../private-migration.js";
import { verifyPreservedExpenses } from "../private-verification.js";

const args = process.argv.slice(2);
if (args.length !== 1 || !["--copy", "--verify", "--verify-preserved"].includes(args[0])) {
  console.error("Usage: FM_HOME=/explicit/firstmate node prototype/scripts/private-overlay.mjs --copy|--verify|--verify-preserved");
  process.exitCode = 2;
} else {
  try {
    if (args[0] === "--verify-preserved") {
      await verifyPreservedExpenses(process.env);
      console.log("Verified: preserved expense bundle matches its private initial-copy manifest.");
    } else {
      await migratePrivateExpenses({ sourceRoot: fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""), env: process.env, mode: args[0].slice(2) });
      console.log(args[0] === "--copy" ? "Private expense copy complete; run --verify before integration." : "Verified: expense ledger bytes, cost configuration and private manifest match source.");
    }
  } catch {
    // Never serialize filesystem errors, JSON parser excerpts, private paths or values.
    console.error("Private expense copy/verification refused: check explicit FM_HOME, source validity, private permissions, conflicts and migration lock. Existing data was not overwritten.");
    process.exitCode = 1;
  }
}
