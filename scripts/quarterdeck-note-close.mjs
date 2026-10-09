#!/usr/bin/env node
// The caller has already read/acted on the order. This only closes intake.
import { replyAndAckNote } from '../prototype/inbox.js';

try {
  const [id] = process.argv.slice(2);
  if (process.argv.length !== 3) throw new Error('usage: FM_HOME=<absolute selected home> quarterdeck-note-close.mjs <note-id> < reply.txt');
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error('reply exceeds 32 KiB');
  }
  console.log(JSON.stringify(await replyAndAckNote(process.env.FM_HOME || '', id, text)));
} catch {
  // Never include private home, note body or CLI diagnostics in wake output.
  console.error('Quarterdeck note closure unconfirmed; inspect receipts and retry the same reply, not the order.');
  process.exitCode = 1;
}
