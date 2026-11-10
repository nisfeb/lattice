//  ui-taskbox.mjs: a task box in the preview edits the page's source.
//
//  Clicking "- [ ]" in Read writes "[x]" into that one source line (59-md.js
//  data-line, taskToggle; 60-preview.js taskFlip), the save lands like any
//  edit, and Ctrl+Z in the editor takes it back. A box in a code fence is no
//  box, and a duplicate item flips only itself. A read-only view (a past
//  revision) draws its boxes disabled.
//
//  The daily journal (sneagan, 2026-11-06: "checking the box should edit
//  the document to include the X marking it complete"): a page shaped as
//  +orrery-journal-sync writes it (journal/<day>, md, sensitive, orrery's
//  `- [ ] <name> [T<n>]` lines), opened in a tab already in Read. The
//  open's render=1 answer used to repaint the preview with the ship's
//  render, whose boxes are disabled, so a click did nothing. Ticking it
//  must put [x] in the ship's copy, and unticking [ ] back.
//
//  Usage: LATTICE_URL=... LATTICE_COOKIE=... node scripts/ui-taskbox.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const NAME = 'taskbox-' + (process.pid % 100000);
const BODY = '# Tasks\n\n```\n- [ ] fenced\n```\n\n- [ ] same\n- [ ] same\n\n> - [x] quoted\n';
//  line 7 is the second "same"
const WANT = BODY.replace('- [ ] same\n- [ ] same', '- [ ] same\n- [x] same');
const today = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const JNAME = 'journal/' + today.getFullYear() + '-' + p2(today.getMonth() + 1) + '-' + p2(today.getDate())
  + '-tb' + (process.pid % 100000);
//  +journal-body: "# Brief, <day>" then orrery's text, [a/b] made [[a/b]]
const JBODY = '# Brief, ' + JNAME.slice(8) + '\n\nGood morning. Two things today.\n\n## To do\n\n'
  + '- [ ] Call Sam about [[situation/roof]] [T1]\n- [ ] Pay the invoice [T2]\n- To do: water the plants\n';
const JWANT = JBODY.replace('- [ ] Pay the invoice [T2]', '- [x] Pay the invoice [T2]');
//  a page long enough to scroll, its last box far below the fold
const LNAME = 'taskbox-long-' + (process.pid % 100000);
const LBODY = '# Long\n\n' + Array.from({ length: 80 }, (_, i) => 'Filler paragraph ' + i + '.\n').join('\n')
  + '\n- [ ] Way down\n';
const LLINE = LBODY.split('\n').findIndex((l) => l.includes('Way down'));
const LWANT = LBODY.replace('- [ ] Way down', '- [x] Way down');
await seed(env, [[NAME, BODY], [JNAME, JBODY], [LNAME, LBODY]]);
await fetch(env.base + '/apps/lattice/page-sensitive?on=1&name=' + encodeURIComponent(JNAME),
  { method: 'POST', headers: { Cookie: env.cookie } });

const shipBody = async (n = NAME) => {
  const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(n),
    { headers: { Cookie: env.cookie } });
  return r.ok ? (await r.json()).body : null;
};
const b = await launchBrowser();
const p = await openPage(b, env, { viewport: { width: 1400, height: 900 } });
const srcVal = () => p.evaluate(() => document.getElementById('src').value);
const frame = async () => (await p.$('#prev')).contentFrame();
const boxes = async () => (await frame()).evaluate(() => [...document.querySelectorAll('input[type=checkbox]')]
  .map((x) => ({ line: x.dataset.line == null ? null : +x.dataset.line, on: x.checked, off: x.disabled })));
