#!/usr/bin/env node
//  ui-shares-live.mjs: shared with me updates live, with no reload.
//
//  Ship B has lattice open in a browser. Ship A shares live/doc with B, and
//  B's tree shows the row within seconds, with a "~A shared live/doc with
//  you" notice that opens it. Then A revokes the share (share-group-del of
//  the ship's group), and the row goes from B's tree, again with no reload.
//  The page is never reloaded: a marker set on window survives the run.
//
//  Usage: LATTICE_URL=http://localhost:8150 LATTICE_COOKIE=/tmp/a-cookie.txt \
//         B_URL=http://localhost:8151 B_COOKIE=/tmp/b-cookie.txt \
//         node scripts/ui-shares-live.mjs
//
//  A two-ship suite. Fake fleet ships only; it never falls back to a real one.
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, shipName } from './lib/harness.mjs';

const unset = ['B_URL', 'B_COOKIE'].filter((v) => !process.env[v]);
if (unset.length) {
  console.error('ui-shares-live: a two-ship suite; set ' + unset.join(', ')
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
const PAGE = 'live/doc';
const ROW = `#treelist a.pg.swm[title^="${ASHIP} "][title$="/page/${PAGE}/code"]`;

const entry = async () => {
  const l = await (await B_('shared-with-me')).json().catch(() => []);
  return l.find((e) => e.host === ASHIP && e.path.endsWith('/page/' + PAGE + '/code')) || null;
};
async function cleanup() {
  await post(A_, 'share-group-del?name=' + q(BSHIP.replace(/^~/, '')));
  const e = await entry();
  if (e) await post(B_, 'shared-with-me-del?host=' + q(ASHIP) + '&path=' + q(e.path));
  await post(A_, 'page-del?name=live');
}

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const until = async (p, fn, arg, ms) => {
  try { await p.waitForFunction(fn, { timeout: ms }, arg); return true; } catch { return false; }
};
try {
  await cleanup();
  check('A has the page', (await post(A_, 'page-save?name=' + PAGE + '&type=md&new=1', '# live')).ok);
  const p = await openPage(browser, benv, { viewport: { width: 1280, height: 900 } });
  await p.goto(benv.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  // the stream registers after boot; give it a moment, then mark the page
  await sleep(4000);
  await p.evaluate(() => { window.__noReload = 1; });
  check('the row is not there before the share', !(await p.$(ROW)));

  const r = await post(A_, 'share-file?name=' + PAGE + '&ship=' + q(BSHIP) + '&mode=read');
  const j = r.ok ? await r.json() : {};
  check('A shares the page and B acks the notice', r.ok && j.notified, JSON.stringify(j));
  const t0 = Date.now();
  check('B\'s tree shows it within 10s, no reload', await until(p, (s) => !!document.querySelector(s), ROW, 10000));
  console.log(`  (row appeared after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  const toast = await p.evaluate(() => {
    const t = document.querySelector('.swtoast');
    return t ? { text: t.textContent, href: t.getAttribute('href') } : null;
  });
  check('a notice names who shared what', !!toast && toast.text === ASHIP + ' shared ' + PAGE + ' with you',
    JSON.stringify(toast));
  check('the notice opens the page', !!toast && toast.href.includes(q('/page/' + PAGE + '/code'))
    && toast.href.includes('ship=' + q(ASHIP)), JSON.stringify(toast));

  const d = await post(A_, 'share-group-del?name=' + q(BSHIP.replace(/^~/, '')));
  check('A revokes the share', d.ok);
  const t1 = Date.now();
  check('the row leaves B\'s tree within 10s', await until(p, (s) => !document.querySelector(s), ROW, 10000));
  console.log(`  (row went after ${((Date.now() - t1) / 1000).toFixed(1)} s)`);
  check('B\'s shared with me no longer lists it', !(await entry()));
  check('the page was never reloaded', await p.evaluate(() => window.__noReload === 1));
  await p.close();
} catch (e) {
  check.bad('suite ran to the end', e.stack || String(e));
} finally {
  await browser.close();
  await cleanup();
}
check.done();
