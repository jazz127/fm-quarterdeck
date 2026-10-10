import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// Exercise the real CLI and guarded-command adapter, never an installed home.
test('note CLI proves reply+ack with an actual synthetic executable; retry only reads', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-note-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'bin'));
  await writeFile(path.join(home, 'receipts.json'), JSON.stringify({ schema: 'fm-inbox-receipts.v1', pending: [{ id: '123-note' }], handled: [], replies: [], omitted: [] }));
  await writeFile(path.join(home, 'bin/fm-inbox.sh'), `#!${process.execPath}
const fs = require('node:fs');
const home = process.env.FM_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(home + '/calls.txt', args[0] + '\\n');
const file = home + '/receipts.json', data = JSON.parse(fs.readFileSync(file));
if (args[0] === 'receipts') console.log(JSON.stringify(data));
else if (args[0] === 'reply' && args[1] === '123-note') { data.replies = [{in_reply_to:args[1],body:args[2]}]; fs.writeFileSync(file,JSON.stringify(data)); }
else if (args.join(' ') === 'drain --ack 123-note') { data.handled = data.pending; data.pending = []; fs.writeFileSync(file,JSON.stringify(data)); }
else process.exit(1);
`, { mode: 0o700 });
  const run = (input, id = '123-note') => spawnSync(process.execPath, ['scripts/quarterdeck-note-close.mjs', id], {
    input, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, FM_HOME: home },
  });
  const reply = 'Synthetic verification ✓\n';
  const result = run(reply);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'replied-and-acked');
  assert.equal(await readFile(path.join(home, 'calls.txt'), 'utf8'), 'receipts\nreply\nreceipts\ndrain\nreceipts\n');
  const retry = run(reply); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(await readFile(path.join(home, 'calls.txt'), 'utf8'), 'receipts\nreply\nreceipts\ndrain\nreceipts\nreceipts\n');
  for (const [text, id] of [['different private text', '123-note'], ['hello', '../unsafe'], ['x'.repeat(32769), '123-note']]) {
    const refused = run(text, id); assert.equal(refused.status, 1);
    assert.ok(!refused.stderr.includes(text)); assert.ok(!refused.stderr.includes(home));
  }
});
