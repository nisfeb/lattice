#!/usr/bin/env node
// /clip-paste saves nothing until the owner clicks Archive. Any site can
// open it and post html, so a page on another origin plays the
// bookmarklet: it opens /clip-paste, posts one body, then keeps posting a
// different one, as the bookmarklet's repeats would.
//
// Usage:  node scripts/ui-clippaste.mjs
// Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
// The other origin is the same ship by 127.0.0.1 when LATTICE_URL says
// localhost (or the reverse). Never run against production: it archives
// a throwaway clip.

import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const u = new URL(env.base);
const other = u.protocol + '//' + (u.hostname === 'localhost' ? '127.0.0.1' : 'localhost') +
  (u.port ? ':' + u.port : '');
const RUN = 'cliptest' + (process.pid % 100000);

const check = makeCheck();
const browser = await launchBrowser({ args: ['--disable-popup-blocking'] });
const opener = await openPage(browser, env);

const tree = async () => {
  const r = await fetch(env.base + '/apps/lattice/page-tree', { headers: { cookie: env.cookie } });
  return (await r.json()).nodes.filter((n) => n.page && n.path.includes(RUN)).map((n) => n.path);
};
const source = async (name) => (await fetch(env.base + '/apps/lattice/page-source?name=' +
  encodeURIComponent(name), { headers: { cookie: env.cookie } })).text();

//  the sender: open /clip-paste, post `first` when it says it is ready
//  (so the first body is the first it hears), then `later` on repeat
const send = (tag, first, later) => opener.evaluate((base, url, first, later) => {
  const w = window.open(base + '/apps/lattice/clip-paste?url=' + encodeURIComponent(url), '_blank');
  const ready = (e) => {
    if (e.source !== w || !e.data || e.data.lattice !== 'ready') return;
    window.removeEventListener('message', ready);
    w.postMessage({ lattice: 1, html: first }, base);
    let n = 0;
    const t = setInterval(() => {
      try { w.postMessage({ lattice: 1, html: later }, base); } catch (e) {}
      if (++n > 20) clearInterval(t);
    }, 250);
  };
  window.addEventListener('message', ready);
}, env.base, other + '/' + RUN + '-' + tag, first, later);
const popup = async () => {
  const t = await browser.waitForTarget((t) => t.url().includes('/clip-paste'), { timeout: 30000 });
  return t.page();
};
const body = (mark) => `<html><head><title>${RUN}</title></head><body><p>${mark}</p></body></html>`;

let step = 'setup';
try {
  await opener.goto(other + '/~/host', { timeout: 30000 });

  step = 'cancel';
  await send('a', body('MARK-A'), body('MARK-A2'));
  let p = await popup();
  await p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Archive'),
    { timeout: 30000 });
  const ask = await p.evaluate(() => document.getElementById('pst').textContent);
  check('it asks, naming the sender', ask.includes(other + ' sent a page'), ask);
  await sleep(3000);
  check('nothing is saved before the click', (await tree()).length === 0);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click());
  await sleep(3000);
  check('cancel saves nothing', (await tree()).length === 0);
  await p.close();

  step = 'archive';
  await send('b', body('MARK-B'), body('MARK-B2'));
  p = await popup();
  await p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Archive'),
    { timeout: 30000 });
  await sleep(2000);    // let the repeats arrive; they must change nothing
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Archive').click());
  let saved = [];
  for (let i = 0; i < 30 && !saved.length; i++) { await sleep(1000); saved = await tree(); }
  check('archive saves one clip', saved.length === 1, JSON.stringify(saved));
  if (saved.length) {
    const src = await source(saved[0]);
    check('it holds the first body sent', src.includes('MARK-B') && !src.includes('MARK-B2'), src.slice(0, 200));
  }
} catch (e) {
  check.bad('threw during ' + step, e.message);
}
await browser.close();
check.done();
