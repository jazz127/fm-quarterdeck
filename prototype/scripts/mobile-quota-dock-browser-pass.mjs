// Offline exact-head phone quota/dock acceptance with the shared isolated Chromium harness.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../server.js';
import { openBrowser } from './browser-harness.mjs';

import { sanitizeQuota } from '../quota.js';

const fixture = sanitizeQuota({ schemaVersion: 5, providers: ['claude', 'codex', 'grok', 'agy'].map(provider => ({
  provider, state: { status: 'fresh', stale: false, refreshedAt: new Date().toISOString() },
  quotaSemantics: { status: 'known', effectiveAvailability: [{
    scope: 'all_models', status: 'known', effectivePercentRemaining: 75,
    boundedBy: ['weekly'], limitingWindowIds: ['weekly'],
  }] },
  windows: [{ id: 'weekly', label: 'weekly', kind: 'weekly', percentRemaining: 75,
    windowSeconds: 604800, resetsAt: new Date(Date.now() + 86400000).toISOString() }],
})) });
assert.equal(fixture.length, 4, 'all synthetic quota providers satisfy the wire schema');
const app = createServer({ FM_DEPLOYMENT_TIER: 'uat' }, { quotaReader: async () => ({ providers: fixture, readAt: new Date().toISOString() }) });
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await openBrowser();
  const { command, evaluate, until } = browser;
  const click = async selector => {
    const point = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}), r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,reachable:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; })()`);
    assert.ok(point.reachable, `${selector} must be tappable`);
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const closed = () => until(`!document.querySelector('#mobile-quota-sheet').open && document.querySelector('.mobile-dock-quota').getAttribute('aria-expanded')==='false' && document.querySelector('.mobile-quota-backdrop').hidden`);
  for (const width of [390, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await command('Emulation.setTouchEmulationEnabled', { enabled: true });
    await command('Page.navigate', { url: `http://127.0.0.1:${app.address().port}/#lanes` });
    await until(`document.querySelector('.mobile-dock-quota') && document.querySelector('.workspace').dataset.view==='conversations'`);
    for (const safeArea of [0, 34]) {
      // Simulate extra safe-area padding; the measured dock offset must follow it.
      await evaluate(`document.querySelector('.mobile-dock').style.paddingBottom='${6 + safeArea}px'`);
      await until(`Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mobile-dock-height'))-document.querySelector('.mobile-dock').getBoundingClientRect().height)<1`);
      await click('.mobile-dock-quota');
      await until(`document.querySelector('#mobile-quota-sheet').open && document.querySelectorAll('.mobile-quota-sheet-row').length===4`);
      const geometry = await evaluate(`(() => { const s=document.querySelector('#mobile-quota-sheet'), r=s.getBoundingClientRect(), d=document.querySelector('.mobile-dock').getBoundingClientRect(); return {bottom:r.bottom,dockTop:d.top,top:r.top,modal:s.matches(':modal'),expanded:document.querySelector('.mobile-dock-quota').getAttribute('aria-expanded'),overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
      assert.ok(Math.abs(geometry.bottom - geometry.dockTop) < 1 && geometry.top >= 11, JSON.stringify(geometry));
      assert.equal(geometry.modal, false);
      assert.equal(geometry.expanded, 'true');
      assert.equal(geometry.overflow, false);
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        const { data } = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(path.join(process.env.SCREENSHOT_DIR, `phone-${width}-quota-safe-${safeArea}.png`), Buffer.from(data, 'base64'));
      }
      await click('.mobile-dock-quota'); await closed();
    }
    await click('.mobile-dock-quota');
    await click('.mobile-dock [data-mobile-view="overview"]'); await closed();
    await until(`document.querySelector('.workspace').dataset.view==='overview'`);
    await click('.mobile-dock-quota');
    await click('.mobile-dock [data-mobile-view="conversations"]'); await closed();
    await until(`document.querySelector('.workspace').dataset.view==='conversations'`);
    await click('.mobile-dock-quota');
    await click('.mobile-dock [data-mobile-view="conversations"]'); await closed();
    await until(`document.querySelector('#lane-options').hidden===false`);
    await click('.mobile-dock-quota');
    await click('#mobile-quota-sheet .mobile-sheet-close'); await closed();
    await click('.mobile-dock-quota');
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await closed();
    await click('.mobile-dock-quota');
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
    await closed();
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await until(`getComputedStyle(document.querySelector('.mobile-dock')).display==='none'`);
  await evaluate(`document.querySelector('.mobile-dock-quota').click()`);
  await closed();
  console.log('390/320px quota geometry, safe-area offset, dock toggles/navigation, close/Escape/backdrop and desktop passed');
} finally {
  await browser?.close();
  await new Promise(resolve => app.close(resolve));
}
