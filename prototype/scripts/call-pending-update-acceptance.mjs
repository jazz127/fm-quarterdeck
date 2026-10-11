// Focus, draft and acknowledgement acceptance on the existing isolated axi fixture.
// Native refs are required: axi's selector-based click is a DOM click.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function capturePendingUpdates({ browser, evaluate, until, base, head, proof, raw, change, server }) {
  const key = 'decision:alpha-call';
  const selector = `[data-call-key="${key}"]`;
  const reports = [];
  const native = async (action, name, text) => {
    const snapshot = await browser('snapshot', '--full');
    const matches = snapshot.split('\n').filter(line => line.includes(`"${name}"`));
    assert.equal(matches.length, 1, `one fresh native target for ${name}`);
    const uid = matches[0].match(/uid=(\S+)/)?.[1];
    assert.ok(uid?.startsWith('g'), 'generation-bound native reference');
    await browser(action, `@${uid}`, ...(text === undefined ? [] : [text]));
  };
  const tagBox = () => evaluate(`() => { const box=document.querySelector('${selector} [data-call-answer-text]'); box.setAttribute('aria-label','Acceptance draft'); return 'tagged own field'; }`);
  for (const [name, width, height, viewport] of [
    ['desktop', 1280, 900, '1280x900x1'],
    ['tablet', 820, 1180, '820x1180x2,touch'],
    ['phone', 390, 844, '390x844x3,mobile,touch'],
  ]) {
    await browser('newpage', `${base}/#overview`);
    // LIST/SELECT our created target is acquisition setup, including an MCP
    // "No page is currently selected" response from newpage.
    const pages = await browser('pages');
    const own = pages.split('\n').filter(line => line.includes(`${base}/#overview`)).at(-1)?.match(/^\s*(\d+),/)?.[1];
    assert.ok(own, 'list the actually created own target');
    await browser('selectpage', own);
    await browser('emulate', '--viewport', viewport);
    await until(`document.querySelector('${selector} [data-call-answer-text]') && !document.querySelector('${selector}').hidden`);
    await evaluate(`async () => {
      const version=(await fetch('/api/review').then(r=>r.json())).version;
      if(version!==${JSON.stringify(head)} || window.FM_BOOT_REVISION!==version || location.origin!==${JSON.stringify(base)} || innerWidth!==${width})throw Error('source/target/revision/viewport mismatch');
      window.pendingProof={events:[],posts:0};
      for(const type of ['pointerdown','pointerup','click','focusin','focusout','keydown','input'])document.addEventListener(type,e=>pendingProof.events.push({type,trusted:e.isTrusted,pointer:e.pointerType||null,key:e.key||null,card:e.target.closest?.('[data-call-key]')?.dataset.callKey||null}),true);
      const realFetch=window.fetch; window.fetch=(url,...args)=>{if(args[0]?.method==='POST')pendingProof.posts++;return realFetch(url,...args);};
      document.querySelector('#call-lifecycle-filter [data-call-lifecycle="all"]').setAttribute('aria-label','Acceptance outside');
      return {version,href:location.href,width:innerWidth,height:innerHeight,touchPoints:navigator.maxTouchPoints};
    }`);
    await tagBox();
    await native('click', 'Acceptance draft');
    const draft = `  Exact ${name} draft\nSecond line  `;
    await native('fill', 'Acceptance draft', draft);
    await evaluate(`() => { const card=document.querySelector('${selector}'); if(!card.contains(document.activeElement))throw Error('native field focus missing'); pendingProof.card=card; pendingProof.field=document.activeElement; pendingProof.before=card.dataset.callRev; return 'focused typed draft'; }`);
    raw.decisions_open[0].updated_at = new Date().toISOString();
    raw.contributions.captain.find(row => row.task === 'beta-merge').reason = `Independent ${name} update`;
    await change();
    await until(`!!document.querySelector('${selector} [data-call-held]') && document.querySelector('[data-call-key="merge:beta-merge"]').textContent.includes('Independent ${name} update')`);
    const expected = server.bearings.current().cards.find(card => card.key === key).rev;
    const geometry = await evaluate(`() => {
      const card=document.querySelector('${selector}'), field=card.querySelector('[data-call-answer-text]'), notice=card.querySelector('[data-call-held]'), ack=notice.querySelector('button'), body=card.querySelector('.call-chrome');
      if(card!==pendingProof.card||field!==pendingProof.field||field.value!==${JSON.stringify(draft)}||document.activeElement!==field||card.dataset.callRev!==pendingProof.before||card.getAttribute('aria-busy')!=='true'||!notice.textContent.includes('Update incoming')||ack.textContent!=='Show update')throw Error('pending focus/draft/notice identity');
      const grey=getComputedStyle(body), button=getComputedStyle(ack); ack.scrollIntoView({block:'center'}); const r=ack.getBoundingClientRect();
      if(grey.filter!=='grayscale(1)'||grey.backgroundColor==='rgba(0, 0, 0, 0)'||button.pointerEvents==='none'||field.disabled||field.readOnly||r.height<44||r.width<44||r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight||document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('grey body/control/ack geometry');
      return {width:innerWidth,height:innerHeight,grey:grey.backgroundColor,filter:grey.filter,ack:{x:r.x,y:r.y,width:r.width,height:r.height},draftPreserved:true,independentSibling:true};
    }`);
    await browser('screenshot', path.join(proof, `call-pending-${name}.png`));
    if (name === 'tablet') {
      // A real keyboard departure stays within this card when it reaches its
      // acknowledgement, then Enter displays the update without sending.
      let reached = false;
      for (let stop = 0; stop < 12; stop++) {
        await browser('press', 'Tab');
        if ((await evaluate(`() => document.activeElement?.matches('[data-call-update-now]') ? 'ack-ready' : 'other-control'`)).includes('ack-ready')) { reached = true; break; }
      }
      assert.ok(reached, 'Show update reachable by keyboard inside held card');
      await browser('press', 'Enter');
    } else {
      await native('click', 'Show update');
    }
    await until(`document.querySelector('${selector}').dataset.callRev===${JSON.stringify(expected)} && !document.querySelector('${selector} [data-call-held]')`);
    await evaluate(`() => { const card=document.querySelector('${selector}'); if(card.querySelector('[data-call-answer-text]').value!==${JSON.stringify(draft)}||pendingProof.posts)throw Error('ack lost draft or sent'); return 'ack displays only pending revision, preserves exact text'; }`);
    // A new revision must hold an unfocused draft, while no-text siblings update.
    await native('click', 'Acceptance outside');
    raw.decisions_open[0].updated_at = new Date().toISOString();
    await change();
    await until(`!!document.querySelector('${selector} [data-call-held]')`);
    await evaluate(`() => { if(document.querySelector('${selector}').contains(document.activeElement))throw Error('unfocused draft case still focused'); return 'unfocused unsent holds'; }`);
    await native('click', 'Show update');
    await until(`!document.querySelector('${selector} [data-call-held]')`);
    await tagBox();
    await native('click', 'Acceptance draft');
    await native('fill', 'Acceptance draft', '');
    raw.decisions_open[0].updated_at = new Date().toISOString();
    await change();
    await until(`!!document.querySelector('${selector} [data-call-held]')`);
    await evaluate(`() => { if(document.querySelector('${selector} [data-call-answer-text]').value!=='')throw Error('focus-only case has unsent text'); return 'focus alone holds'; }`);
    await native('click', 'Acceptance outside');
    const released = server.bearings.current().cards.find(card => card.key === key).rev;
    await until(`document.querySelector('${selector}').dataset.callRev===${JSON.stringify(released)} && !document.querySelector('${selector} [data-call-held]')`);
    // Assert the no-focus/no-unsent path separately, without an acknowledgement.
    raw.decisions_open[0].updated_at = new Date().toISOString();
    await change();
    await until(`document.querySelector('${selector}').dataset.callRev!==${JSON.stringify(released)} && !document.querySelector('${selector} [data-call-held]')`);
    const input = await evaluate(`() => { if(pendingProof.posts)throw Error('acceptance sent a response'); const events=pendingProof.events; if(!events.some(e=>e.type==='pointerdown'&&e.trusted)||!events.some(e=>e.type==='focusin'&&e.trusted))throw Error('native pointer/focus evidence absent'); return {events,posts:pendingProof.posts,touchObserved:events.some(e=>e.trusted&&e.pointer==='touch')}; }`);
    reports.push({ name, width, height, head, target: own, expected, geometry, input });
    await writeFile(path.join(proof, 'call-pending-acceptance.json'), JSON.stringify({ head, reports, touch: 'Emulation and native tool pointer evidence only; inspect pointer types before claiming touch acceptance.' }, null, 2));
    await browser('closepage', own);
  }
  console.log('PASS pending-update native pointer/focus matrix; touch acceptance requires recorded touch events');
}
