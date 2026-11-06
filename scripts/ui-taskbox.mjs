//  ui-taskbox.mjs: a task box in the preview edits the page's source.
//
//  Clicking "- [ ]" in Read writes "[x]" into that one source line (59-md.js
//  data-line, taskToggle; 60-preview.js taskFlip), the save lands like any
//  edit, and Ctrl+Z in the editor takes it back. A box in a code fence is no
//  box, and a duplicate item flips only itself. A read-only view (a past
//  revision) draws its boxes disabled.
//
//  Usage: LATTICE_URL=... LATTICE_COOKIE=... node scripts/ui-taskbox.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const NAME = 'taskbox-' + (process.pid % 100000);
const BODY = '# Tasks\n\n```\n- [ ] fenced\n```\n\n- [ ] same\n- [ ] same\n\n> - [x] quoted\n';
//  line 7 is the second "same"
const WANT = BODY.replace('- [ ] same\n- [ ] same', '- [ ] same\n- [x] same');
await seed(env, [[NAME, BODY]]);

const shipBody = async () => {
  const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(NAME),
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
    JSON.stringify(bs.map((x) => [x.line, x.on, x.off])) === '[[6,false,false],[7,false,false],[10,true,false]]',
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
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(NAME),
    { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  await b.close();
}
check.done();
