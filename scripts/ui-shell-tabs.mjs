#!/usr/bin/env node
//  ui-shell-tabs.mjs: the ribbon's ways off the editor stay in the editor.
//
//    Forum opens the forum in a tab of its own (once), the window stays on
//      the editor, the forum is navigated inside its tab, and the tab takes
//      the page's title
//    Browser opens a new browser tab per click at the reader home, with the
//      reader's bar but not its menu, and the omnibar, links and the comment
//      box's _top all stay inside the tab
//    Explorer is not on the ribbon, the palette lists it under Settings >
//      Advanced, it opens as a tab whose page answers, and the link in
//      Settings > Advanced opens that tab
//
//  SHOTS=1 saves the forum and browser tabs at 1400x900 under /tmp.
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

  await part('browser', async () => {
    const browserKeys = () => page.evaluate(() => window.latTabs.state().tabs
      .filter((t) => t.kind === 'tool' && /^frame:\/apps\/lattice\/?(#|$)/.test(t.key)).map((t) => t.key));
    const b0 = (await browserKeys()).length;
    const nb = (await front()).n;
    await page.evaluate(() => document.getElementById('rb-browser').click());
    await sleep(800);
    await page.evaluate(() => document.getElementById('rb-browser').click());
    await sleep(800);
    const bk = await browserKeys();
    const b1 = await front();
    const winB = await page.evaluate(() => location.href);
    check('each Browser click opens a new browser tab, the window stays',
      bk.length === b0 + 2 && b1.n === nb + 2 && bk.includes(b1.key) && winB === appAt,
      JSON.stringify({ bk, b1, winB }));
    const key = b1.key;
    const bLoaded = await until((s) => {
      const f = document.querySelector(s);
      return !!f && f.contentDocument?.readyState === 'complete'
        && /^\/apps\/lattice\/?$/.test(f.contentWindow.location.pathname)
        && !!f.contentDocument.querySelector('form.bar');
    }, frameOf(key));
    const dress = await page.evaluate((s) => {
      const d = document.querySelector(s).contentDocument;
      const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
      return { bar: vis(d.querySelector('form.bar')), omni: vis(d.querySelector('form.bar input[name=url]')),
        ham: d.querySelector('.hamw') ? vis(d.querySelector('.hamw')) : 'absent' };
    }, frameOf(key));
    check('a browser tab keeps the reader bar and its omnibar, not its menu',
      bLoaded && dress.bar && dress.omni && dress.ham !== true, JSON.stringify({ bLoaded, dress }));
    const bTitle = await until((s) => {
      const f = document.querySelector(s);
      const t = f && f.contentDocument.title.trim();
      return !!t && document.querySelector('.dtab.on .dtn')?.textContent === t;
    }, frameOf(key), 10000);
    check('the browser tab is titled by its page', bTitle, JSON.stringify(await front()));
    if (process.env.SHOTS) await page.screenshot({ path: '/tmp/shell-tabs-browser.png' });
    //  the omnibar goes to an urb:// address inside the tab
    const ship = (await (await fetch(env.base + '/~/host')).text()).trim();
    const typed = 'urb://' + ship + '/shell-tabs-probe';
    await page.evaluate(([s, t]) => {
      const d = document.querySelector(s).contentDocument;
      const f = d.querySelector('form.bar');
      f.querySelector('input[name=url]').value = t;
      f.requestSubmit ? f.requestSubmit() : f.submit();
    }, [frameOf(key), typed]);
    const went = await until(([s, t]) => {
      const f = document.querySelector(s);
      try {
        return new URLSearchParams(f.contentWindow.location.search).get('url') === t
          && f.contentDocument.readyState === 'complete';
      } catch { return false; }
    }, [frameOf(key), typed]);
    const winB2 = await page.evaluate(() => location.href);
    const b2 = await front();
    check('the omnibar navigates inside the browser tab',
      went && winB2 === appAt && b2.key === key && b2.n === nb + 2,
      JSON.stringify({ went, winB2, b2, at: await frameAt(key) }));
    const bTitle2 = await until((s) => {
      const f = document.querySelector(s);
      const t = f && f.contentDocument.title.trim();
      return !!t && document.querySelector('.dtab.on .dtn')?.textContent === t;
    }, frameOf(key), 10000);
    check('the title follows the browser tab to its new page', bTitle2, JSON.stringify(await front()));
    //  a reader link stays inside too
    const rl = await page.evaluate((s) => {
      const d = document.querySelector(s).contentDocument;
      const a = [...d.querySelectorAll('main a[href*="?url="]')][0];
      if (!a) return null;
      a.click();
      return a.href;
    }, frameOf(key));
    const rlIn = !rl || await until(([s, h]) => {
      const f = document.querySelector(s);
      return f?.contentWindow.location.href === h && f.contentDocument.readyState === 'complete';
    }, [frameOf(key), rl]);
    check('a reader link stays inside the browser tab',
      rlIn && (await page.evaluate(() => location.href)) === appAt, JSON.stringify({ rl, rlIn }));
    //  nothing in the frame may aim at the whole window
    await page.evaluate((s) => { document.querySelector(s).contentWindow.location.href = '/apps/lattice'; }, frameOf(key));
    await until((s) => {
      const f = document.querySelector(s);
      return f?.contentWindow.location.search === '' && f.contentDocument.readyState === 'complete';
    }, frameOf(key));
    await sleep(800);
    const tops = await page.evaluate((s) => {
      const f = document.querySelector(s);
      const docs = [f.contentDocument];
      for (const i of f.contentDocument.querySelectorAll('iframe')) {
        try { if (i.contentDocument) docs.push(i.contentDocument); } catch {}
      }
      return docs.reduce((n, d) => n + d.querySelectorAll('[target=_top], [target=_parent]').length, 0);
    }, frameOf(key));
    check('no form or link in a browser tab aims at the whole window', tops === 0, String(tops));
  });

  await part('explorer', async () => {
    const xk = 'frame:/apps/lattice/x';
    const ribbonX = await page.evaluate(() => !!document.getElementById('rb-explorer')
      || [...document.querySelectorAll('#ribbon button')].some((b) => /explorer/i.test(b.title)));
    check('Explorer is not on the ribbon', !ribbonX);
    await page.evaluate(() => document.getElementById('rb-palette').click());
    await sleep(300);
    await page.keyboard.type('explorer');
    await sleep(300);
    const xRow = await page.evaluate(() => {
      const r = document.querySelector('#pallist .palrow');
      return r ? { name: r.querySelector('.palname')?.textContent, home: r.querySelector('.palhome')?.textContent } : null;
    });
    check('the palette lists Explorer under Settings > Advanced',
      xRow?.name === 'Explorer' && xRow?.home === 'Settings › Advanced', JSON.stringify(xRow));
    const nx = (await front()).n;
    await page.keyboard.press('Enter');
    const xTab = await until((k) => {
      const s = window.latTabs.state();
      return s.tabs[s.active]?.key === k;
    }, xk, 10000);
    const xLoaded = await until((s) => {
      const f = document.querySelector(s);
      return !!f && f.contentDocument?.readyState === 'complete'
        && f.contentWindow.location.pathname.startsWith('/apps/lattice/x/')
        && f.contentDocument.body && f.contentDocument.body.textContent.trim().length > 0;
    }, frameOf(xk), 45000);
    const xAt = await frameAt(xk);
    const x1 = await front();
    check('Explorer opens as a tab and its page loads, the window stays',
      xTab && xLoaded && x1.n === nx + 1 && (await page.evaluate(() => location.href)) === appAt,
      JSON.stringify({ xTab, xLoaded, xAt, x1 }));
    //  the page itself answers, and not with the crash note
    const t0 = Date.now();
    const xr = await fetch(env.base + '/apps/lattice/x', { headers: { Cookie: env.cookie },
      signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: 'threw ' + e.name }));
    const xBody = xr.text ? await xr.text() : '';
    check('the explorer answers, and not with a crash',
      (xr.status === 200 || xr.status === 403) && !/recovering from a crash/.test(xBody),
      JSON.stringify({ status: xr.status, ms: Date.now() - t0, body: xBody.slice(0, 120) }));
    //  Settings > Advanced has the way in, and it opens the same tab
    await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
    await page.evaluate(() => document.getElementById('rb-settings').click());
    const sk = 'frame:/apps/lattice/settings';
    const adv = await until((s) => {
      const d = document.querySelector(s)?.contentDocument;
      const a = d && d.getElementById('openexplorer');
      return !!a && !!d.getElementById('advanced') && a.dataset.latTool === 'explorer';
    }, frameOf(sk));
    const ns = (await front()).n;
    await page.evaluate((s) => document.querySelector(s).contentDocument.getElementById('openexplorer').click(),
      frameOf(sk));
    const viaSet = await until((k) => {
      const s = window.latTabs.state();
      return s.tabs[s.active]?.key === k;
    }, xk, 10000);
    await sleep(500);
    const sAt = await frameAt(sk);
    check('Settings > Advanced opens the explorer tab',
      adv && viaSet && (await front()).n === ns && sAt === '/apps/lattice/settings',
      JSON.stringify({ adv, viaSet, sAt, n: (await front()).n, ns }));
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
