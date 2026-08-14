#!/usr/bin/env node
//  ui-navbar.mjs — the reader's browser bar: contextual back/forward over
//  the tab's own visit stack, the hamburger holding editor/knowledge/
//  bookmarks/settings, Go beside the omnibar, and Enter == Go.
//
//  Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
import { readFileSync } from 'fs';
import { homedir } from 'os';

const BASE = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const CKF = (process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie')
  .replace(/^~/, homedir());
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const puppeteer = (await import('puppeteer-core')).default;
const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');
let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
});
const p = await browser.newPage();
await p.setCookie({ name: cn, value: cr.join('='), domain: new globalThis.URL(BASE).hostname, path: '/' });
const HOME = BASE + '/apps/lattice';
const PAGE = HOME + '?url=' + encodeURIComponent('urb://~tyr/harnessdir/one');
const st = () => p.evaluate(() => ({
  b: document.getElementById('navb')?.disabled,
  f: document.getElementById('navf')?.disabled,
  ham: !!document.getElementById('ham'),
  menuHidden: document.getElementById('hammenu')?.hidden,
  links: [...(document.getElementById('hammenu')?.querySelectorAll('a') || [])]
    .map((a) => a.getAttribute('href')),
  // Go must be the input's NEXT element; the hamburger the bar's LAST
  goNext: document.querySelector('.bar input[name=url]')?.nextElementSibling?.textContent,
  // the omni suggest box is appended after everything and positioned
  // absolutely — the hamburger must be the last CONTROL, not the last node
  lastEl: (() => { const els = [...document.querySelectorAll('.bar > *')]
    .filter((e) => !e.classList.contains('omni'));
    return els[els.length - 1]?.className; })(),
}));

// fresh tab: nothing to go back or forward to
await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
let s = await st();
check('back is disabled on a fresh tab', s.b === true, JSON.stringify(s.b));
check('forward is disabled on a fresh tab', s.f === true, JSON.stringify(s.f));
check('the hamburger exists and starts closed', s.ham && s.menuHidden === true);
check('the hamburger holds editor/knowledge/bookmarks/settings',
  JSON.stringify(s.links) === JSON.stringify([
    '/apps/lattice/app', '/apps/lattice/know', '/apps/lattice/marks', '/apps/lattice/settings']),
  JSON.stringify(s.links));
check('Go sits just right of the omnibar', s.goNext === 'Go', s.goNext);
check('the hamburger is the last thing in the bar', s.lastEl === 'hamw', s.lastEl);

// navigate: back lights up, forward stays off
await p.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
s = await st();
check('back enables after a navigation', s.b === false, JSON.stringify(s.b));
check('forward stays disabled at the stack top', s.f === true, JSON.stringify(s.f));

// go back: land home with forward now available
await p.evaluate(() => document.getElementById('navb').click());
await p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(800);
s = await st();
check('back returns to the previous page', p.url().replace(/\/$/, '') === HOME, p.url());
check('and forward is now available', s.f === false, JSON.stringify(s.f));

// forward again
await p.evaluate(() => document.getElementById('navf').click());
await p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await sleep(800);
check('forward returns to the page', p.url() === PAGE, p.url());

// the hamburger opens, and a document click closes it
await p.evaluate(() => document.getElementById('ham').click());
s = await st();
check('the hamburger opens on click', s.menuHidden === false);
await p.evaluate(() => document.body.click());
s = await st();
check('and closes on a click elsewhere', s.menuHidden === true);

// Enter in the omnibar submits like Go (from a fresh view: probed to
// work on fresh AND bfcache-restored pages; the traversal sequence
// above leaves headless focus in a state that eats synthetic keys)
await p.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.click('.bar input[name=url]', { clickCount: 3 });
await p.type('.bar input[name=url]', 'urb://~tyr/harnessdir/other');
await p.keyboard.press('Enter');
// poll rather than waitForNavigation: SW-served navigations can commit
// before the waiter attaches, and the suggest box may be mid-fetch
let landed = false;
for (let i = 0; i < 20 && !landed; i++) {
  await sleep(1000);
  landed = decodeURIComponent(p.url()).includes('harnessdir/other');
}
check('Enter in the omnibar navigates like Go', landed, p.url());

await browser.close();
console.log(fails === 0 ? '\nall checks passed' : '\n' + fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
