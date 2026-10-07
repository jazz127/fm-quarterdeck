import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/pane-bounds.js', import.meta.url), 'utf8');
function api() {
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);
  return context.window.paneBounds;
}
function harness() {
  const panes = api(), callbacks = {}, frames = [], variables = new Map();
  let writes = 0;
  const style = new Proxy({ margin: '', left: '', top: '', right: '', bottom: '',
    getPropertyValue: key => variables.get(key) || '',
    setProperty(key, value) { if (variables.get(key) !== value) writes++; variables.set(key, value); },
    removeProperty(key) { if (variables.delete(key)) writes++; },
  }, { set(target, key, value) { if (target[key] !== value) writes++; target[key] = value; return true; } });
  const natural = { left: 1200, top: 910, width: 360, height: 180 };
  const pane = { style, hidden: false, isConnected: true, position: 'fixed',
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; },
    getBoundingClientRect() { return { left: parseFloat(style.left) || natural.left, top: parseFloat(style.top) || natural.top,
      width: Math.min(natural.width, parseFloat(variables.get('--pane-max-width')) || Infinity),
      height: Math.min(natural.height, parseFloat(variables.get('--pane-max-height')) || Infinity) }; },
    addEventListener(type, fn) { callbacks[`pane:${type}`] = fn; },
  };
  const vv = { width: 1440, height: 1000, offsetLeft: 0, offsetTop: 0, addEventListener(type, fn) { callbacks[`visual:${type}`] = fn; } };
  const win = { innerWidth: 1440, innerHeight: 1000, visualViewport: vv,
    getComputedStyle(node) { return node === pane ? { position: pane.position } : { getPropertyValue: () => '0px' }; },
    requestAnimationFrame(fn) { frames.push(fn); },
    addEventListener(type, fn) { callbacks[`window:${type}`] = fn; },
    ResizeObserver: class { constructor(fn) { callbacks.growth = fn; } observe() {} unobserve() {} },
    MutationObserver: class { constructor(fn) { callbacks.content = fn; } observe() {} },
  };
  const doc = { documentElement: {}, body: {}, querySelectorAll: () => [pane],
    addEventListener(type, fn, capture) { assert.equal(capture, true); callbacks[`document:${type}`] = fn; },
  };
  const controller = panes.install(win, doc);
  return { panes, pane, natural, vv, win, callbacks, controller, variables, writes: () => writes,
    flush() { while (frames.length) frames.shift()(); }, frameCount: () => frames.length };
}

test('pane geometry clamps all edges in desktop and phone visual viewport/safe areas', () => {
  const { bounds, fit } = api();
  for (const width of [1920, 1440, 834, 390, 320]) {
    const area = bounds({ width, height: 844, left: 11, top: 80 }, { left: 15, right: 15, top: 24, bottom: 34 });
    const placed = fit({ width: 600, height: 1200 }, area, { left: -50, top: 2000 });
    assert.ok(placed.left >= area.left && placed.top >= area.top);
    assert.ok(placed.left + placed.width <= area.right && placed.top + placed.height <= area.bottom);
    assert.equal(placed.height, area.height);
    assert.equal(placed.width, Math.min(600, area.width));
    assert.equal(JSON.stringify(fit(placed, area)), JSON.stringify(placed), 'an already usable pane never jumps');
  }
});

test('initial placement reads final dimensions, then reconciles async content growth without jumping on shrink', () => {
  const h = harness();
  h.controller.place(h.pane, { left: 1430, top: 990 });
  assert.equal(h.pane.style.left, '1072px');
  assert.equal(h.pane.style.top, '812px');
  h.natural.height = 600;
  h.callbacks.growth(); h.callbacks.content();
  assert.equal(h.frameCount(), 1, 'growth and content events coalesce');
  h.flush();
  assert.equal(h.pane.style.top, '392px');
  assert.equal(h.pane.getBoundingClientRect().top + h.pane.getBoundingClientRect().height, 992);
  h.natural.height = 200; h.callbacks.growth(); h.flush();
  assert.equal(h.pane.style.top, '392px', 'shrink keeps a still-valid position');
  const before = h.writes(); h.controller.reconcile();
  assert.equal(h.writes(), before, 'no self-triggering style/resize loop');
});

test('scroll, visual viewport pan/keyboard resize, and desktop resize keep a growing pane bounded', () => {
  const h = harness();
  h.vv.width = 320; h.vv.height = 280; h.vv.offsetLeft = 12; h.vv.offsetTop = 90;
  h.natural.height = 900;
  h.callbacks['visual:resize'](); h.callbacks['visual:scroll'](); h.callbacks['document:scroll'](); h.callbacks['window:resize']();
  assert.equal(h.frameCount(), 1);
  h.flush();
  assert.equal(h.variables.get('--pane-max-height'), '264px');
  assert.equal(h.variables.get('--pane-max-width'), '304px');
  const rect = h.pane.getBoundingClientRect();
  assert.ok(rect.left >= 20 && rect.left + rect.width <= 324);
  assert.ok(rect.top >= 98 && rect.top + rect.height <= 362);
});

test('closing/reparenting restores CSS placement and does not constrain a static mobile annotation child', () => {
  const h = harness();
  h.pane.hidden = true; h.callbacks.content(); h.flush();
  assert.equal(h.pane.style.left, ''); assert.equal(h.pane.style.top, '');
  assert.equal(h.variables.size, 0);
  h.pane.hidden = false; h.pane.position = 'static'; h.callbacks.content(); h.flush();
  assert.equal(h.pane.style.left, ''); assert.equal(h.variables.size, 0);
  h.pane.position = 'fixed'; h.controller.place(h.pane, { left: 100, top: 100 });
  assert.equal(h.pane.style.left, '100px');
  h.callbacks['pane:close']();
  assert.equal(h.pane.style.left, ''); assert.equal(h.variables.size, 0);
});
