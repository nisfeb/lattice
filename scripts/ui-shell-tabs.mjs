#!/usr/bin/env node
//  ui-shell-tabs.mjs: the ribbon's ways off the editor stay in the editor.
//  The forum first.
//
//    Forum opens the forum in a tab of its own (once), the window stays on
//      the editor, the forum is navigated inside its tab, and the tab takes
//      the page's title
//
//  SHOTS=1 saves the forum tab at 1400x900 under /tmp.
//
//  Usage: LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=/tmp/tyr-cookie.txt \
//           node scripts/ui-shell-tabs.mjs
import { shipEnv, launchBrowser, openPage, seed, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
//  a page to stand in front between the tools
const PAGE = 'x-' + process.pid + '/shell-tabs';
const post = (path) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie } });
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
const until = (fn, arg, ms = 30000) => page.waitForFunction(fn, { timeout: ms }, arg)
  .then(() => true, () => false);
const front = () => page.evaluate(() => {
  const s = window.latTabs.state();
  const t = s.tabs[s.active];
  return t ? { kind: t.kind, key: t.key, n: s.tabs.length,
    label: document.querySelector('.dtab.on .dtn')?.textContent } : null;
});
//  the iframe of the tab in front, by its key
const frameOf = (key) => `#toolhost iframe[data-tool="${key}"]`;
const frameAt = (key) => page.evaluate((s) => {
  const f = document.querySelector(s);
  try { return f ? f.contentWindow.location.pathname + f.contentWindow.location.search : null; }
  catch { return 'cross-origin'; }
}, frameOf(key));
const chord = async (key, mods) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await sleep(300);
};
const closeTools = () => page.evaluate(async () => {
  for (const t of window.latTabs.state().tabs.filter((x) => x.kind === 'tool'))
    await window.latTabs.closeTab(t.id);
});

//  each part starts from a fresh editor and is reported on its own, so a
//  part that takes the window away fails alone
let appAt = null;
const boot = async () => {
  await page.goto(env.app, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(() => window.latTabs && document.querySelector('#ribbon .rtop button'),
    { timeout: 90000 });
  await sleep(800);
  await closeTools();
  await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
  await sleep(500);
  appAt = await page.evaluate(() => location.href);
};
const part = async (name, fn) => {
  try { await boot(); await fn(); }
  catch (e) { check(name + ' threw: ' + String(e.message).slice(0, 140), false); }
};

try {
  await seed(env, [[PAGE, '# shell tabs\n']]);

  await part('forum', async () => {
    const fk = 'frame:/apps/lattice/forum';
    const n0 = (await front()).n;
    await page.evaluate(() => document.getElementById('rb-forum').click());
    const fTab = await until((k) => {
      const s = window.latTabs.state();
      return s.tabs[s.active]?.key === k;
    }, fk, 10000);
    const fLoaded = await until((s) => {
      const f = document.querySelector(s);
      return !!f && !f.hidden && f.contentDocument?.readyState === 'complete'
        && f.contentWindow.location.pathname === '/apps/lattice/forum';
    }, frameOf(fk));
    const f1 = await front();
    const winF = await page.evaluate(() => location.href);
    check('ribbon Forum opens a forum tab and leaves the window on the editor',
      fTab && fLoaded && f1.kind === 'tool' && f1.n === n0 + 1 && winF === appAt,
      JSON.stringify({ fTab, fLoaded, f1, winF }));
    const fTitle = await until((s) => {
      const f = document.querySelector(s);
      const t = f && f.contentDocument.title.trim();
      return !!t && document.querySelector('.dtab.on .dtn')?.textContent === t;
    }, frameOf(fk), 10000);
    check('the forum tab is titled by its page', fTitle, JSON.stringify(await front()));
    if (process.env.SHOTS) await page.screenshot({ path: '/tmp/shell-tabs-forum.png' });
    //  a link inside the forum navigates the forum, not the window
    const bLink = await page.evaluate((s) => {
      const d = document.querySelector(s).contentDocument;
      const a = [...d.querySelectorAll('a[href^="/apps/lattice/forum/"]')][0];
      if (!a) return null;
      a.click();
      return new URL(a.href).pathname;
    }, frameOf(fk));
    const inFrame = !bLink || await until(([s, p]) => {
      const f = document.querySelector(s);
      return f?.contentWindow.location.pathname === p && f.contentDocument.readyState === 'complete';
    }, [frameOf(fk), bLink]);
    const winF2 = await page.evaluate(() => location.href);
    const n1 = (await front()).n;
    check('forum navigation stays in its tab', inFrame && winF2 === appAt && n1 === n0 + 1,
      JSON.stringify({ bLink, inFrame, winF2, n1, at: await frameAt(fk) }));
    //  a second click focuses the same tab
    await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
    await page.evaluate(() => document.getElementById('rb-forum').click());
    await sleep(500);
    const f2 = await front();
    check('Forum again focuses the open forum tab', f2.key === fk && f2.n === n1, JSON.stringify(f2));
  });

} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate(() => {
    localStorage.removeItem('appTabs');
  }).catch(() => {});
  await browser.close();
  await post('page-del?name=' + encodeURIComponent(PAGE)).catch(() => {});
}
check.done();
