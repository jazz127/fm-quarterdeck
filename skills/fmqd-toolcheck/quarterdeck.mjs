// Read-only integration audit using this skill's reviewed Quarterdeck source,
// never a Firstmate script, installed wrapper or mutable checkout's module.
import { integrate } from '../../scripts/firstmate-integration.mjs';
import path from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export async function quarterdeckReport(home, checkout, git) {
  let status, verify;
  for (const mode of ['status', 'verify']) {
    let result;
    try { result = await integrate(mode, home); }
    catch { result = { ok: false, problems: ['inspection-refused:unsafe-or-invalid-ownership'] }; }
    if (mode === 'status') status = result; else verify = result;
  }
  const main = git(checkout, 'rev-parse', '--verify', 'refs/heads/main');
  const head = git(checkout, 'rev-parse', '--verify', 'HEAD');
  const changes = git(checkout, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all');
  const problems = [...new Set([...(status.problems || []), ...(verify.problems || [])])];
  if (!/^[a-f0-9]{40}$/.test(main || '')) problems.push('checkout-main-unavailable');
  else if (status.revision && status.revision !== main) problems.push('out-of-date-pin');
  if (head !== main) problems.push('checkout-not-on-main-revision');
  if (changes === null) problems.push('checkout-cleanliness-unknown');
  else if (changes) problems.push('checkout-dirty');
  const script = quote(path.join(checkout, 'scripts/firstmate-integration.mjs'));
  const node = quote(process.execPath), selected = quote(home);
  let reinstall = 'unavailable: establish a reviewed checkout with local main';
  if (/^[a-f0-9]{40}$/.test(main || '')) {
    const install = `${node} ${script} install ${selected} ${quote(main)}`;
    if (status.installed) {
      // Preserve private settings before uninstall removes its owned config.
      reinstall = `(config=$(mktemp) && trap 'rm -f -- "$config"' EXIT && cp -- ${quote(path.join(home, 'state/quarterdeck-health.json'))} "$config" && ${node} ${script} uninstall ${selected} && ${install} "$config")`;
    } else reinstall = install;
  }
  return { checkout, main, installedRevision: status.revision || null, status, verify, problems, reinstall };
}
