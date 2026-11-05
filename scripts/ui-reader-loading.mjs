#!/usr/bin/env node
//  ui-reader-loading.mjs: the shipless reader's loading line (desktop
//  anonymous mode). Every reader read blocks until the engine answers, and
//  the page left stays up till then, so reader.js draws the line and spins
//  Reload on the page being left.
//
//    A slow link shows the line and the spin after the delay, not before,
//      and the next page comes up without them
//    A slow address typed and sent with Enter does the same, and Back
//    A fast read never shows either
//    A leave that never lands (a 204) lets go of the line by itself
//
//  No ship and no app: a stand-in for the reader's loopback serves pages
//  shaped as render.rs's chrome() with the real reader.css and reader.js,
//  and holds /read?url=...slow... back for 1.5 s.
//
//  Usage:  node scripts/ui-reader-loading.mjs
//  Setup:  npm ci --prefix scripts
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { launchBrowser, makeCheck, sleep } from './lib/harness.mjs';

const ROOT = new globalThis.URL('..', import.meta.url).pathname;
const CSS = readFileSync(ROOT + 'desktop/ui-reader/reader.css', 'utf8');
const JS = readFileSync(ROOT + 'desktop/ui-reader/reader.js', 'utf8');
const check = makeCheck();
const SLOW_MS = 1500;

//  render.rs's chrome(), near enough: the bar reader.js works on
const chrome = (url, main) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${url}</title><style>${CSS}</style><script src="/assets/reader.js" defer></script></head>
<body><header class="bar"><nav>
<button type="button" class="nav" data-go="back" aria-label="Back">&#8249;</button>
<button type="button" class="nav" data-go="forward" aria-label="Forward">&#8250;</button>
<button type="button" class="nav" data-go="reload" aria-label="Reload">&#8635;</button>
<a class="home" href="/">Home</a></nav>
<form class="addr" action="/read" method="get"><input name="url" value="${url}" aria-label="Address"><button type="submit">Open</button></form>
</header><main class="page"><section>${main}</section></main></body></html>`;
const links = '<a id="slow" href="/read?url=urb%3A%2F%2F~zod%2Fslow">slow</a> '
  + '<a id="fast" href="/read?url=urb%3A%2F%2F~zod%2Ffast">fast</a> '
  + '<a id="none" href="/nothing">nothing</a>';

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/assets/reader.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(JS);
  }
  if (u.pathname === '/nothing') { res.writeHead(204); return res.end(); }
  const url = u.searchParams.get('url') || '';
  if (url.includes('slow')) await sleep(SLOW_MS);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(chrome(url, '<p id="at">' + (url || 'home') + '</p>' + links));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => check('page threw: ' + e.message.slice(0, 90), false));

//  The page being left is out of puppeteer's reach once it is leaving (an
//  evaluate waits for the next document), so it records for itself, in
//  sessionStorage, when the line came on after the action and how it was
//  drawn then; seen() reads that back on the page that came next.
const watch = () => page.evaluate(() => {
  sessionStorage.removeItem('seen');
  const t0 = performance.now();
  new MutationObserver(() => {
    if (sessionStorage.getItem('seen') || !document.documentElement.classList.contains('lbusy')) return;
    sessionStorage.setItem('seen', JSON.stringify({
      at: Math.round(performance.now() - t0),
      line: getComputedStyle(document.body, '::before').content !== 'none',
      spin: getComputedStyle(document.querySelector('[data-go="reload"]')).animationName === 'latspin',
      busy: document.body.getAttribute('aria-busy') === 'true',
    }));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
});
const seen = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('seen') || 'null'));
//  the line and the spin on the page in front
const drawn = () => page.evaluate(() => ({
  line: getComputedStyle(document.body, '::before').content !== 'none',
  spin: getComputedStyle(document.querySelector('[data-go="reload"]')).animationName === 'latspin',
  busy: document.body.getAttribute('aria-busy') === 'true',
}));
const clean = (d) => !!d && !d.line && !d.spin && !d.busy;
const shows = (what) => page.waitForFunction((w) => document.getElementById('at')?.textContent === w,
  { timeout: 10000 }, what);
// after the delay, and before the slow page lands: a fixed 600 ms ceiling
// failed on a busy CI runner (seen at 638 ms) with nothing wrong
const lit = (s) => !!s && s.line && s.spin && s.busy && s.at >= 150 && s.at < SLOW_MS;

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  check('a page comes up without the line', clean(await drawn()));

  //  a slow link
  await watch();
  await page.click('#slow');
  await shows('urb://~zod/slow');
  const link = await seen(), linkAfter = await drawn();
  check('a slow link shows the line and spins Reload after the delay, and the next page clears them',
    lit(link) && clean(linkAfter), JSON.stringify({ link, linkAfter }));

  //  the address bar and Enter
  await watch();
  await page.$eval('input[name=url]', (i) => { i.value = 'urb://~zod/slow2'; });
  await page.focus('input[name=url]');
  await page.keyboard.press('Enter');
  await shows('urb://~zod/slow2');
  const typed = await seen(), typedAfter = await drawn();
  check('a slow address sent with Enter shows the line, and the next page clears it',
    lit(typed) && clean(typedAfter), JSON.stringify({ typed, typedAfter }));

  //  Back, through the bar's button
  await watch();
  await page.click('[data-go="back"]');
  await shows('urb://~zod/slow');
  const back = await seen();
  check('a slow Back shows the line', lit(back), JSON.stringify({ back }));

  //  a fast read: the line never comes
  await watch();
  await page.click('#fast');
  await shows('urb://~zod/fast');
  const fast = await seen();
  check('a fast read never shows the line', fast === null && clean(await drawn()), JSON.stringify({ fast }));

  //  a leave that never lands (a 204): the page stays, with the line, which
  //  its cap (BUSY_MAX) takes away later
  await watch();
  await page.click('#none');
  await sleep(600);
  const stuck = await drawn();
  check('a leave that never lands shows the line on the page that stayed',
    stuck.line && (await page.evaluate(() => document.getElementById('at').textContent)) === 'urb://~zod/fast',
    JSON.stringify({ stuck }));
} catch (e) {
  check('suite ran: ' + e.message.slice(0, 120), false);
} finally {
  await browser.close();
  server.close();
}
check.done();
