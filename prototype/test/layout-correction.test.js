import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseCss, computed, element } from './helpers/css-model.mjs';
import { inspectKpiGeometry } from '../scripts/kpi-geometry.mjs';

const css = parseCss(await readFile(new URL('../public/styles.css', import.meta.url), 'utf8'));
const shellCss = parseCss(await readFile(new URL('../public/shell-panel.css', import.meta.url), 'utf8'));
const window = { localStorage: { getItem: () => null } };
const context = vm.createContext({ window });
for (const file of ['message-kinds.js', 'filter-view.js']) vm.runInContext(await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
function buttons(html) {
  return [...html.matchAll(/<button\b([^>]+)>([\s\S]*?)<\/button>/g)].map(([, attributes, body]) => ({
    attrs: Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])), body,
  }));
}

test('all eleven emitted kind glyphs remain visible expanded, collapsed, hovered and keyboard-focused; phone rules are unchanged', () => {
  const body = element('div', ['conversation-body']);
  const panel = element('aside', ['conversation-kind-panel'], {}, body, 'conversation-kind-panel');
  const row = element('div', ['message-type-row'], {}, panel);
  const option = element('label', ['message-type-option'], {}, row);
  element('input', [], {}, option, '', ['checked']);
  const glyph = element('span', ['message-kind-glyph'], {}, option);
  const label = element('span', ['message-kind-label'], {}, option);
  const markup = window.filterView.kindFiltersHtml(window.messageKinds.TYPES, new Set(['captain']), String);
  assert.equal(window.messageKinds.TYPES.length, 11);
  assert.equal([...markup.matchAll(/class="message-kind-svg"/g)].length, 11);
  assert.equal([...markup.matchAll(/<input[^>]*aria-label="[^"]+"/g)].length, 11, 'one named checkbox per kind');
  assert.match(markup, /aria-label="Firstmate progress"/);
  assert.equal(buttons(markup).length, 22, 'previous/next controls have their own accessible names');
  const jumps = element('div', ['kind-message-jumps'], {}, row);
  const jump = element('button', ['kind-message-jump'], {}, jumps);
  assert.equal(computed(css, jumps).display, 'flex');
  assert.equal(computed(css, jump, 390).width, '44px');
  assert.equal(computed(css, jump, 390).height, '44px');
  assert.equal(computed(css, glyph).display, 'inline');
  panel.attrs['data-collapsed'] = 'true';
  for (const states of [[], ['hover'], ['focus-within']]) {
    panel.states = states;
    assert.equal(computed(css, glyph).display, 'inline-grid');
    assert.equal(computed(css, glyph).width, '22px');
    assert.equal(computed(css, label).display, states.length ? 'inline' : 'none');
    assert.equal(computed(css, jumps).display, states.length ? 'flex' : 'none');
  }
  panel.states = [];
  assert.equal(computed(css, glyph, 390).display, 'inline');
  assert.equal(computed(css, glyph, 320).display, 'inline');
});

test('collapsed lane rail emits pinned All first and named vertical-label lane controls in native focus order', () => {
  const lanes = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }];
  const controls = buttons(window.filterView.collapsedRailHtml(lanes, new Set(['alpha']), String));
  assert.equal(controls.length, 3);
  assert.equal(controls[0].attrs['data-filter-all'], 'true');
  assert.equal(controls[0].attrs['aria-pressed'], 'false');
  assert.equal(controls[0].body, '<span>All</span>');
  assert.deepEqual(controls.slice(1).map(control => control.attrs['data-lane-id']), ['alpha', 'beta']);
  for (const control of controls.slice(1)) {
    assert.ok(control.attrs['aria-label']);
    assert.ok(control.body.includes('<span class="lane-rail-label"'));
    assert.ok(!control.body.includes('<svg'));
    assert.equal(control.attrs.tabindex, undefined);
  }
  assert.equal(buttons(window.filterView.collapsedRailHtml(lanes, new Set(['alpha', 'beta']), String))[0].attrs['aria-pressed'], 'true');
  const panel = element('aside', ['lane-filter'], { 'data-collapsed': 'true' }, null, 'lane-options');
  const rail = element('div', ['lane-collapsed-rail'], {}, panel);
  const all = element('button', ['lane-rail-item', 'lane-rail-all'], {}, rail);
  const lane = element('button', ['lane-rail-item'], {}, rail);
  assert.equal(computed(css, all).position, 'sticky');
  assert.equal(computed(css, all).top, '0');
  assert.equal(computed(css, all)['writing-mode'], 'horizontal-tb');
  assert.equal(computed(css, all).transform, 'none');
  assert.equal(computed(css, element('span', [], {}, all)).display, 'block');
  const label = element('span', ['lane-rail-label'], {}, lane);
  assert.equal(computed(css, label).display, 'block');
  assert.equal(computed(css, label)['writing-mode'], 'vertical-rl');
  assert.equal(computed(css, all)['writing-mode'], 'horizontal-tb');
  assert.equal(computed(css, rail, 320).display, 'none');
});

test('context owns independent bounded context/history scrolling in desktop and phone drawer layouts', () => {
  const workspace = element('div', ['workspace']);
  const rail = element('aside', ['context-rail'], {}, workspace, 'context-rail');
  const content = element('section', ['lane-context'], {}, rail);
  const history = element('details', ['session-history'], { open: '' }, rail);
  const summary = element('summary', [], {}, history);
  for (const width of [1920, 1440, 834, 390, 320]) {
    const rules = [...css, ...shellCss];
    assert.equal(computed(rules, rail, width).overflow, 'hidden');
    assert.equal(computed(rules, content, width).flex, '1 1 0');
    assert.equal(computed(rules, content, width)['min-height'], '0');
    assert.equal(computed(rules, content, width)['overflow-y'], 'auto');
    assert.equal(computed(rules, history, width)['max-height'], 'min(42dvh, 420px)');
    assert.equal(computed(rules, history, width)['overflow-y'], 'auto');
    assert.equal(computed(rules, summary, width).position, 'sticky');
  }
});

for (const width of [390, 320]) test(`${width}px KPI evidence separates visible three-column fit, real clipping, and hidden Work Split cards`, () => {
  const cell = (width - 36) / 3;
  const cards = [0, 1, 2].map(index => ({ left: 12 + index * (cell + 6), right: 12 + index * (cell + 6) + cell,
    top: 100, bottom: 164, width: cell, height: 64, clientWidth: cell, scrollWidth: cell }));
  const diagnostic = { overviewActive: true, viewport: { width, clientWidth: width }, grid: { left: 12, right: width - 12, width: width - 24, height: 64 }, cards };
  assert.deepEqual(inspectKpiGeometry(diagnostic), { applicable: true, failures: [] });
  cards[2].right = width + 1;
  assert.ok(inspectKpiGeometry(diagnostic).failures.includes('Card 2 is clipped horizontally'));
  assert.deepEqual(inspectKpiGeometry({ ...diagnostic, overviewActive: false, cards: cards.map(() => ({ width: 0, height: 0, top: 0, right: 0 })) }), { applicable: false, failures: [] });
});
