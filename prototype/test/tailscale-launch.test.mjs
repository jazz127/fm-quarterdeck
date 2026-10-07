import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch, inspect, withRoute } from '../scripts/tailscale-launch.mjs';

const sha = 'a'.repeat(40), dns = 'device.example.ts.net';
const initial = { TCP: { '8443': { HTTPS: true }, '443': { HTTPS: true } }, Web: {
  [`${dns}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4389' } } },
  [`${dns}:443`]: { Handlers: { '/other': { Text: 'keep' } } },
} };
function fixture(options = {}) {
  let config = structuredClone(options.before || initial), serverEnv, closed = 0;
  const calls = [], server = new EventEmitter();
  server.listen = (port, host, cb) => {
    assert.equal(host, '127.0.0.1');
    if (options.busy) queueMicrotask(() => server.emit('error', new Error('EADDRINUSE')));
    else cb();
  };
  server.close = cb => { closed++; cb(); };
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return { stdout: args[0] === 'rev-parse' ? sha : options.dirty ? ' M README.md' : '' };
    if (args.join(' ') === 'serve --help') return { stdout: '--bg --https --set-path' };
    if (args.join(' ') === 'status --json') return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${dns}.` } }) };
    if (args.join(' ') === 'serve status --json') return { stdout: JSON.stringify(config) };
    if (args.includes('off')) { config = structuredClone(options.before || initial); return { stdout: '' }; }
    assert.deepEqual(args, ['serve', '--bg', '--https=443', '--set-path=/', 'http://127.0.0.1:49173']);
    config = withRoute(config, dns, args.at(-1));
    if (options.mutationFail) throw new Error('CLI failed after applying');
    return { stdout: '' };
  };
  const probe = async (url, req) => {
    if (req) {
      if (!options.wrongNamespace) server.emit('request', { url: new URL(url).pathname + new URL(url).search, method: req.method,
        headers: { host: options.rewrite ? '127.0.0.1:49173' : dns, origin: req.headers.origin } });
      return { status: options.rewrite ? 403 : 415, body: '' };
    }
    return { status: 200, body: JSON.stringify(url.endsWith('health') ? { ok: true, service: 'fm-quarterdeck' } : { version: options.wrongRevision ? 'b'.repeat(40) : sha }) };
  };
  return {
    deps: { env: { FM_HOME: '/synthetic/home', PORT: '49173', TAILSCALE_BIN: 'double' }, run,
      serverFactory: env => { serverEnv = env; return server; }, probe, log: () => {} },
    calls, server, get config() { return config; }, get closed() { return closed; }, get env() { return serverEnv; },
    change: () => { config.Web[`${dns}:443`].Handlers['/other'] = { Text: 'changed' }; },
  };
}
// No live listener or CLI is used. Local HTTP reads are doubled as well.
const realFetch = globalThis.fetch;
globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('health') ? { ok: true, service: 'fm-quarterdeck' } : { version: sha } });
test.after(() => { globalThis.fetch = realFetch; });

test('foreground ownership, exact UAT origin/revision, preserve routes and repeat after close', async () => {
  const f = fixture();
  const s = await launch(f.deps);
  assert.equal(s.revision, sha);
  assert.equal(f.env.FM_DEPLOYMENT_TIER, 'uat');
  assert.equal(f.env.FM_REVIEW_ALLOWED_ORIGIN, `https://${dns}`);
  assert.equal(f.env.HOST, '127.0.0.1');
  assert.deepEqual(f.config, withRoute(initial, dns, 'http://127.0.0.1:49173'));
  await s.close(); await s.close();
  assert.equal(f.closed, 1);
  assert.deepEqual(f.config, initial);
  const again = await launch(f.deps); await again.close();
  assert.equal(f.closed, 2);
  assert(!f.calls.some(call => call.includes('reset') || call.includes('funnel') || call.includes('--yes')));
});

test('empty Serve configuration is created and removed without resetting', async () => {
  const f = fixture({ before: {} }); const s = await launch(f.deps);
  assert.deepEqual(f.config, withRoute({}, dns, 'http://127.0.0.1:49173'));
  await s.close(); assert.deepEqual(f.config, {});
});

test('refuse existing matching root, busy listener, dirty checkout without mutation', async () => {
  for (const options of [{ before: withRoute(initial, dns, 'http://127.0.0.1:49173') }, { busy: true }, { dirty: true }]) {
    const f = fixture(options);
    await assert.rejects(launch(f.deps), /Unowned|EADDRINUSE|clean/);
    assert(!f.calls.some(call => call.includes('--bg') || call.includes('off')));
    assert.equal(f.closed, 0);
  }
});

test('reject public bind, unexpected environment and invalid port', async () => {
  for (const env of [{ HOST: '0.0.0.0' }, { PORT: '80' }, { FM_PREVIEW_ROOT: '/x' }, { GIT_DIR: '/wrong/repo' }, { FM_REVIEW_ALLOWED_ORIGIN: 'https://wrong.example.ts.net' }]) {
    const f = fixture(); Object.assign(f.deps.env, env);
    await assert.rejects(launch(f.deps));
    assert(!f.calls.some(call => call.includes('--bg')));
  }
});

test('HTTPS revision, namespace and raw Host/Origin failures roll back only owned route', async () => {
  for (const options of [{ wrongRevision: true }, { rewrite: true }, { wrongNamespace: true }, { mutationFail: true }]) {
    const f = fixture(options);
    await assert.rejects(launch(f.deps), /revision|Host\/Origin|CLI failed/);
    assert.deepEqual(f.config, initial);
    assert.equal(f.closed, 1);
  }
});

test('concurrent route edits refuse removal but still close owned listener', async () => {
  const f = fixture(); const s = await launch(f.deps); f.change();
  await assert.rejects(s.close(), /ownership ambiguous/);
  assert.equal(f.closed, 1);
  assert(!f.calls.some(call => call.includes('off')));
});

test('reject Funnel, TCP forwarder, alternate hostname and ambiguous shapes', () => {
  for (const cfg of [
    { AllowFunnel: { [`${dns}:443`]: true } },
    { TCP: { '443': { TCPForward: '127.0.0.1:4' } } },
    { Web: { 'other.example.ts.net:443': { Handlers: {} } } },
    { Foreground: {} },
    { TCP: { '443': { HTTPS: true } }, Web: { [`${dns}:443`]: { Handlers: { '/': null } } } },
  ]) assert.throws(() => inspect(cfg, dns));
});
