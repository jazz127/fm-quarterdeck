import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseCss, computed, element } from './helpers/css-model.mjs';

const css = parseCss(await readFile(new URL('../public/styles.css', import.meta.url), 'utf8'));
const shellCss = parseCss(await readFile(new URL('../public/shell-panel.css', import.meta.url), 'utf8'));
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('skip link is the first control and the main stage can take focus', () => {
  assert.match(html, /<body>\s*<a class="skip-link" href="#main-stage">Skip to content<\/a>/);
  assert.match(html, /<div class="main-stage" id="main-stage" tabindex="-1">/);
  const link = element('a', ['skip-link']);
  assert.equal(computed(css, link).position, 'absolute');
  link.states = ['focus'];
  assert.equal(computed(css, link, 390).position, 'fixed');
  assert.equal(computed(css, link, 390)['min-height'], '44px');
  assert.equal(computed(css, link, 360)['z-index'], '200');
});

test('fleet info control has a name that is not the glyph', () => {
  assert.match(html, /id="lane-filter-info"[^>]*aria-label="About included fleets"/);
  assert.match(html, /id="lane-filter-info"[^>]*>\s*<span aria-hidden="true">i<\/span>/);
});

test('phone touch targets that were under 44px meet the minimum at 360 and 390', () => {
  const clear = element('button', ['search-clear']);
  const task = element('button', [], {}, element('span', ['task-filter-chip']));
  const status = element('button', ['status-filter-btn']);
  const scan = element('button', [], {}, element('div', ['scan-controls']));
  const ack = element('button', [], { 'data-ack-task': 'slice' }, element('li', ['work-slice']));
  const summary = element('summary', [], {}, element('details', ['review-meta']));
  const help = element('button', ['review-gesture-help'], {}, element('footer', ['source-status']));
  const select = element('select');
  select.parent = element('label', ['lane-status-control'], {}, element('section', ['lane-filter'], {}, element('div', ['conversation-body'])));
  for (const width of [360, 390]) {
    assert.equal(computed(css, clear, width)['min-height'], '44px', `search clear ${width}`);
    assert.equal(computed(css, clear, width).width, '44px', `search clear width ${width}`);
    assert.equal(computed(css, task, width).width, '44px', `task clear ${width}`);
    assert.equal(computed(css, task, width).height, '44px', `task clear height ${width}`);
    assert.equal(computed(css, status, width)['min-height'], '44px', `status filter ${width}`);
    assert.equal(computed(css, status, width).height, '44px', `status filter height ${width}`);
    assert.equal(computed(css, scan, width)['min-height'], '44px', `scan ${width}`);
    assert.equal(computed(css, ack, width)['min-height'], '44px', `ack ${width}`);
    assert.equal(computed(css, summary, width).width, '44px', `review meta ${width}`);
    assert.equal(computed(css, summary, width).height, '44px', `review meta height ${width}`);
    assert.equal(computed(css, help, width).width, '44px', `gesture help ${width}`);
    assert.equal(computed(css, select, width)['min-height'], '44px', `fleet status ${width}`);
  }
  assert.equal(computed(css, ack, 1280)['min-height'], '44px');
  assert.equal(computed(css, status, 1280)['min-height'], '36px', 'desktop status filters stay compact');
  assert.equal(computed(css, clear, 1280)['min-height'], '32px', 'desktop search clear stays in the field');
});

test('phone expense ledger stacks instead of forcing a 980px sideways scroll', () => {
  assert.match(app, /class="expense-cell-label">Date<\/span>/);
  assert.match(app, /data-label="Description \/ note"/);
  assert.match(app, /data-label="Confidence \/ basis"/);
  const table = element('table', ['expense-table']);
  const label = element('span', ['expense-cell-label']);
  const sort = element('button', [], {}, element('th', [], {}, element('tr', [], {}, element('thead', [], {}, table))));
  assert.equal(computed(css, table, 1280)['min-width'], '980px');
  assert.equal(computed(css, label, 1280).display, 'none');
  for (const width of [360, 390]) {
    assert.equal(computed(css, table, width)['min-width'], '0', String(width));
    assert.equal(computed(css, table, width).display, 'block', String(width));
    assert.equal(computed(css, label, width).display, 'block', String(width));
    assert.equal(computed(css, sort, width)['min-height'], '44px', String(width));
  }
});

test('narrow overview labels can wrap at 360 and 390', () => {
  const tab = element('button', [], {}, element('div', ['overview-section-tabs'], {}, element('section', [], { id: 'overview-view' })));
  tab.parent.parent.id = 'overview-view';
  for (const width of [360, 390]) {
    assert.equal(computed(css, tab, width)['overflow-wrap'], 'anywhere', String(width));
    assert.equal(computed(css, tab, width)['font-size'], '12px', String(width));
  }
  assert.notEqual(computed(css, tab, 720)['font-size'], '12px');
});

test('reduced motion removes leftover transitions and animations', async () => {
  const source = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const start = source.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const block = source.slice(start, source.indexOf('\n}', start) + 2);
  for (const selector of ['.quota-badge', '.quota-accordion-summary::after', '.taxonomy-node > summary::before', '.jump-to-latest', '.work-slice button[data-ack-task]']) {
    assert.match(block, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(block, /transition: none;/);
  assert.match(block, /animation: none;/);
});

test('navigation collapse control stays a 44px target on the phone shell', () => {
  const workspace = element('main', ['workspace']);
  const toggle = element('button', [], {}, workspace, 'shell-panel-toggle');
  for (const width of [360, 390, 720]) {
    assert.equal(computed(shellCss, toggle, width).width, '44px', String(width));
    assert.equal(computed(shellCss, toggle, width)['min-height'], '44px', String(width));
  }
});
