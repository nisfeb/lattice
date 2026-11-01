#!/usr/bin/env node
//  ui-swfrag.mjs — the service worker's cache-miss redirect keeps the
//  address whole. A reader navigation the page cache misses is sent on to
//  the same address with u=sw<ts>, which the worker lets through. The u
//  goes in the query: joined on after a #fragment it was part of the
//  fragment, so the worker never saw it and redirected again.
//
//  And the editor's HTML names the worker that goes with it (x-lattice-sw)
//  exactly as sw.js spells its V and PV. sw.js is held five minutes in the
//  http cache, and a worker that reads another tag there fetches itself
//  again: a tag that drifted from sw.js would do that on every editor load.
//
//  Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
//  Never run against production.
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const HOME = env.base + '/apps/lattice';
const PROFILE = mkdtempSync(join(tmpdir(), 'lat-swfrag-'));
const check = makeCheck({ detailOnPass: true });
const browser = await launchBrowser({ profile: PROFILE });
try {
  const [hr, sr] = await Promise.all([
    fetch(HOME + '/app', { headers: { Cookie: env.cookie } }),
    fetch(HOME + '/sw.js')]);
  const m = (await sr.text()).match(/^var V="([^"]*)";var PV="([^"]*)"/);
  const tag = hr.headers.get('x-lattice-sw');
  check('the editor HTML names its worker as sw.js does (x-lattice-sw)',
    hr.ok && !!m && tag === m[1] + ' ' + m[2], JSON.stringify({ status: hr.status, tag, sw: m && m.slice(1) }));
  check('sw.js is held five minutes', sr.headers.get('cache-control') === 'max-age=300',
    sr.headers.get('cache-control'));
  const p = await openPage(browser, env);
  await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let live = false;
  for (let i = 0; i < 60 && !live; i++) {
    live = await p.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!(reg && reg.active);
    }).catch(() => false);
    if (!live) await sleep(1000);
  }
  check('(setup) the service worker is active', live);
  //  a fresh tab, so the worker controls its navigations
  const q = await openPage(browser, env);
  for (const [qs, frag] of [['?a=1&', '#sec'], ['?', '#top']]) {
    const to = HOME + qs + 'z=' + Date.now() + frag;
    let url = null;
    let err = null;
    try {
      await q.goto(to, { waitUntil: 'domcontentloaded', timeout: 60000 });
      url = new URL(q.url());
    } catch (e) { err = String(e.message).slice(0, 100); }
    check('a cache-miss redirect of ' + to.slice(HOME.length) + ' puts u= in the query',
      !!url && url.searchParams.has('u') && url.hash === frag,
      JSON.stringify({ got: url && url.href, err }));
  }
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
check.done();
