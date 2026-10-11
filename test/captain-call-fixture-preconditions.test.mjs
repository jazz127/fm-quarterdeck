import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const callSource = readFileSync(new URL('../prototype/scripts/captain-call-live-browser-pass.mjs', import.meta.url), 'utf8');
const replySource = readFileSync(new URL('../prototype/scripts/card-reply-links-static-proof.mjs', import.meta.url), 'utf8');
const abandon = callSource.match(/\/\/ The refused answer[\s\S]*?await evaluate\(`([\s\S]*?)`\);/)[1];
const selectReply = replySource.slice(replySource.indexOf('          const expand ='), replySource.indexOf('          const anchors ='));

test('the empty-card fixture abandons only its exact refused text through input and verifies saved drafts', () => {
  const saved = { note: 'A revised synthetic answer', selection: 'now' };
  const sibling = { note: 'Keep the other card draft' };
  let inputs = 0;
  const field = { value: saved.note, dispatchEvent(event) {
    assert.equal(event.type, 'input');
    assert.equal(event.bubbles, true);
    inputs++;
    if (field.value) saved.note = field.value; else delete saved.note;
  } };
  const form = { dataset: { callAnswerPhase: 'refused' } };
  const card = { querySelector(selector) { return selector === '[data-call-answer-text]' ? field : form; } };
  const document = { querySelector(selector) {
    assert.equal(selector, '[data-call-key="decision:alpha-call"]');
    return card;
  } };
  const storage = { getItem(key) {
    assert.equal(key, 'fm-quarterdeck-call-draft.v1:decision:alpha-call');
    return JSON.stringify(saved);
  } };
  const run = new Function('document', 'sessionStorage', 'Event', `return (${abandon})();`);
  assert.match(run(document, storage, Event), /empty\/unengaged/);
  assert.equal(inputs, 1);
  assert.equal(field.value, '');
  assert.deepEqual(saved, { selection: 'now' });
  assert.deepEqual(sibling, { note: 'Keep the other card draft' });

  field.value = 'Unexpected unsent text';
  assert.throws(() => run(document, storage, Event), /refused draft precondition/);
  assert.equal(field.value, 'Unexpected unsent text');
  field.value = 'A revised synthetic answer';
  saved.other = 'Another unsent field';
  assert.throws(() => run(document, storage, Event), /still has saved unsent text/);
});

function replyFixture({ latest = false, missing = false, suffix = true, bannerHidden = false } = {}) {
  let historyOpen = false, expanded = false, earlierClicks = 0;
  const reply = { textContent: 'This call chooses the synthetic release window. Read https://example.invalid/guide' + (suffix ? ' (keep this note).' : ' changed suffix') };
  const expand = { getAttribute() { return String(expanded); }, click() { expanded = true; } };
  const earlier = { hidden: false, click() { historyOpen = true; earlierClicks++; } };
  const card = {
    querySelector(selector) {
      if (selector === '[data-call-thread-expand]') return expand;
      if (selector === '[data-call-thread-history-toggle]') return earlier;
      if (selector === '[data-fm-reply]') return { hidden: bannerHidden };
      throw Error('unexpected selector');
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.call-thread-firstmate .call-thread-text');
      return expanded && !missing && (latest || historyOpen) ? [reply] : [];
    },
  };
  return { run: () => new Function('card', `${selectReply}\nreturn reply;`)(card), clicks: () => earlierClicks, reply };
}

test('fresh reply geometry opens earlier history only when the recorded reply is outside the latest exchange', () => {
  const earlier = replyFixture();
  assert.equal(earlier.run(), earlier.reply);
  assert.equal(earlier.clicks(), 1);
  const latest = replyFixture({ latest: true });
  assert.equal(latest.run(), latest.reply);
  assert.equal(latest.clicks(), 0);
});

test('earlier-history selection still rejects absent replies, altered suffixes and hidden banners', () => {
  for (const options of [{ missing: true }, { suffix: false }, { bannerHidden: true }]) {
    assert.throws(() => replyFixture(options).run(), /recorded reply text missing/);
  }
});
