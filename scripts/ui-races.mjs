#!/usr/bin/env node
//  ui-races.mjs: saves that race something else, in the real editor.
//
//  Each case forces one order of events that a ship gives only now and
//  then, and checks that no text is lost by it:
//
//    a parked save that has nothing to send leaves the window able to save
//
//  No ship: lib/stub-ship.mjs stands in for the routes the editor uses and
//  serves the built app.js, and holds answers back to force the order.
//
//  Usage:  node scripts/ui-races.mjs [case ...]
//  Setup:  npm ci --prefix scripts
import { launchBrowser, makeCheck, sleep, waitFor } from './lib/harness.mjs';
import { stubShip } from './lib/stub-ship.mjs';

const check = makeCheck();
const browser = await launchBrowser();
const only = process.argv.slice(2);

//  a ship with `seed`, and the editor open on it at `q`
async function up(seed, q = '') {
  const ship = await stubShip(seed);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.setViewport({ width: 1300, height: 850 });
  await page.goto(ship.url + q, { waitUntil: 'domcontentloaded' });
  const name = new URLSearchParams(q.slice(1)).get('name');
  //  open, and the fresh read behind the first paint answered
  if (name) await waitFor(() => ship.S.log.some((e) => e.path === 'page-source' && e.q.render && e.res), 15000, 50);
  await sleep(300);
  return { ...ship, page, done: async () => { await ctx.close(); ship.close(); } };
}
const ed = (p) => p.evaluate(() => document.querySelector('#src').value);
const status = (p) => p.evaluate(() => document.querySelector('#status').textContent);
const typeEnd = async (p, t) => {
  await p.focus('#src');
  await p.evaluate(() => { const s = document.querySelector('#src'); s.selectionStart = s.selectionEnd = s.value.length; });
  await p.keyboard.type(t);
};
const body = (x, name) => (x.S.pages.get(name) || { body: null }).body;
//  the answered saves since log index `from`
const answered = (x, from = 0) => x.S.log.slice(from).filter((e) => /^page-save/.test(e.path) && e.res);
const cases = {};

//  Split view. n/a is held by the "changed elsewhere" bar with unsaved
//  text, and is parked when the other group takes the front. Its parked
//  save has nothing to send. The page typed into next must still save.
cases.parked = async () => {
  const x = await up({ 'n/a': 'alpha\n', 'n/b': 'beta\n' }, '?name=n/a');
  const p = x.page;
  x.S.put('n/a', 'alpha\nTHEIRS');
  await typeEnd(p, 'MINE');
  await waitFor(() => p.evaluate(() => !document.querySelector('#casbar').hidden), 10000, 100);
  check('the page changed elsewhere holds its bar', await p.evaluate(() => !document.querySelector('#casbar').hidden), await status(p));
  await typeEnd(p, ' more');
  await p.evaluate(() => window.latSplits.split('right'));
  await sleep(800);
  await p.evaluate(() => {
    const g = window.latTabs.groups();
    const i = g.findIndex((q) => !q.tabs.some((t) => t.key === 'n/a'));
    if (i >= 0 && !g[i].focus) window.latTabs.focus(i);
  });
  await sleep(500);
  await p.evaluate(() => window.latTabs.openIn('page', 'n/b', {}));
  await waitFor(async () => (await ed(p)) === 'beta\n', 8000, 100);
  await sleep(800);
  await typeEnd(p, 'TYPED-IN-B');
  await waitFor(() => (body(x, 'n/b') || '').includes('TYPED-IN-B'), 8000, 100);
  check.eq('text typed in the other pane is autosaved', body(x, 'n/b'), 'beta\nTYPED-IN-B');
  await typeEnd(p, ' again');
  await p.keyboard.down('Control'); await p.keyboard.press('s'); await p.keyboard.up('Control');
  await waitFor(() => (body(x, 'n/b') || '').includes('again'), 6000, 100);
  check.eq('and Ctrl+S saves', body(x, 'n/b'), 'beta\nTYPED-IN-B again');
  check.eq('the held page was not written over', body(x, 'n/a'), 'alpha\nTHEIRS');
  await x.done();
};

for (const [name, run] of Object.entries(cases)) {
  if (only.length && !only.includes(name)) continue;
  console.log('\n' + name);
  try { await run(); } catch (e) { check.bad(name + ' ran to its end', String(e && e.stack || e)); }
}
await browser.close();
check.done();
