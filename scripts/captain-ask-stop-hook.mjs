#!/usr/bin/env node
// Optional, Quarterdeck-owned Claude Code Stop guard. No model or Firstmate writes.
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractAsks } from '../prototype/chat-asks.js';
import { readBacklogHoldRecords } from '../prototype/bearings.js';
import { claudeProjectDirectory, claudeTurns } from '../prototype/claude-transcript.js';
import { checkLaneEnvelopes } from './check-lane-envelopes.mjs';

async function bounded(file, max, tail = false) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!tail && info.size > max)) throw new Error('input is not a bounded regular file');
    const start = tail ? Math.max(0, info.size - max) : 0;
    const bytes = Buffer.alloc(Math.min(info.size - start, max));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } finally { await handle.close(); }
}

export async function checkStop(input, { home = process.env.FM_HOME, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), enforceLanes = process.env.FM_QUARTERDECK_ENFORCE_LANES === '1' } = {}) {
  try {
    if (!home || !path.isAbsolute(home)) throw new Error('FM_HOME must be explicit and absolute');
    const root = await realpath(home);
    if (input.hook_event_name !== 'Stop') return { diagnostic: 'not a Stop event; skipped' };
    // Claude sets this on the corrective turn. Never create an infinite stop loop.
    if (input.stop_hook_active) return { diagnostic: 'corrective Stop already active; skipped' };
    const session = (await bounded(path.join(root, 'state/.lock-session'), 256)).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(session)) throw new Error('primary session pointer unavailable');
    if (input.session_id !== session) return {};
    if (input.cwd !== root) return { diagnostic: 'primary cwd differs from selected home; skipped' };
    const expected = path.join(claudeProjectDirectory(path.resolve(configDir), root), `${session}.jsonl`);
    if (input.transcript_path !== expected || await realpath(expected) !== expected) throw new Error('transcript not confined to selected primary session');
    // Stop input carries the completed reply even before it reaches the transcript.
    // Older harnesses omit it; only then read the bounded assistant-message tail.
    let final = input.last_assistant_message;
    if (final === undefined) {
      final = null;
      const text = await bounded(expected, 4 * 1024 * 1024, true);
      let finalId = null;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        if (record.type !== 'assistant') continue;
        const turn = claudeTurns(record, new Map()).find(turn => turn.role === 'assistant' && !turn.recordKind);
        if (!turn) continue;
        const messageText = typeof turn.content === 'string' ? turn.content : turn.content.filter(part => part?.type === 'text').map(part => part.text).join('\n');
        const id = record.message?.id || record.uuid || null;
        final = id && id === finalId ? `${final}\n${messageText}` : messageText;
        finalId = id;
      }
      if (final === null) throw new Error('final assistant message absent from bounded transcript tail');
    }
    if (typeof final !== 'string') throw new Error('final assistant message must be text');
    if (enforceLanes && final.trim() && checkLaneEnvelopes(final).length) return {
      decision: 'block', reason: 'Wrap the complete captain-facing reply in flat matching [fm-lane <LaneName>] / [end <LaneName>] blocks. Lane labels are presentation only, not task ownership.'
    };
    const asks = extractAsks(final);
    if (!asks.length) return {};
    const open = new Set((await readBacklogHoldRecords(root)).filter(row => row.open).map(row => row.task));
    if (asks.some(ask => !ask.taskMarkers.some(task => open.has(task)))) return {
      decision: 'block', reason: 'File each captain ask as an open captain hold with bin/fm-captain-hold.sh, then add [task:<id>] naming that hold on every ACTION NEEDED / APPROVAL NEEDED / DECISION NEEDED line.'
    };
    return {};
  } catch (error) { return { diagnostic: `fail-open: ${error.code || error.message}` }; }
}

async function main() {
  let input = '', result;
  const timer = setTimeout(() => { console.error('quarterdeck-ask-stop: fail-open: 5s read deadline'); process.exit(0); }, 5000);
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 64 * 1024) throw new Error('hook input exceeds 64 KiB');
    }
    result = await checkStop(JSON.parse(input));
  } catch (error) { result = { diagnostic: `fail-open: ${error.message}` }; }
  clearTimeout(timer);
  if (result.diagnostic) console.error(`quarterdeck-ask-stop: ${result.diagnostic}`);
  if (result.decision) console.log(JSON.stringify({ decision: result.decision, reason: result.reason }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
