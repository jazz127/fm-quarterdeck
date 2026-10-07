#!/usr/bin/env node
// Foreground launcher: the server object, not a PID file, is listener ownership.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const help = `Usage: node prototype/scripts/tailscale-launch.mjs [--help]
Runs clean local UAT in this checkout, in the foreground, on 127.0.0.1:4173.
Requires Node >=18, Git, authenticated Tailscale with HTTPS/Serve enabled,
private tailnet ACLs, and readable absolute FM_HOME (e.g. /absolute/path/to/firstmate).
Optional: PORT (loopback port), TAILSCALE_BIN (CLI path), FM_REVIEW_STATUS_PATH.
Serve must reach THIS process's loopback; Windows/WSL is verified, not assumed.
Refuses any existing root HTTPS :443 route or occupied port, even a matching one.
No Funnel, firewall changes, proxy, install, background app, or Git changes.
Keep this terminal open. Ctrl-C/SIGTERM removes only its unchanged root Serve
route, then closes only its own server. Repeat after it exits. If interrupted
uncleanly, inspect 'tailscale serve status --json' and see docs/tailscale-launch.md
before manually removing an orphan route. Never use 'serve reset' or broad off.
Do not concurrently edit Serve configuration while this launcher is running.
`;

const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])]));
  return value;
}
const same = (a, b) => canonical(a) === canonical(b);
export function inspect(config, dns) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Unrecognized Serve configuration');
  for (const field of ['TCP', 'Web', 'AllowFunnel']) {
    if (config[field] !== undefined && (!config[field] || typeof config[field] !== 'object' || Array.isArray(config[field]))) throw new Error('Unrecognized Serve configuration');
  }
  if (Object.values(config.AllowFunnel || {}).some(Boolean)) throw new Error('Funnel enabled; refuse this topology');
  // Services/foreground configurations and unknown fields are not this launcher’s topology.
  if (Object.keys(config).some(k => !['TCP', 'Web', 'AllowFunnel'].includes(k))) throw new Error('Ambiguous Serve configuration');
  const key = `${dns}:443`;
  if (Object.keys(config.Web || {}).some(k => k.endsWith(':443') && k !== key)) throw new Error('Ambiguous HTTPS hostname');
  const tcp = config.TCP?.['443'];
  if (Object.hasOwn(config.TCP || {}, '443') && !same(tcp, { HTTPS: true })) throw new Error('Port 443 is not plain HTTPS Serve');
  const web = config.Web?.[key];
  if (Object.hasOwn(config.Web || {}, key) && (!web || typeof web !== 'object' || Array.isArray(web))) throw new Error('Unrecognized HTTPS handlers');
  if (web && Object.keys(web).some(k => k !== 'Handlers')) throw new Error('Unrecognized HTTPS handlers');
  if (web && !tcp) throw new Error('HTTPS handlers without HTTPS listener');
  if (web && (!web.Handlers || typeof web.Handlers !== 'object' || Array.isArray(web.Handlers))) throw new Error('Unrecognized HTTPS handlers');
  if (web && Object.hasOwn(web.Handlers, '/') && !web.Handlers['/']) throw new Error('Ambiguous root handler');
  return web?.Handlers?.['/'];
}
export function withRoute(before, dns, target) {
  const after = structuredClone(before);
  after.TCP ||= {};
  after.TCP['443'] = { HTTPS: true };
  after.Web ||= {};
  after.Web[`${dns}:443`] ||= { Handlers: {} };
  after.Web[`${dns}:443`].Handlers ||= {};
  after.Web[`${dns}:443`].Handlers['/'] = { Proxy: target };
  return after;
}

function httpsProbe(url, options = {}) {
  return new Promise((resolveProbe, reject) => {
    const req = request(url, options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error('Oversized probe')); });
      res.on('end', () => resolveProbe({ status: res.statusCode, body }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTPS probe timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function launch({ env = process.env, run = execFile, serverFactory, probe = httpsProbe, log = console.log } = {}) {
  if (!env.FM_HOME?.startsWith('/')) throw new Error('Set absolute FM_HOME');
  if (Object.keys(env).some(k => k.startsWith('GIT_') && !['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'].includes(k))) throw new Error('Unset inherited Git environment overrides');
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024..65535');
  if (env.HOST && env.HOST !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  if (env.FM_PREVIEW_REGISTRY_PATH || env.FM_PREVIEW_ROOT || env.FM_LAVISH_REVIEW_URL || env.FM_LAVISH_REVIEW_SESSION) throw new Error('Standalone UAT only; unset registry/preview/Lavish configuration');
  const git = async args => (await run('git', args, { cwd: root, timeout: 10000 })).stdout.trim();
  const revision = await git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision) || await git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Serving checkout must be clean and committed');
  let cli = env.TAILSCALE_BIN || 'tailscale';
  let cliHelp;
  try { cliHelp = (await run(cli, ['serve', '--help'], { timeout: 10000 })).stdout; }
  catch (error) {
    if (env.TAILSCALE_BIN || error.code !== 'ENOENT') throw error;
    cli = 'tailscale.exe';
    cliHelp = (await run(cli, ['serve', '--help'], { timeout: 10000 })).stdout;
  }
  if (!['--bg', '--https', '--set-path'].every(flag => cliHelp.includes(flag))) throw new Error('Unsupported Tailscale Serve CLI');
  const ts = async args => (await run(cli, args, { timeout: 15000 })).stdout;
  const status = JSON.parse(await ts(['status', '--json']));
  const dns = status.Self?.DNSName?.replace(/\.$/, '');
  if (status.BackendState !== 'Running' || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(dns || '')) throw new Error('Authenticated Tailscale HTTPS DNS name required');
  const origin = `https://${dns}`;
  if (env.FM_REVIEW_ALLOWED_ORIGIN && env.FM_REVIEW_ALLOWED_ORIGIN !== origin) throw new Error('Configured origin differs from device DNS name');
  const readConfig = async () => JSON.parse(await ts(['serve', 'status', '--json'])) ?? {};
  const before = await readConfig();
  if (inspect(before, dns)) throw new Error('Unowned HTTPS :443 root route exists; leave it untouched');
  const target = `http://127.0.0.1:${port}`;
  const expected = withRoute(before, dns, target);
  const serverEnv = { ...env, HOST: '127.0.0.1', PORT: String(port), FM_DEV: '', FM_DEPLOYMENT_TIER: 'uat', FM_REVIEW_ALLOWED_ORIGIN: origin };
  if (!serverFactory) {
    const { access } = await import('node:fs/promises');
    const { constants } = await import('node:fs');
    await access(env.FM_HOME, constants.R_OK);
    serverFactory = (await import('../server.js')).createServer;
  }
  const server = serverFactory(serverEnv);
  let bound = false, attempted = false, closing;
  const close = () => closing ||= (async () => {
    let removalError;
    try {
      if (attempted) {
        const current = await readConfig();
        if (same(current, expected)) {
          await ts(['serve', '--https=443', '--set-path=/', 'off']);
          // Empty maps may be omitted by the CLI after removal.
          const cleaned = await readConfig();
          const normalize = c => {
            c = structuredClone(c);
            for (const [k, web] of Object.entries(c.Web || {})) if (!Object.keys(web.Handlers || {}).length) delete c.Web[k];
            for (const k of ['TCP', 'Web', 'AllowFunnel']) if (c[k] && !Object.keys(c[k]).length) delete c[k];
            return c;
          };
          if (!same(normalize(cleaned), normalize(before))) throw new Error('Serve removal did not restore prior routes; inspect status');
        } else if (!same(current, before)) {
          throw new Error('Serve changed or ownership ambiguous; route left untouched. Inspect status before manual removal');
        }
      }
    } catch (error) { removalError = error; }
    finally {
      if (bound) await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections?.(); });
    }
    if (removalError) throw removalError;
  })();
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolveListen);
    });
    bound = true;
    const local = await fetch(`${target}/api/health`, { signal: AbortSignal.timeout(10000) });
    const health = await local.json();
    const review = await fetch(`${target}/api/review`, { signal: AbortSignal.timeout(10000) });
    if (!local.ok || !health.ok || health.service !== 'fm-quarterdeck' || !review.ok || (await review.json()).version !== revision) throw new Error('Local health/revision mismatch');
    if (!same(await readConfig(), before)) throw new Error('Serve changed during startup; refuse');
    attempted = true;
    await ts(['serve', '--bg', '--https=443', '--set-path=/', target]);
    if (!same(await readConfig(), expected)) throw new Error('Serve mapping differs or unrelated routes changed');
    const externalHealth = await probe(`${origin}/api/health`);
    const externalReview = await probe(`${origin}/api/review`);
    if (externalHealth.status !== 200 || !JSON.parse(externalHealth.body).ok || JSON.parse(externalHealth.body).service !== 'fm-quarterdeck' || externalReview.status !== 200 || JSON.parse(externalReview.body).version !== revision) throw new Error('HTTPS health/revision mismatch');
    // A non-JSON POST reaches the origin guard but cannot create a receipt.
    // Observe the actual wire headers on OUR listener: catches proxy rewriting
    // and a Windows/WSL Serve target that reaches another process/namespace.
    const token = randomUUID();
    let evidence = false;
    const observe = req => {
      if (req.url === `/api/review?launch=${token}` && req.method === 'POST' && req.headers.host === dns && req.headers.origin === origin) evidence = true;
    };
    server.on('request', observe);
    try {
      const guard = await probe(`${origin}/api/review?launch=${token}`, { method: 'POST', headers: { origin, 'content-type': 'text/plain' } });
      if (guard.status !== 415 || !evidence) throw new Error('External Host/Origin evidence did not reach owned listener unchanged');
    } finally { server.off('request', observe); }
    if (await git(['rev-parse', 'HEAD']) !== revision || await git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Checkout changed during verification');
    log(`Private UAT ready: ${origin}\nRevision: ${revision}\nLoopback: ${target}\nKeep this terminal open; Ctrl-C removes the owned route and stops this server.`);
    return { close, server, origin, revision };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], `${error.message}; ${cleanup.message}`); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--help')) { console.error(help); process.exitCode = 1; }
  else if (process.argv.includes('--help')) console.log(help);
  else {
    let session, stopping = false;
    const stop = async () => {
      stopping = true;
      if (!session) return; // Finish startup/rollback first; do not abandon Serve.
      try { await session.close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    };
    const onInt = () => { void stop(); };
    const onTerm = () => { void stop(); };
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    try { session = await launch({ log: text => { if (!stopping) console.log(text); } }); if (stopping) await stop(); }
    catch (error) { console.error(error.message); process.exitCode = 1; process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
  }
}
