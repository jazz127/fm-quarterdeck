#!/usr/bin/env node
// Explicit pre-send check; never invent a destination or rewrite prose.
import { pathToFileURL } from 'node:url';

export function checkLaneEnvelopes(text) {
  const errors = [];
  let lane = null, blocks = 0, content = false, fence = null;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const fail = (code) => errors.push({ line: index + 1, code });
    // Fenced examples inside a real block are data, not nested envelopes.
    const delimiter = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      content = true;
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && /^\s*$/.test(line.slice(delimiter[0].length))) fence = null;
      continue;
    }
    if (delimiter && lane) { fence = delimiter[1]; content = true; continue; }
    const marker = line.match(/^\[(fm-lane|end) ([A-Za-z0-9][A-Za-z0-9._-]{0,159})\]$/);
    if (marker) {
      if (marker[1] === 'fm-lane') {
        if (lane) fail('nested-block');
        else { lane = marker[2]; content = false; blocks += 1; }
      } else if (!lane) fail('orphan-end');
      else if (marker[2] !== lane) fail('mismatched-end');
      else { if (!content) fail('empty-block'); lane = null; }
    } else if (/^\s*\[(?:fm-lane|end)(?:\s|\])/.test(line)) fail('malformed-marker');
    else if (line.trim()) {
      if (!lane) fail('unwrapped-text');
      else content = true;
    }
  }
  if (lane) errors.push({ line: text.split(/\r?\n/).length, code: 'unclosed-block' });
  if (!blocks) errors.push({ line: 1, code: 'no-blocks' });
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error('usage: check-lane-envelopes.mjs < message.txt');
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      text += chunk;
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('message exceeds 1 MiB');
    }
    const errors = checkLaneEnvelopes(text);
    if (errors.length) { console.error(JSON.stringify({ ok: false, errors })); process.exitCode = 1; }
    else console.log(JSON.stringify({ ok: true }));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
