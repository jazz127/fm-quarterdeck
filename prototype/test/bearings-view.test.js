import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const window = {};
vm.runInNewContext(await readFile(new URL('../public/bearings-view.js', import.meta.url), 'utf8'), { window, URL });
const view = window.bearingsView;
const HINT = "Pick an option to answer, or just type - Firstmate replies in the thread.";

test('decision, credential and merge rendering is escaped and read-only', () => {
  for (const type of ['decision', 'merge']) {
    const html = view.cardHtml({ type, verb: 'credential', summary: '<script>"&', reason: '<img onerror=x>', owner: "<owner>'", repo: '<repo>', url: 'https://example.invalid/pull/1?a=1&b=2', checkedAt: 'bad' });
    assert.doesNotMatch(html, /<script>|<img|<owner>|<repo>/);
    assert.match(html, /&lt;/);
    assert.match(html, /Answer in chat or on the \/bearings lavish board/);
    assert.match(html, /data-call-draft="note"/);
    assert.doesNotMatch(html, /data-call-key|data-call-rev|Merge now|data-call-thread-toggle|data-call-draft="thread"/);
    assert.match(html, /data-call-answer-text rows="1"/);
    assert.match(html, new RegExp(HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /data-call-thread-expand[\s\S]*data-call-thread-history[\s\S]*data-call-answer-text[\s\S]*data-call-box-hint/);
    if (type === 'decision') assert.match(html, />Credentials</);
    else { assert.match(html, /https:\/\/example.invalid\/pull\/1\?a=1&amp;b=2/); assert.match(html, /rel="noopener noreferrer"/); }
  }
  for (const url of ['javascript:alert(1)', 'http://example.invalid', 'https://user:secret@example.invalid', null]) {
    assert.doesNotMatch(view.cardHtml({ type: 'merge', url }), /href=/);
  }
});
test('rich context expands source choices without inventing controls, risk or a recommendation', () => {
  const summary = `Pick a release. ${'Full context. '.repeat(60)}Recommended: staged — fewer users affected. Immediate — faster.`;
  const html = view.cardHtml({ type: 'decision', summary, repo: 'example-app', owner: 'acme-mate', url: 'https://example.invalid/acme/example-app/pull/42' });
  assert.match(html, /<span class="state-chip">Decision<\/span>/);
  assert.match(html, /<span class="call-repo">example-app<\/span>/);
  assert.ok(html.includes(`<h3 id="call-decide-${view.idFor('Decision')}">${summary}</h3>`));
  assert.match(html, /<dt>About<\/dt><dd>example-app · acme-mate/);
  assert.doesNotMatch(html, /call-clamp|data-call-more|More details/);
  assert.match(html, /href="https:\/\/example.invalid\/acme\/example-app\/pull\/42"/);
  assert.doesNotMatch(html, /type="radio"|<select|<details|checks green|call-opt|recommend_value/);
  assert.match(html, /data-call-box-hint/);
  const merge = view.cardHtml({ type: 'merge', reason: summary, kind: 'pr', repo: 'example-app' });
  assert.ok(merge.includes(`<h3 id="call-decide-${view.idFor('Merge')}">${summary}</h3>`));
  assert.match(merge, /<dt>Risk<\/dt><dd>Not provided by the snapshot/);
  assert.doesNotMatch(merge, /risk low|risk high|checks green/i);
});

test('long text stays in the title; Firstmate shortening is disclosed beside the task id', () => {
  const card = { key: 'decision:alpha-call', task: 'alpha-call', type: 'decision', summary: 'Pick the alpha rollout window: staged or immediate, with the…' };
  const html = view.cardHtml(card);
  const id = view.idFor(card.key);
  assert.match(html, new RegExp(`<h3 id="call-decide-${id}" data-call-truncated>`));
  assert.match(html, /snapshot shortened this ask[\s\S]*<code>alpha-call<\/code>/);
  assert.match(html, /class="call-id">Task <code>alpha-call<\/code>/);
  assert.doesNotMatch(html, /data-call-more|call-clamp|More details/);
  const whole = view.cardHtml({ ...card, summary: 'Pick the alpha rollout window' });
  assert.doesNotMatch(whole, /data-call-truncated|snapshot shortened/);
  assert.match(whole, /class="call-id">Task <code>alpha-call<\/code>/);
  assert.notEqual(view.idFor('decision:a.b'), view.idFor('decision:a-b'), 'ids stay distinct when keys sanitize alike');
  assert.match(html, /data-call-text-toggle[\s\S]*This is the full text Quarterdeck received/);
  const header = html.slice(html.indexOf('<header class="call-head">'), html.indexOf('</header>'));
  assert.match(header, /class="call-lifecycle-dot" data-call-lifecycle-badge data-call-lifecycle="active" role="img" aria-label="Active" title="Active"><\/span>/);
  assert.doesNotMatch(header, />Active</);
  assert.match(header, /data-call-procrastinate-for="3h"[\s\S]*data-call-procrastinate-for="6h"[\s\S]*data-call-procrastinate-for="1d"[\s\S]*data-call-procrastinate-for="3d"/);
  assert.doesNotMatch(html.slice(html.indexOf('</header>')), /data-call-procrastinate/);
  assert.match(html, /Bring back now/);
  assert.match(view.cardHtml({ type: 'decision', summary: 'Pick the window...' }), /data-call-truncated/);
  const full = 'Pick the alpha rollout window: staged or immediate, with the rest of the recorded ask';
  const continued = view.cardHtml({ key: 'decision:alpha-call', task: 'alpha-call', type: 'decision', summary: 'Pick the alpha rollout window: staged…', backlogTitle: full });
  assert.ok(continued.includes(`<h3 id="call-decide-${view.idFor('decision:alpha-call')}">${full}</h3>`));
  assert.doesNotMatch(continued, /data-call-truncated|snapshot shortened|data-call-text-toggle/);
  const other = view.cardHtml({ key: 'decision:alpha-call', task: 'alpha-call', type: 'decision', summary: 'Pick the window…', reason: 'A different recorded reason' });
  assert.ok(other.includes(`<h3 id="call-decide-${view.idFor('decision:alpha-call')}">A different recorded reason</h3>`));
  assert.doesNotMatch(other, /data-call-text-toggle|snapshot shortened|Pick the window/);
});
test('answerable cards render a form: freeform only without options, options with a recommended marker, Merge now for merges', () => {
  const freeform = view.cardHtml({ key: 'decision:alpha-call', task: 'alpha-call', type: 'decision', summary: 'Pick a window', answer: { question: 'alpha-call', options: [], recommend: null, close: null, freeform: true } });
  assert.match(freeform, /data-call-sent-label hidden>Sent - waiting for Firstmate<\/p>\s*<section class="call-your-answer" data-call-answer-summary hidden><h4>Your answer<\/h4>/);
  assert.match(freeform, /data-call-answer-summary hidden>[\s\S]*?<h3 /, "the sent answer summary sits above the ask");
  assert.match(freeform, /<form class="call-answer" data-call-answer data-call-answer-label="Decision alpha-call" novalidate/);
  assert.match(freeform, /No structured options for this call yet; any recorded choices are in the full ask above/);
  assert.doesNotMatch(freeform, /\$\{/);
  assert.match(freeform, /data-call-draft="answer" data-call-answer-text rows="1"/);
  assert.match(freeform, /data-call-thread-expand[\s\S]*data-call-thread-history[\s\S]*data-call-answer-text/);
  assert.doesNotMatch(freeform, /data-call-answer-text[\s\S]*data-call-thread-history/);
  assert.doesNotMatch(freeform, /data-call-thread-toggle|Ask more info|data-call-draft="thread"/);
  assert.doesNotMatch(freeform, /type="radio"|Recommended|Note to self|Answer in chat/);
  for (const hook of ['fields', 'compose', 'confirm', 'preview', 'send', 'edit', 'receipt', 'again', 'error']) assert.ok(freeform.includes(`data-call-answer-${hook}`), hook);
  assert.match(freeform, /data-call-answer-confirm role="group" aria-label="Queued answer" hidden/);
  // Queue, then Send and Edit, sit in one row with the answer note.
  assert.match(freeform, /data-call-answer-text[^>]*><\/textarea><\/label>\s*<div class="call-answer-actions call-answer-bar"><button type="submit" class="call-answer-queue" data-call-answer-compose>Queue<\/button><button type="button" class="call-answer-send" data-call-answer-send hidden>Send<\/button><button type="button" data-call-answer-edit hidden>Edit<\/button><\/div>/);
  assert.doesNotMatch(freeform, /Review answer/);
  const options = view.cardHtml({ key: 'decision:alpha-call', task: 'alpha-call', type: 'decision', summary: 'Pick', answer: { question: 'alpha-call', options: [{ value: 'staged', label: '<b>Staged</b>', hint: 'Fewer users' }, { value: 'now', label: 'Now', hint: null }], recommend: 'staged', close: null, freeform: true } });
  assert.equal((options.match(new RegExp(`type="radio" name="call-selection-${view.idFor('decision:alpha-call')}"`, 'g')) || []).length, 2);
  assert.match(options, /<div class="call-opts">[\s\S]*<div class="call-answer-compose">/, 'options and the note share one answer block');
  assert.doesNotMatch(options, /call-answer-fields-split/);
  assert.match(options, /value="staged"[^>]*aria-describedby="call-rec-[^"]+"/, 'the recommendation is announced with its option');
  assert.equal((options.match(/call-opt-rec/g) || []).length, 1, 'only the recommended option is marked');
  assert.match(options, /value="staged"[^>]*data-call-option-label="&lt;b&gt;Staged&lt;\/b&gt;"[\s\S]*?Fewer users[\s\S]*?Recommended/);
  assert.match(options, /Pick an option to answer, or just type - Firstmate replies in the thread\./);
  assert.doesNotMatch(options, /<b>Staged/);
  const merge = view.cardHtml({ key: 'merge:beta-merge', task: 'beta-merge', type: 'merge', reason: 'checks green', answer: { question: 'merge.beta-merge', options: [{ value: 'merge', label: 'Merge now', hint: 'Firstmate re-checks' }], recommend: null, close: null, freeform: true } });
  assert.match(merge, /value="merge"[\s\S]*Merge now/);
  assert.doesNotMatch(merge, /Recommended/);
  // Suggested replies from linked chat asks become radios relayed as the captain's words.
  const linked = view.cardHtml({ key: 'merge:beta-merge', task: 'beta-merge', type: 'merge', reason: 'checks green', chatAsks: [{ summary: 'Merge?', replies: ['ship it', 'Merge now', '<hold>'] }],
    answer: { question: 'merge.beta-merge', options: [{ value: 'merge', label: 'Merge now', hint: null }], recommend: null, close: null, freeform: true } });
  assert.equal((linked.match(/data-call-reply=/g) || []).length, 2, 'a reply equal to an option label is not repeated');
  assert.match(linked, /value="chat-reply-1"[^>]*data-call-option-label="ship it" data-call-reply="ship it"/);
  assert.match(linked, /data-call-reply="&lt;hold&gt;"/);
});

test('a captain-hold asking for a credential is labelled Credentials', () => {
  assert.match(view.cardHtml({ type: 'decision', verb: 'captain-hold', summary: 'Provide the gamma sandbox credential' }), />Credentials</);
  assert.match(view.cardHtml({ type: 'decision', verb: 'captain-hold', summary: 'Pick the alpha rollout window' }), />Decision</);
});
test('honest empty states and coverage disclose stale, missing and omitted evidence', () => {
  assert.equal(view.emptyHtml({ state: 'ready', coverage: { provenClear: true } }), 'Nothing needs your action right now');
  assert.equal(view.emptyHtml({ state: 'ready', coverage: { checked: 2, known: 5 } }), 'No decision is recorded · checked 2 of 5');
  assert.match(view.emptyHtml({ state: 'loading' }), /Checking/);
  assert.match(view.emptyHtml({ state: 'unavailable', error: '<script>' }), /unavailable · &lt;script&gt;/);
  assert.match(view.emptyHtml({ state: 'stale', coverage: { provenClear: true } }), /Last known calls/);
  const text = view.coverageText({ state: 'stale', stale: true, error: 'Snapshot failed', coverage: { checked: 2, known: 5, captainOmitted: 2, unmeasuredHomes: 1 }, omitted: [{ kind: 'deferred-holds', count: 3 }, { kind: 'decisions-bound', shown: 20, total: 30 }, { kind: 'invalid-rows', count: 1 }] });
  for (const phrase of ['Stale', 'checked 2 of 5', 'Snapshot failed', '+3 later-dated or blocked calls not shown', '20 of 30 decisions shown', '1 invalid calls withheld', '2 merge calls not shown', '1 homes unmeasured']) assert.ok(text.includes(phrase), phrase);
});
test('held notice names the card change; resolved stub leaves text to textContent', () => {
  assert.equal(view.heldText('updated'), "Call updated — updates when you're done");
  assert.equal(view.heldText('resolved'), "Call resolved — updates when you're done");
  const stub = view.stubHtml('key', '<script>draft</script>');
  assert.doesNotMatch(stub, /<script>/);
  for (const hook of ['stub-text', 'stub-copy', 'stub-dismiss']) assert.ok(stub.includes(`data-call-${hook}`));
});
test('chat cards escape asks, marker evidence and up to three reply choices', () => {
  const replies = ['<b>publish</b>', '"wait" & see', "don't publish"];
  const html = view.cardHtml({ key: 'chat:synthetic', type: 'chat', kind: 'approval', summary: '<script>approve?</script>', marker: '<img onerror=x>', replies, answer: { options: replies.map((label, i) => ({ value: `reply-${i + 1}`, label })) } });
  assert.doesNotMatch(html, /<script>|<img|<b>publish/);
  for (const text of ['&lt;script&gt;approve?', '&lt;img onerror=x&gt;', '&lt;b&gt;publish&lt;\/b&gt;', '&quot;wait&quot; &amp; see', 'don&#039;t publish']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/type="radio"/g) || []).length, 3);
  assert.match(html, /Approval · Chat ask/);
  const chatHead = html.slice(html.indexOf('<header class="call-head">'), html.indexOf('</header>'));
  assert.match(chatHead, /data-call-dismiss>Review dismissal<\/button>[\s\S]*data-call-procrastinate-toggle[^>]*>Procrastinate/);
  assert.match(html, /data-call-dismiss-confirm role="group" aria-label="Confirm dismissal" hidden/);
  assert.match(html, /Nothing is sent to Firstmate/);
  const noReply = view.cardHtml({ type: 'chat', kind: 'action', summary: 'Synthetic ask', replies: [], answer: { options: [] } });
  assert.match(noReply, /No quoted reply/);
  assert.doesNotMatch(noReply, /type="radio"/);
  assert.match(noReply, /Pick an option to answer, or just type - Firstmate replies in the thread\./);
});
test('linked asks render within the hold and disclose escaped reply alternatives', () => {
  const html = view.cardHtml({ type: 'decision', summary: 'Choose', chatAsks: [{ summary: '<one>', replies: ['<yes>', 'no'] }, { summary: 'Second & ask', replies: [] }] });
  assert.match(html, /call-context-row call-context-ask/);
  assert.match(html, /Also asked in chat/);
  assert.match(html, /&lt;one&gt; · reply “&lt;yes&gt;” or “no”<br>Second &amp; ask · reply No quoted reply/);
  assert.doesNotMatch(html, /<one>|<yes>|data-call-dismiss/);
  assert.doesNotMatch(view.cardHtml({ type: 'decision', chatAsks: [] }), /Also asked in chat/);
  const reason = 'Ship the ledger change only after the captain picks a window.';
  const filed = view.cardHtml({
    key: 'decision:hold-reason', task: 'hold-reason', type: 'decision', owner: '(main)', repo: 'quarterdeck',
    summary: '[task:hold-reason]: reply option A or option B',
    backlogReason: reason,
    reason: '[task:hold-reason]: reply option A or option B',
    chatAsks: [{ summary: '[task:hold-reason]: reply option A or option B', replies: ['option A', 'option B'] }],
    answer: { question: 'hold-reason', options: [], recommend: null, close: null, freeform: true },
  });
  const filedId = view.idFor('decision:hold-reason');
  assert.ok(filed.includes(`<h3 id="call-decide-${filedId}">${reason}</h3>`));
  assert.doesNotMatch(filed, /\[task:/);
  assert.match(filed, /Also asked in chat/);
  assert.match(filed, /quarterdeck · \(main\)/);
  assert.doesNotMatch(filed, /Repository not recorded/);
  assert.equal((filed.match(/data-call-reply=/g) || []).length, 2);
  assert.ok(filed.indexOf(reason) < filed.indexOf('data-call-reply='), 'the hold reason stays above the reply choices');
  assert.match(filed, /data-call-reply="option A"[\s\S]*data-call-reply="option B"/);
});
test('coverage names chat scan failures, omitted asks and bounded catchup', () => {
  for (const state of ['loading', 'unavailable']) assert.match(view.coverageText({ state: 'ready', chat: { state } }), /Chat asks unavailable/);
  const text = view.coverageText({ state: 'ready', chat: { state: 'unavailable', error: 'Synthetic scan failed', omitted: 4, behind: true } });
  for (const phrase of ['Synthetic scan failed', '4 older chat asks not shown', 'Still reading the Firstmate transcript']) assert.ok(text.includes(phrase));
  assert.doesNotMatch(view.coverageText({ state: 'ready', chat: { state: 'ready', omitted: 0, behind: false } }), /Chat asks unavailable|not shown|Still reading/);
});
test('check ages are conservative for missing or future clocks', () => {
  assert.equal(view.age(null, 100000), 'age unknown');
  assert.equal(view.age('1970-01-01T00:00:00Z', 120000), '2m ago');
  assert.equal(view.age('1970-01-01T00:01:00Z', 0), 'age unknown');
});