try {
  await p.goto(env.app + '?name=' + encodeURIComponent(NAME), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction((t) => document.getElementById('src').value === t, { timeout: 60000 }, BODY);
  await p.evaluate(() => window.latSetRead(true));
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '').includes('data-line'),
    { timeout: 20000 });
  const bs = await boxes();
  check('the live boxes carry their source lines, none for the fence',
    JSON.stringify(bs.map((x) => [x.line, x.on, x.off])) === '[[6,false,false],[7,false,false],[9,true,false]]',
    JSON.stringify(bs));

  await (await frame()).click('input[data-line="7"]');
  const flipped = await waitFor(async () => (await srcVal()) === WANT, 10000);
  check('a click writes [x] into that line only', !!flipped, JSON.stringify(await srcVal()));
  const saved = await waitFor(async () => (await shipBody()) === WANT, 30000, 500);
  check('and the save lands', !!saved, JSON.stringify(await shipBody()));
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '')
    .includes('data-line="7" checked'), { timeout: 10000 }).catch(() => {});
  check('the preview repaints it checked', (await boxes()).some((x) => x.line === 7 && x.on));

  //  undo: the textarea's own stack, in Edit
  await p.evaluate(() => window.latSetRead(false));
  await p.focus('#src');
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control');
  const undone = await waitFor(async () => (await srcVal()) === BODY, 5000);
  check('Ctrl+Z restores the box', !!undone, JSON.stringify(await srcVal()));
  const resaved = await waitFor(async () => (await shipBody()) === BODY, 30000, 500);
  check('and the undo saves too', !!resaved, JSON.stringify(await shipBody()));

  //  a past revision is read-only: its boxes stay disabled
  await p.evaluate(() => window.latSetRead(true));
  await p.evaluate(() => document.querySelector('#rtabs [data-pt=hist]').click());
  await waitFor(() => p.evaluate(() => document.querySelectorAll('#histlist a').length >= 2), 30000);
  await p.evaluate(() => { const c = document.querySelectorAll('#histlist a'); c[c.length - 1].click(); });
  await waitFor(() => p.evaluate(() => document.getElementById('src').readOnly), 15000);
  await p.waitForFunction(() => { const d = document.getElementById('prev').getAttribute('srcdoc') || '';
    return d.includes('type="checkbox"') && !d.includes('data-line'); }, { timeout: 10000 }).catch(() => {});
  const ro = await boxes();
  check('a read-only view draws its boxes disabled', ro.length === 3 && ro.every((x) => x.off && x.line === null),
    JSON.stringify(ro));
  const before = await srcVal();
  await (await frame()).click('input[type=checkbox]').catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  check('and a click there changes nothing', (await srcVal()) === before);

  //  the journal, opened in a tab that is in Read already: the open's
  //  render=1 answer lands after the local paint and must leave it live
  const rendered = p.waitForResponse((r) => r.url().includes('/page-source?')
    && r.url().includes(encodeURIComponent(JNAME)) && r.url().includes('render=1'), { timeout: 60000 });
  await p.evaluate((n) => window.latTabs.openIn('page', n), JNAME);
  await p.waitForFunction((t) => document.getElementById('src').value === t, { timeout: 60000 }, JBODY);
  await rendered;
  await new Promise((r) => setTimeout(r, 1500));
  const jb = await boxes();
  check('the journal in Read draws live boxes after the ship\'s render lands',
    JSON.stringify(jb.map((x) => [x.line, x.on, x.off])) === '[[6,false,false],[7,false,false]]',
    JSON.stringify(jb));
  await (await frame()).click('input[data-line="7"]').catch(() => {});
  const jsaved = await waitFor(async () => (await shipBody(JNAME)) === JWANT, 30000, 500);
  check('ticking a journal box saves [x] on that line', !!jsaved, JSON.stringify(await shipBody(JNAME)));
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '')
    .includes('data-line="7" checked'), { timeout: 10000 }).catch(() => {});
  await (await frame()).click('input[data-line="7"]').catch(() => {});
  const junsaved = await waitFor(async () => (await shipBody(JNAME)) === JBODY, 30000, 500);
  check('and unticking it saves [ ] back', !!junsaved, JSON.stringify(await shipBody(JNAME)));

  //  sneagan, 2026-11-10: ticking a box while scrolled down jumped Read
  //  back to the top. The repaint must leave the pane where it was.
  await p.evaluate((n) => window.latTabs.openIn('page', n), LNAME);
  await p.waitForFunction((t) => document.getElementById('src').value === t, { timeout: 60000 }, LBODY);
  await p.waitForFunction((l) => (document.getElementById('prev').getAttribute('srcdoc') || '')
    .includes('data-line="' + l + '"'), { timeout: 20000 }, LLINE);
  await new Promise((r) => setTimeout(r, 1500));
  const wrapTop = () => p.evaluate(() => document.querySelector('.prevwrap').scrollTop);
  await p.evaluate(() => { const w = document.querySelector('.prevwrap'); w.scrollTop = w.scrollHeight; });
  const downAt = await wrapTop();
  check('the long page scrolls', downAt > 300, String(downAt));
  await (await frame()).click('input[data-line="' + LLINE + '"]').catch(() => {});
  const lsaved = await waitFor(async () => (await shipBody(LNAME)) === LWANT, 30000, 500);
  check('the far box ticks', !!lsaved, JSON.stringify(await shipBody(LNAME)));
  await new Promise((r) => setTimeout(r, 1500));
  const after = await wrapTop();
  check('and the pane stays scrolled where it was', Math.abs(after - downAt) < 40, downAt + ' -> ' + after);
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  for (const n of [NAME, JNAME, LNAME]) {
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  }
  await b.close();
}
check.done();
