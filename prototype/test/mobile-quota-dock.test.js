import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/shell-panel.js', import.meta.url), 'utf8');
function fixture() {
  const node = () => ({ hidden: false, listeners: {}, attributes: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this.attributes[key] = value; },
    focus() {},
  });
  const button = node(), sheet = node(), close = node(), window = node();
  sheet.open = false;
  sheet.show = () => { sheet.open = true; };
  sheet.close = () => { sheet.open = false; }; // close events are queued by browsers.
  sheet.querySelector = () => close;
  const backdrop = node(), desktop = { matches: false };
  const context = { quotaSheet: sheet, mobileDock: { querySelector: () => button }, desktop,
    window, ResizeObserver: class { observe() {} },
    document: { createElement: () => backdrop, body: { append() {} }, activeElement: {},
      documentElement: { style: { setProperty() {} } } },
    closeChatOptions() {}, chatButton: node(), CustomEvent: class {},
  };
  window.dispatchEvent = () => {};
  vm.runInNewContext(source.slice(source.indexOf('const quotaDockButton ='), source.indexOf('const toolsSheet =')), context);
  return { button, sheet, close, backdrop, desktop, window };
}

test('quota dock toggles a non-modal sheet, backdrop and expanded state', () => {
  const f = fixture();
  f.button.listeners.click();
  assert.equal(f.sheet.open, true);
  assert.equal(f.backdrop.hidden, false);
  assert.equal(f.button.attributes['aria-expanded'], 'true');
  f.button.listeners.click();
  assert.equal(f.sheet.open, false);
  assert.equal(f.backdrop.hidden, true);
  assert.equal(f.button.attributes['aria-expanded'], 'false');
  f.button.listeners.click();
  f.sheet.listeners.close(); // Old queued event must not clear a reopened sheet.
  assert.equal(f.button.attributes['aria-expanded'], 'true');
  assert.equal(f.backdrop.hidden, false);
});

test('close control, backdrop and Escape dismiss quota; desktop cannot open it', () => {
  const f = fixture();
  for (const dismiss of [() => f.close.listeners.click(), () => f.backdrop.listeners.click(),
    () => f.window.listeners.keydown({ key: 'Escape', preventDefault() {} })]) {
    f.button.listeners.click();
    dismiss();
    assert.equal(f.sheet.open, false);
    assert.equal(f.button.attributes['aria-expanded'], 'false');
    assert.equal(f.backdrop.hidden, true);
  }
  f.desktop.matches = true;
  f.button.listeners.click();
  assert.equal(f.sheet.open, false);
});

test('Overview and Fleet close quota before any navigation or filter action', () => {
  const start = source.indexOf('mobileDock.querySelectorAll("[data-mobile-view]").forEach');
  const handlers = [];
  const chatButton = {}, workspace = { dataset: { view: 'conversations' } };
  let closed = false, acted = false;
  vm.runInNewContext(source.slice(start, source.indexOf('function syncMobileRoute()', start)), {
    mobileDock: { querySelectorAll: () => [{ dataset: { mobileView: 'overview' }, addEventListener: (_, fn) => handlers.push(fn) },
      Object.assign(chatButton, { addEventListener: (_, fn) => handlers.push(fn), setAttribute() {} })] },
    chatButton, workspace, desktop: { matches: false }, closeQuotaSheet: () => { closed = true; },
    closeChatOptions() {}, chatSheet: { open: false }, CustomEvent: class {},
    document: { querySelector: () => ({ hidden: false, click() { assert.ok(closed); acted = true; } }) },
    window: { dispatchEvent() { assert.ok(closed); acted = true; } },
  });
  for (const handler of handlers) {
    closed = acted = false;
    handler();
    assert.ok(closed && acted);
  }
});
