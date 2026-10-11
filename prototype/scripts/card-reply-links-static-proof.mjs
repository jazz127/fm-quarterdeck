// Static geometry acceptance on fresh, isolated fixture pages. This does not
// exercise link activation or claim native tablet/phone input acceptance.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireFixturePage } from './browser-harness.mjs';

export async function captureStaticReplyLinks({ browser, evaluate, base, head, proof }) {
  const selectedPage = async () => (await browser('pages')).match(/^\s*(\d+),[^\n]+,true\s*$/m)?.[1];
  const original = await selectedPage();
  assert.ok(original, 'retain the original fixture page');
  try {
    for (const width of [820, 390]) {
      const fresh = await acquireFixturePage(browser, `${base}/#overview`, head);
      assert.ok(fresh && fresh !== original, 'geometry needs a genuinely fresh page');
      try {
        await browser('resize', String(width), '844');
        const geometry = await evaluate(`async () => {
          for (let i = 0; i < 100; i++) {
            const card = document.querySelector('[data-call-key="decision:alpha-call"]');
            if (card?.querySelector('[data-fm-reply] a') && card.querySelector('[data-call-thread-expand]')?.hidden === false) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const version = (await fetch('/api/review').then(response => response.json())).version;
          if (version !== ${JSON.stringify(head)}) throw Error('static link proof revision mismatch');
          const card = document.querySelector('[data-call-key="decision:alpha-call"]');
          if (!card || card.hidden || card.dataset.callLifecycle !== 'active') throw Error('recorded reply card not visible');
          const expand = card.querySelector('[data-call-thread-expand]');
          if (expand.getAttribute('aria-expanded') !== 'true') expand.click();
          const reply = [...card.querySelectorAll('.call-thread-firstmate .call-thread-text')].find(node => node.textContent.startsWith('This call chooses the synthetic release window.'));
          const banner = card.querySelector('[data-fm-reply]');
          if (!reply || !reply.textContent.endsWith('(keep this note).') || banner.hidden) throw Error('recorded reply text missing');
          const anchors = [...banner.querySelectorAll('a'), ...reply.querySelectorAll('a')];
          if (anchors.length !== 4) throw Error('recorded safe links missing');
          const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          const cardBox = box(card);
          const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
          const links = anchors.map(link => {
            const url = new URL(link.href), rect = box(link), style = getComputedStyle(link);
            if (url.protocol !== 'https:' || url.username || url.password || link.target !== '_blank' || link.rel !== 'noopener noreferrer') throw Error('unsafe link');
            if (!link.getClientRects().length || style.visibility !== 'visible' || style.display === 'none' || style.textDecorationLine !== 'underline') throw Error('link not visibly clickable');
            if (rect.width < 44 || rect.height < 44 || rect.x < cardBox.x - 1 || rect.right > cardBox.right + 1) throw Error('link target or containment');
            return { href: link.href, target: link.target, rel: link.rel, ...rect };
          });
          if (links.some((a, i) => links.slice(i + 1).some(b => overlap(a, b)))) throw Error('link targets overlap');
          if (document.documentElement.scrollWidth > innerWidth || card.scrollWidth > card.clientWidth + 1) throw Error('static link overflow');
          banner.scrollIntoView({ block: 'start' });
          return { proof: 'STATIC geometry only; no tablet/phone activation claim', version, width: innerWidth, card: cardBox, links, textPreserved: true, overlapping: false, overflowing: false };
        }`);
        await writeFile(path.join(proof, `captain-reply-links-static-${width}.json`), JSON.stringify({ head, width, result: geometry }, null, 2));
        await browser('screenshot', path.join(proof, `captain-reply-links-static-${width}.png`));
      } finally {
        await browser('closepage', fresh);
      }
    }
  } finally {
    await browser('selectpage', original);
  }
}
