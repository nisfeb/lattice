#!/usr/bin/env node
//  ui-follow-live.mjs: following a shared folder, live, with no reload.
//
//  Ship A shares the folder follow/ with ship B. B's reader shows a Follow
//  button on the folder's index, and B follows it. B has lattice open: its
//  tree lists the folder under following with no count. A adds a page to
//  the folder, and B's row says "1 new" within seconds; opening the page
//  clears it. Then A unshares the folder, and B's row says unavailable.
//  The page is never reloaded: a marker set on window survives the run.
//
//  Usage: LATTICE_URL=http://localhost:8150 LATTICE_COOKIE=/tmp/a-cookie.txt \
//         B_URL=http://localhost:8151 B_COOKIE=/tmp/b-cookie.txt \
//         node scripts/ui-follow-live.mjs
//
//  A two-ship suite. Fake fleet ships only; it never falls back to a real one.
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, shipName } from './lib/harness.mjs';

const unset = ['B_URL', 'B_COOKIE'].filter((v) => !process.env[v]);
if (unset.length) {
  console.error('ui-follow-live: a two-ship suite; set ' + unset.join(', ')
    + ' to a second fake ship. It never falls back to a real ship.');
  process.exit(2);
}
const env = shipEnv();
const benv = shipEnv({ urlVar: 'B_URL', cookieVar: 'B_COOKIE' });
const check = makeCheck();
const q = encodeURIComponent;
const A_ = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie } });
const B_ = (path, init = {}) => fetch(benv.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: benv.cookie } });
const post = (f, path, body) => f(path, { method: 'POST', body });
const ASHIP = await shipName(env);
const BSHIP = await shipName(benv);
const DIR = 'follow';
const FQ = 'host=' + q(ASHIP) + '&path=' + q('/' + DIR);
const ROW = `#treelist .fld.fol[data-fold="${ASHIP}/${DIR}"]`;

const follows = async () => (await (await B_('folder-follows')).json().catch(() => []))
  .find((f) => f.host === ASHIP && f.path === '/' + DIR) || null;
async function cleanup() {
  await post(B_, 'folder-unfollow?' + FQ);
  await post(A_, 'share-group-del?name=' + q(BSHIP.replace(/^~/, '')));
  await post(A_, 'page-del?name=' + DIR);
}

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const until = async (p, fn, arg, ms) => {
  try { await p.waitForFunction(fn, { timeout: ms }, arg); return true; } catch { return false; }
};
const badge = (p) => p.evaluate((s) => {
  const r = document.querySelector(s);
  const b = r && r.querySelector('.folnew');
  return r ? (b ? b.textContent : '') : null;
}, ROW);
try {
  await cleanup();
  check('A has the page', (await post(A_, 'page-save?name=' + DIR + '/first&type=md&new=1', '# First')).ok);
  const sh = await post(A_, 'share-file?name=' + DIR + '&ship=' + q(BSHIP) + '&mode=read');
  check('A shares the folder with B', sh.ok);
  // the index offers Follow once B can read it
  const idx = '?url=' + q('urb://' + ASHIP + '/' + DIR + '/');
  let txt = '';
  for (let i = 0; i < 30 && !txt.includes('folder-follow?'); i++) {
    txt = await (await B_(idx)).text();
    if (!txt.includes('folder-follow?')) await sleep(2000);
  }
  check('B\'s reader offers Follow on the folder index', txt.includes('>Follow</button>'), txt.slice(-300));
  const fr = await post(B_, 'folder-follow?' + FQ);
  check('B follows the folder', fr.ok);
  const f0 = await follows();
  check('the follow reads, with nothing new', !!f0 && f0.ok && f0.new === 0 && f0.pages.length === 1,
    JSON.stringify(f0));
  txt = await (await B_(idx)).text();
  check('the index then says Following', txt.includes('>Following</button>'));

  const p = await openPage(browser, benv, { viewport: { width: 1280, height: 900 } });
  await p.goto(benv.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  check('B\'s tree lists the followed folder', await until(p, (s) => !!document.querySelector(s), ROW, 90000));
  await sleep(4000);       // the keep registers after boot
  await p.evaluate(() => { window.__noReload = 1; });
  check('no count before A adds a page', (await badge(p)) === '', await badge(p));

  check('A adds a page', (await post(A_, 'page-save?name=' + DIR + '/second&type=md&new=1', '# Second')).ok);
  const t0 = Date.now();
  const got = await until(p, (s) => {
    const b = document.querySelector(s + ' .folnew');
    return !!b && b.textContent === '1 new';
  }, ROW, 30000);
  check('B sees "1 new" within 30s, no reload', got, JSON.stringify({ badge: await badge(p), f: await follows() }));
  console.log(`  (count appeared after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  // shared with me lists the folder once (%dir), with the follow's count,
  // and no page of it on its own; unfolded, it lists the pages
  const SROW = `#treelist .fld.swdir[title="${ASHIP} /${DIR}/"]`;
  const srow = await until(p, (s) => {
    const r = document.querySelectorAll(s);
    const b = r.length === 1 && r[0].querySelector('.folnew');
    return !!b && b.textContent === '1 new';
  }, SROW, 15000);
  check('shared with me lists the folder once, with "1 new"', srow, JSON.stringify(await p.evaluate(() =>
    [...document.querySelectorAll('#treelist .swdir, #treelist a.pg.swm')].map((a) => a.title))));
  check('and no page of it on its own', !(await p.$(`#treelist a.pg.swm[title$="/page/${DIR}/first/code"]`)));
  const pg0 = await p.evaluate(() => document.querySelectorAll('#treelist a.folpg').length);
  await p.click(SROW + ' .fln');
  check('the folder entry unfolds to its 2 pages', await until(p, (n) =>
    document.querySelectorAll('#treelist a.folpg').length === n + 2, pg0, 10000));

  // opening the new page clears it
  const seen = await post(B_, 'folder-seen?' + FQ + '&key=' + q('/' + DIR + '/second'));
  const f1 = await follows();
  check('a page seen is no longer new', seen.ok && !!f1 && f1.new === 0, JSON.stringify(f1));

  check('A unshares the folder', (await post(A_, 'share-group-del?name=' + q(BSHIP.replace(/^~/, '')))).ok);
  const t1 = Date.now();
  const gone = await until(p, (s) => {
    const b = document.querySelector(s + ' .folnew');
    return !!b && b.textContent === 'unavailable';
  }, ROW, 40000);
  check('B sees the folder as unavailable within 40s', gone,
    JSON.stringify({ badge: await badge(p), f: await follows() }));
  console.log(`  (unavailable after ${((Date.now() - t1) / 1000).toFixed(1)} s)`);
  const f2 = await follows();
  check('the follow stays listed, unavailable', !!f2 && f2.ok === false, JSON.stringify(f2));
  check('the page was never reloaded', await p.evaluate(() => window.__noReload === 1));
  // unfollow is one click: the row's x
  await p.click(ROW + ' .folrm');
  check('the x unfollows', await until(p, (s) => !document.querySelector(s), ROW, 10000));
  check('the ship no longer lists it', !(await follows()));
  await p.close();
} catch (e) {
  check.bad('suite ran to the end', e.stack || String(e));
} finally {
  await browser.close();
  await cleanup();
}
check.done();
