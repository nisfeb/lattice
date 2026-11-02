#!/usr/bin/env node
// A change made elsewhere right after this tab writes must still show.
//
// Every write of ours bumps the beacon, and that echo is swallowed so the
// tab does not refetch what it just wrote. The ship can send the bump BEFORE
// the write's answer (a page-del's comes with it). Counting the echo again
// on landing left one owed, and it swallowed the next real remote bump: a
// page made elsewhere after a delete never showed until a focus. Nothing
// here nudges focus, so only the beacon can bring the changes in.
//
// Usage: node scripts/ui-missedremote.mjs   (LATTICE_URL, LATTICE_COOKIE)
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor, seed, swControlled } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'uimr-' + process.pid;
const P = RUN + '/open', DOOMED = RUN + '/doomed', NEW = RUN + '/made-elsewhere';
const check = makeCheck();
const post = (path, body) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie }, body });
const browser = await launchBrowser();
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check.bad('page threw: ' + e.message.slice(0, 80)),
});
page.on('dialog', (d) => { if (d.type() === 'beforeunload') d.accept(); });
await page.evaluateOnNewDocument(() => {
  for (const f of ['prompt', 'confirm', 'alert'])
    window[f] = () => { throw new Error('native ' + f + '() used'); };
});
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const srcIs = (b) => page.evaluate((x) => document.getElementById('src').value === x, b);
const inTree = (n) => page.evaluate((x) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.href.includes(encodeURIComponent(x))), n);
// the tree dumps this tab asks for: one after our own write is the echo
let dumps = 0;
page.on('request', (r) => { if (r.url().includes('/page-dump')) dumps++; });

let step = 'boot';
try {
  await seed(env, [[P, '# start'], [DOOMED, '# doomed']]);
  await page.goto(env.app + '?name=' + encodeURIComponent(DOOMED), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await swControlled(page);
  await wait(() => document.getElementById('src').value === '# doomed');
  await sleep(5000);                   // the stream registers

  // ── 1. delete here, then a page is made elsewhere ──────────────────────
  step = 'after a delete';
  await page.evaluate(() => document.getElementById('del').click());
  await wait(() => !document.getElementById('dlg').hidden);
  await page.evaluate(() => document.getElementById('dlgok').click());
  await waitFor(async () => !(await inTree(DOOMED)), 60000, 250);
  await sleep(6000);                   // past the echo window
  await post('page-save?type=md&new=1&name=' + encodeURIComponent(NEW), '# new');
  check('after a delete, a page made elsewhere shows in the tree',
    await waitFor(() => inTree(NEW), 20000, 250), 'not in the tree after 20 s');

  // ── 2. save here, then the open page is edited elsewhere ───────────────
  step = 'after a save';
  await page.goto(env.app + '?name=' + encodeURIComponent(P), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.getElementById('src').value === '# start');
  await sleep(5000);
  dumps = 0;
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# mine'; s.dispatchEvent(new Event('input'));
  });
  await waitFor(async () => {
    const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(P),
      { headers: { Cookie: env.cookie } });
    return r.ok && (await r.json()).body.trim() === '# mine';
  }, 60000, 250);
  await sleep(8000);                   // our echo arrives and the window shuts
  check('our own save does not refetch the tree (its echo is swallowed)', dumps === 0, dumps + ' dumps');
  check('and the text typed is kept', await srcIs('# mine'));
  await post('page-save?type=md&name=' + encodeURIComponent(P), '# elsewhere');
  check('after a save, an edit made elsewhere shows in the open page',
    await waitFor(() => srcIs('# elsewhere'), 20000, 250), 'not shown after 20 s');
} catch (e) {
  check.bad(step + ': ' + e.message.slice(0, 120));
} finally {
  for (const n of [P, DOOMED, NEW]) await post('page-del?name=' + encodeURIComponent(n)).catch(() => {});
  await post('page-del?name=' + RUN).catch(() => {});
  await browser.close();
}
check.done();
