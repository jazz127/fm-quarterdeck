#!/usr/bin/env node
// One mechanical chat-ask evaluation (docs/CHAT-ASKS.md), outside the server. By default it
// starts from the saved Quarterdeck chat-ask state but persists nothing; --write saves the
// advanced cursors and new asks exactly as the server would.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredStatePath } from "../agent-state.js";
import { chatAsksPath, chatCard, createChatAskScanner, emptyChatState, memoryStateFile } from "../chat-asks.js";

const USAGE = "Usage: node scripts/chat-asks.mjs --home /absolute/firstmate-home [--state /absolute/agent-state.json] [--claude-config /absolute/.claude] [--write]";
export function parseArgs(args, env = process.env) {
  const options = { home: env.FM_HOME, state: null, claudeConfig: env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), write: false };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--write") options.write = true;
    else if (["--home", "--state", "--claude-config"].includes(args[i]) && value && !value.startsWith("--")) { options[{ "--home": "home", "--state": "state", "--claude-config": "claudeConfig" }[args[i]]] = value; i++; }
    else throw new Error(USAGE);
  }
  options.state ||= configuredStatePath(env);
  for (const name of ["home", "state", "claudeConfig"]) if (!options[name] || !path.isAbsolute(options[name])) throw new Error(USAGE);
  return options;
}

export async function evaluate(options) {
  const file = chatAsksPath(options.state);
  let store;
  if (!options.write) {
    let initial = emptyChatState();
    try { initial = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    store = memoryStateFile(initial);
  }
  const scanner = createChatAskScanner({ home: options.home, claudeConfigDir: options.claudeConfig, statePath: file, ...(store ? { store } : {}) });
  await scanner.scan();
  return { view: scanner.view(), cards: scanner.asks().map(chatCard), persisted: options.write };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await evaluate(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
