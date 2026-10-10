import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFixture } from '../scripts/fetch-fixture.mjs';

function fixture(command, respond = (_request, act) => act('Fetch.continueRequest')) {
  let listener;
  const commands = [];
  const interception = fetchFixture({ onEvent(fn) { listener = fn; }, command(method, params) {
    commands.push({ method, params }); return command(method, params);
  } }, respond);
  const emit = (method, params) => listener({ method, params });
  const navigate = loaderId => emit('Page.frameNavigated', { frame: { id: 'frame', loaderId } });
  const pause = (id, loaderId = 'old') => {
    emit('Network.requestWillBeSent', { requestId: id, request: { url: 'http://fixture.invalid/api/review' }, loaderId, frameId: 'frame' });
    emit('Fetch.requestPaused', { requestId: `fetch-${id}`, networkId: id, request: { method: 'GET' } });
  };
  navigate('old');
  return { interception, commands, emit, navigate, pause };
}
const invalid = () => Object.assign(Error('Fetch.continueRequest: Invalid InterceptionId.'), {
  cdpError: { code: -32602, message: 'Invalid InterceptionId.' },
});

test('interception shutdown drains issued actions and leaves later pauses to Fetch.disable', async () => {
  const response = Promise.withResolvers();
  const f = fixture(method => method === 'Fetch.disable' ? Promise.resolve() : response.promise);
  f.pause('first');
  const stopping = f.interception.stop();
  f.pause('during-shutdown');
  assert.deepEqual(f.commands.map(c => c.method), ['Fetch.continueRequest']);
  response.resolve(); await stopping;
  assert.deepEqual(f.commands.map(c => c.method), ['Fetch.continueRequest', 'Fetch.disable']);
});

test('navigation drains in-flight fulfill and skips outgoing pauses until replacement commits', async () => {
  const response = Promise.withResolvers();
  const f = fixture(method => method === 'Fetch.fulfillRequest' ? response.promise : Promise.resolve(),
    (_request, act) => act('Fetch.fulfillRequest', { responseCode: 200 }));
  f.pause('first');
  let drained = false;
  const navigation = f.interception.beforeNavigation().then(() => { drained = true; });
  f.pause('outgoing');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'reload must wait for the outstanding fulfill');
  assert.equal(f.commands.length, 1, 'outgoing pauses cannot start commands during navigation');
  response.resolve(); await navigation;
  f.navigate('new'); f.pause('current', 'new');
  await f.interception.stop();
  assert.deepEqual(f.commands.map(c => c.method), ['Fetch.fulfillRequest', 'Fetch.fulfillRequest', 'Fetch.disable']);
});

test('held config from a replaced document is excluded while current config still continues', async () => {
  const held = [];
  const f = fixture(() => Promise.resolve(), request => held.push(request));
  f.pause('old'); f.navigate('new'); f.pause('new', 'new');
  assert.equal(f.interception.stale(held[0]), true);
  assert.equal(f.interception.stale(held[1]), false);
  await Promise.all(held.map(request => f.interception.act(request, 'Fetch.continueRequest')));
  await f.interception.stop();
  assert.equal(f.commands[0].params.requestId, 'fetch-new');
  assert.equal(f.commands.length, 2);
});

for (const race of ['navigation', 'cancelled']) {
  test(`only an exact invalid interception backed by ${race} evidence is tolerated`, async () => {
    const f = fixture(method => method === 'Fetch.disable' ? Promise.resolve() : Promise.reject(invalid()));
    f.pause('config');
    if (race === 'navigation') f.navigate('new');
    else f.emit('Network.loadingFailed', { requestId: 'config', canceled: true });
    await f.interception.stop();
  });
}

test('an invalid current-document interception without cancellation fails', async () => {
  const error = invalid();
  const f = fixture(method => method === 'Fetch.disable' ? Promise.resolve() : Promise.reject(error));
  f.pause('config');
  await assert.rejects(f.interception.stop(), received => received === error);
});

test('a later navigation cannot excuse an earlier invalid current-document interception', async () => {
  const error = invalid();
  const f = fixture(method => method === 'Fetch.disable' ? Promise.resolve() : Promise.reject(error));
  f.pause('config');
  await new Promise(resolve => setImmediate(resolve));
  f.navigate('new');
  await assert.rejects(f.interception.stop(), received => received === error);
});

test('unrelated CDP errors on a replaced document and disable errors still fail', async () => {
  for (const method of ['Fetch.continueRequest', 'Fetch.disable']) {
    const error = Object.assign(Error('Unexpected protocol error'), { cdpError: { code: -32602, message: 'Unexpected' } });
    const f = fixture(actual => actual === method ? Promise.reject(error) : Promise.resolve());
    f.pause('config'); f.navigate('new');
    await assert.rejects(f.interception.stop(), received => received === error);
  }
});
