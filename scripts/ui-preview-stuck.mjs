//  ui-preview-stuck.mjs: a tab restored in Read keeps a live preview.
//
//  Found by scripts/fuzz-preview.mjs, shrunk to three steps: open a page,
//  switch it to Read, reload. Boot makes the preview frame and puts it in
//  the page a task later (60-preview.js). A tab restored in Read runs
//  showPreview inside boot, which swaps in a fresh frame for the one not
//  yet inserted; the swap was a no-op on a frame with no parent, and the
//  delayed insert then put the FIRST frame in the page. Every write after
//  went to the second frame, which was never shown: a blank pane, through
//  every later open and every Edit/Read toggle, until a reload in Edit.
//
//  The checks read the frame's own document (puppeteer reaches into the
//  sandbox), so they see what is on screen, not what the app wrote.
//
//  Usage: LATTICE_URL=http://localhost:8205 LATTICE_COOKIE=/tmp/cookie \
//           node scripts/ui-preview-stuck.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'pstuck' + (process.pid % 100000);
const A = RUN + '/a', B = RUN + '/b';
const BUDGET = 4000;

const b = await launchBrowser();
const p = await openPage(b, env, { viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false) });
const boot = async () => {
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => window.latTabs && document.querySelectorAll('#treelist a.pg').length > 0,
    { timeout: 90000 });
};
//  the text of the document the visible preview frame holds
const shown = async () => {
  const h = await p.$('#prev');
  const f = h && await h.contentFrame();
  return f ? f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '') : '';
};
const shows = async (word) => {
  for (const t0 = Date.now(); Date.now() - t0 < BUDGET; await sleep(200)) {
    if ((await shown()).includes(word)) return true;
  }
  return false;
};
const front = (key) => p.waitForFunction((k) => {
  const s = window.latTabs.state();
  return s.active >= 0 && s.tabs[s.active].key === k && s.shows;
}, { timeout: 30000 }, key);

try {
  await seed(env, [[A, '# Alpha\n\nPelican harbour lighthouse\n'], [B, '# Bravo\n\nGranite observatory dome\n']]);
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.evaluate(() => { for (const k of ['appTabs', 'appPage']) localStorage.removeItem(k); });
  await boot();

  await p.evaluate((k) => window.latTabs.openIn('page', k), A);
  await front(A);
  await p.evaluate(() => window.latSetRead(true));
  check('Read shows the page', await shows('harbour'), await shown());

  //  the tab comes back in Read
  await boot();
  await front(A);
  check('after a reload in Read, the pane shows the page', await shows('harbour'),
    'pane holds ' + JSON.stringify((await shown()).slice(0, 60)));
  //  and it keeps working: the next open paints too
  await p.evaluate((k) => window.latTabs.openIn('page', k), B);
  await front(B);
  check('the next page opened in Read paints', await shows('observatory'),
    'pane holds ' + JSON.stringify((await shown()).slice(0, 60)));
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await p.evaluate(() => { window.latSetRead(false); }).catch(() => {});
  await b.close();
  for (const n of [A, B, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
