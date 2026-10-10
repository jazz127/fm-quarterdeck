#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { previewOnboarding, applyOnboarding } from "../onboarding.js";

export function parseArgs(args) {
  const options = { preview: false, remove: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--preview") options.preview = true;
    else if (args[i] === "--remove") options.remove = true;
    else if (args[i] === "--home" && args[i + 1] && !args[i + 1].startsWith("--")) options.home = args[++i];
    else throw new Error("Usage: npm run onboard -- [--home /absolute/firstmate-home] [--preview] [--remove]. No unattended --yes mode.");
  }
  return options;
}
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

export async function runOnboarding(options, { env = process.env, question, output = (line) => console.log(line) } = {}) {
  const home = options.home ?? await question("Select the authoritative Firstmate FM_HOME (absolute path): ");
  const preview = previewOnboarding(home, { authoritativeHome: env.FM_HOME, remove: options.remove });
  output(`Selected authoritative FM_HOME: ${home}\nTarget: data/captain.md\nOperation: ${preview.action}${preview.changed ? "" : " (already current; no change)"}`);
  output("Quarterdeck canonical skills: skills/fmqd-lanes, skills/fmqd-toolcheck, skills/fmqd-quartermaster.\nDiscover/project only from a clean stable approved checkout; never a disposable worktree.\nFollow docs/FIRSTMATE-INTEGRATIONS.md for separately approved per-skill discovery, pinning and removal. No projection is changed by this command.");
  output(options.remove ? "Preview: remove only the recognized intact Quarterdeck block; all outside bytes remain intact." : `Preview of the owned block (no user text is printed):\n${preview.block}`);
  if (options.preview) {
    output("Preview only; nothing written or bound. Rerun without --preview to select and confirm this home.");
    return { changed: false, preview: true };
  }
  output("Stop other preference editors/writers first. Confirmation asserts exclusive access during this one-time operation.\nUser preferences take precedence. Edited/unrecognized blocks require manual reconciliation. A lock or changed snapshot is refused, never force-replaced.");
  const confirmation = await question(`To confirm this authoritative home and ${preview.action}, type exactly: ${options.remove ? "remove" : "seed"} ${home}\n> `);
  const result = applyOnboarding(preview, confirmation);
  output(result.changed ? "Owned preferences updated; user text preserved." : "Already current; nothing written.");
  if (!options.remove) output(`Binding for the existing product startup (no second preference ledger or saved home):\nFM_HOME=${quote(home)} npm start\nRun this from prototype/. Keep that FM_HOME for future launches; onboarding does not start or restart services.`);
  else output("Preferences removed; skill projections and startup FM_HOME are unchanged. An empty captain.md is retained rather than deleted.");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let readline;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.preview && !stdin.isTTY) throw new Error("Confirmation requires an interactive terminal. Use --preview for noninteractive inspection.");
    if (!options.home && !stdin.isTTY) throw new Error("Select --home explicitly for noninteractive preview.");
    readline = createInterface({ input: stdin, output: stdout });
    await runOnboarding(options, { question: (prompt) => readline.question(prompt) });
  } catch (error) {
    console.error(`Onboarding refused: ${error.message}`);
    process.exitCode = 1;
  } finally { readline?.close(); }
}
