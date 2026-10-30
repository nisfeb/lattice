#!/usr/bin/env node
//  ui-shell-tabs.mjs: the ribbon's ways off the editor stay in the editor,
//  and the shell's chords.
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
//    A frame tab's ground is the shell's, in the dark and the light, and
//      follows the system and a theme mode changed while it is open
//    Ctrl+K and Ctrl+P open the palette, Ctrl+Shift+F the Search field,
//      Ctrl+Shift+L the Files tree; vim keeps Ctrl+P in the editor, not Ctrl+K;
//      the tooltips name the new chords
//    With six browser tabs and a forum tab parked, a save lands in seconds
//      (a parked frame holds no live stream), and a closed tab's frame goes
//    No editor boots inside a frame: the home page's Editor link focuses the
//      shell, and an editor address loaded in a frame hands over and stops
//    A frame tab is sandboxed without top navigation, so its script cannot
//      replace the editor window
//    A target=_top added to a frame after load still lands in the frame
//    Closing a frame tab with typed text asks, and keeps it on cancel
//    The explorer refuses the ship root at once
//    A comment posted on an own page in a browser tab lands (its box sits
//      in the reader's srcdoc frame), and other forms there stay in it
//
//  SHOTS=1 saves the forum and browser tabs at 1400x900 under /tmp.
//  PARTS=streams,nested runs only the parts named.
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
const only = process.env.PARTS ? process.env.PARTS.split(',') : null;
const part = async (name, fn) => {
  if (only && !only.includes(name)) return;
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
    //  the ship root is refused, at once, not left hanging
    const rootShip = (await (await fetch(env.base + '/~/host')).text()).trim();
    const t1 = Date.now();
    const rr = await fetch(env.base + '/apps/lattice/x/' + rootShip + '/', { headers: { Cookie: env.cookie },
      signal: AbortSignal.timeout(30000) }).catch((e) => ({ status: 'threw ' + e.name }));
    check('the explorer refuses the ship root at once', rr.status === 403 && Date.now() - t1 < 20000,
      JSON.stringify({ status: rr.status, ms: Date.now() - t1 }));
    //  a page's code file in the explorer opens in the editor as a grub tab
    const base = (await (await fetch(env.base + '/apps/lattice/streams',
      { headers: { Cookie: env.cookie } })).json()).base;
    const xShip = (await (await fetch(env.base + '/~/host')).text()).trim();
    const code = base + '/page/' + PAGE + '/code';
    await page.evaluate(([s, u]) => { document.querySelector(s).contentWindow.location.href = u; },
      [frameOf(xk), '/apps/lattice/x/' + xShip + code]);
    const xFile = await until((s) => {
      const d = document.querySelector(s)?.contentDocument;
      return d?.readyState === 'complete' && !!d.querySelector('a[href*="app?grub="]');
    }, frameOf(xk));
    await page.evaluate((s) => document.querySelector(s).contentDocument
      .querySelector('a[href*="app?grub="]').click(), frameOf(xk));
    const xGrub = await until((k) => {
      const s = window.latTabs.state();
      const t = s.tabs[s.active];
      return t?.kind === 'grub' && t.key === k;
    }, code, 15000);
    check('a grub opened from the explorer opens in the editor', xFile && xGrub,
      JSON.stringify({ xFile, xGrub, front: await front() }));
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
    const sAt = (await frameAt(sk) || '').split('?')[0];
    check('Settings > Advanced opens the explorer tab',
      adv && viaSet && (await front()).n === ns && sAt === '/apps/lattice/settings',
      JSON.stringify({ adv, viaSet, sAt, n: (await front()).n, ns }));
  });

  //  a frame tab wears the shell's theme: with none set (mode system) the
  //  forum's own stylesheet has no dark, so the shell's ground is copied
  //  in, and it follows the system flipping and a theme picked elsewhere
  await part('theme', async () => {
    const fk = 'frame:/apps/lattice/forum';
    const bgs = () => page.evaluate((s) => {
      const d = document.querySelector(s)?.contentDocument;
      return { shell: getComputedStyle(document.body).backgroundColor,
        frame: d && d.body ? getComputedStyle(d.body).backgroundColor : null };
    }, frameOf(fk));
    const same = (b) => !!b.frame && b.frame === b.shell;
    const scheme = (v) => page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: v }]);
    try {
      await scheme('dark');
      await page.evaluate(() => document.getElementById('rb-forum').click());
      await until((s) => document.querySelector(s)?.contentDocument?.readyState === 'complete'
        && document.querySelector(s).contentWindow.location.pathname === '/apps/lattice/forum',
      frameOf(fk));
      await sleep(1500);
      const dark = await bgs();
      check('a frame tab takes the shell\'s dark ground', same(dark) && dark.shell === 'rgb(26, 26, 26)',
        JSON.stringify(dark));
      await scheme('light');
      await sleep(800);
      const light = await bgs();
      check('an open frame tab follows the system going light', same(light) && light.shell !== dark.shell,
        JSON.stringify(light));
      //  a mode set from another document, as the settings tab sets it
      await scheme('dark');
      await page.evaluate((s) => {
        const w = document.querySelector(s).contentWindow;
        const t = JSON.parse(w.localStorage.latTheme || '{}');
        w.localStorage.latTheme = JSON.stringify(Object.assign(t, { mode: 'light' }));
      }, frameOf(fk));
      await sleep(1500);
      const forced = await bgs();
      check('an open frame tab follows a theme picked elsewhere', same(forced) && forced.shell !== dark.shell,
        JSON.stringify(forced));
    } finally {
      await page.evaluate(() => {
        const t = JSON.parse(localStorage.latTheme || '{}');
        localStorage.latTheme = JSON.stringify(Object.assign(t, { mode: 'system' }));
      }).catch(() => {});
      await page.emulateMediaFeatures([]);
    }
  });

  //  a frame tab that is not in front holds no live stream: six browser
  //  tabs and a forum tab, each parked with its keep stream open, took
  //  every one of the six connections a browser gives one host, and the
  //  editor's save then waited forever. A closed tab's frame goes too.
  const frontLoaded = () => until(() => {
    const s = window.latTabs.state();
    const k = s.tabs[s.active]?.key;
    const f = k && document.querySelector(`#toolhost iframe[data-tool="${k}"]`);
    return !!f && f.contentDocument?.readyState === 'complete'
      && f.contentWindow.location.href !== 'about:blank';
  }, null, 30000);
  await part('streams', async () => {
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => document.getElementById('rb-browser').click());
      await frontLoaded();
      await sleep(1500);
    }
    await page.evaluate(() => document.getElementById('rb-forum').click());
    await frontLoaded();
    await sleep(1500);
    const nFrames = await page.evaluate(() => document.querySelectorAll('#toolhost iframe').length);
    await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
    await until((n) => {
      const s = window.latTabs.state();
      return s.tabs[s.active]?.key === n && s.shows;
    }, PAGE, 15000);
    await sleep(1500);
    const mark = 'C1SAVE' + Date.now();
    await page.focus('#src');
    await page.keyboard.press('End');
    await page.keyboard.type(' ' + mark);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    const t0 = Date.now();
    let landed = false;
    while (!landed && Date.now() - t0 < 20000) {
      await sleep(400);
      const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(PAGE),
        { headers: { Cookie: env.cookie } }).catch(() => null);
      landed = !!r && r.ok && ((await r.json()).body || '').includes(mark);
    }
    const ms = Date.now() - t0;
    check('with six browser tabs and a forum tab open, a save lands in seconds',
      nFrames === 7 && landed && ms < 8000, JSON.stringify({ nFrames, landed, ms }));
    //  the tabs close, and so do their frames
    await closeTools();
    await sleep(300);
    const left = await page.evaluate(() => document.querySelectorAll('#toolhost iframe').length);
    check('closing frame tabs removes their frames', left === 0, String(left));
  });

  //  no editor ever boots inside a frame: a link to it opens the shell's
  //  own tab, and the editor loaded in a frame anyway refuses to start
  await part('nested', async () => {
    await page.evaluate(() => document.getElementById('rb-browser').click());
    await frontLoaded();
    await sleep(1500);
    const bkey = (await front()).key;
    const card = await page.evaluate((s) => {
      const d = document.querySelector(s).contentDocument;
      const a = [...d.querySelectorAll('a[href]')].find((x) => /\/apps\/lattice\/app\/?$/.test(x.href));
      if (!a) return null;
      a.click();
      return a.getAttribute('href');
    }, frameOf(bkey));
    await sleep(2500);
    const after = await page.evaluate((s) => {
      const f = document.querySelector(s);
      let at = null, inner = null;
      try { at = f.contentWindow.location.pathname; inner = !!f.contentWindow.latTabs; } catch {}
      const st = window.latTabs.state();
      return { at, inner, front: st.tabs[st.active]?.kind };
    }, frameOf(bkey));
    check('the home page\'s Editor link focuses the shell, not an editor in the tab',
      !!card && after.at !== '/apps/lattice/app' && !after.inner && after.front !== 'tool',
      JSON.stringify({ card, after }));
    //  loaded in a frame by any other road, the editor does not boot, and
    //  an ?into= hands its folder to the shell
    await page.evaluate((k) => window.latTabs.switchTab(window.latTabs.state().tabs.find((t) => t.key === k).id),
      bkey);
    //  the reader's page cache swaps the document once after load, which
    //  would cancel a navigation started before it
    await sleep(4000);
    //  the shell's own address follows the folder it shows (replaceState),
    //  so it is the document that must stay, not its address
    await page.evaluate(() => { window.latSameDoc = 1; });
    await page.evaluate(([s, u]) => { document.querySelector(s).contentWindow.location.href = u; },
      [frameOf(bkey), '/apps/lattice/app?into=x-' + process.pid]);
    await until((s) => {
      const f = document.querySelector(s);
      return f?.contentWindow.location.pathname === '/apps/lattice/app'
        && f.contentDocument.readyState === 'complete';
    }, frameOf(bkey), 20000);
    await sleep(2000);
    const boxed = await page.evaluate((s) => {
      const f = document.querySelector(s);
      let at = null, inner = null, src = null;
      try {
        at = f.contentWindow.location.pathname;
        inner = !!f.contentWindow.latTabs;
        src = !!f.contentDocument.getElementById('src');
      } catch {}
      const st = window.latTabs.state();
      return { at, inner, src, front: st.tabs[st.active]?.kind, same: window.latSameDoc === 1,
        win: location.pathname + location.search };
    }, frameOf(bkey));
    check('an editor loaded in a frame does not boot, and its ?into= opens in the shell',
      boxed.at === '/apps/lattice/app' && !boxed.inner && !boxed.src && boxed.front === 'page'
        && boxed.same && boxed.win === '/apps/lattice/app?into=x-' + process.pid, JSON.stringify(boxed));
    //  the note reloaded (a service worker taking over) opens nothing more,
    //  and a parked frame hands nothing to the shell
    await page.evaluate((k) => window.latTabs.switchTab(window.latTabs.state().tabs.find((t) => t.key === k).id),
      bkey);
    await sleep(800);
    const n0 = await page.evaluate(() => window.latTabs.state().tabs.length);
    await page.evaluate((s) => document.querySelector(s).contentWindow.location.reload(), frameOf(bkey));
    await sleep(4000);
    const n1 = await page.evaluate(() => window.latTabs.state().tabs.length);
    check('the editor note reloaded opens no second tab', n1 === n0, JSON.stringify({ n0, n1 }));
    await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
    await sleep(800);
    const parked = await page.evaluate((s) =>
      window.latFrameEditor('/apps/lattice/app?name=x', document.querySelector(s).contentWindow), frameOf(bkey));
    check('a parked frame cannot hand the shell an editor address', parked === false, String(parked));
  });

  //  a frame cannot replace the editor window: its frame is sandboxed with
  //  no top navigation, and a target=_top added after load lands in the
  //  frame (delegation, not a pass at load)
  await part('sandbox', async () => {
    const fk = 'frame:/apps/lattice/forum';
    await page.evaluate(() => document.getElementById('rb-forum').click());
    await frontLoaded();
    await sleep(1500);
    const sb = await page.evaluate((s) => document.querySelector(s).getAttribute('sandbox'), frameOf(fk));
    const toks = (sb || '').split(/\s+/);
    check('a frame tab is sandboxed with no top navigation',
      sb !== null && ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups',
        'allow-modals', 'allow-downloads'].every((t) => toks.includes(t))
        && !toks.some((t) => t.startsWith('allow-top-navigation')), String(sb));
    //  the frame's own script, in its own realm
    const fr = await (await page.$(frameOf(fk))).contentFrame();
    await fr.evaluate(() => { try { window.top.location.href = '/apps/lattice/forum'; } catch {} });
    await sleep(2000);
    check('a frame\'s script cannot navigate the editor window',
      (await page.evaluate(() => location.href)) === appAt);
    await page.evaluate((s) => {
      const d = document.querySelector(s).contentDocument;
      const f = d.createElement('form');
      f.action = '/apps/lattice/forum/_new';
      f.method = 'get';
      f.target = '_top';
      f.id = 'latlate';
      //  a field, so the address is not a bare "?" (the service worker
      //  would add "&u=", and eyre answers "?&" with a redirect)
      const i = d.createElement('input');
      i.type = 'hidden';
      i.name = 'late';
      i.value = '1';
      f.append(i);
      d.body.append(f);
      setTimeout(() => f.requestSubmit(), 50);
    }, frameOf(fk));
    const late = await until((s) => document.querySelector(s)?.contentWindow.location.pathname
      === '/apps/lattice/forum/_new', frameOf(fk), 10000);
    check('a form aimed at _top added after load lands in its frame',
      late && (await page.evaluate(() => location.href)) === appAt,
      JSON.stringify({ late, at: await frameAt(fk) }));
  });

  //  closing a frame tab holding typed text asks first
  await part('closeask', async () => {
    const fk = 'frame:/apps/lattice/settings';
    await page.evaluate(() => document.getElementById('rb-settings').click());
    await frontLoaded();
    await sleep(1500);
    const dlgUp = () => page.evaluate(() => document.getElementById('dlg')?.hidden === false);
    const tabOpen = () => page.evaluate((k) => window.latTabs.state().tabs.some((t) => t.key === k), fk);
    //  untouched: it closes without a word
    await page.evaluate((k) => { window.latTabs.closeTab(window.latTabs.state().tabs.find((t) => t.key === k).id); }, fk);
    await sleep(800);
    const clean = { dlg: await dlgUp(), open: await tabOpen() };
    await page.evaluate(() => document.getElementById('rb-settings').click());
    await frontLoaded();
    await sleep(1500);
    await page.evaluate((s) => {
      const i = document.querySelector(s).contentDocument.getElementById('kname');
      i.value = 'half typed';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }, frameOf(fk));
    await page.evaluate((k) => { window.latTabs.closeTab(window.latTabs.state().tabs.find((t) => t.key === k).id); }, fk);
    await sleep(800);
    const asked = { dlg: await dlgUp(), open: await tabOpen() };
    if (asked.dlg) await page.evaluate(() => document.getElementById('dlgcancel').click());
    await sleep(500);
    const kept = await tabOpen();
    await page.evaluate((k) => { window.latTabs.closeTab(window.latTabs.state().tabs.find((t) => t.key === k).id); }, fk);
    await sleep(800);
    if (await dlgUp()) await page.evaluate(() => document.getElementById('dlgok').click());
    await sleep(800);
    const gone = !(await tabOpen());
    check('closing a frame tab with typed text asks, and keeps it on cancel',
      !clean.dlg && !clean.open && asked.dlg && kept && gone, JSON.stringify({ clean, asked, kept, gone }));
  });

  //  an own page's comment box lives in the reader's srcdoc frame, which
  //  takes on the frame tab's sandbox and so may not navigate its parent:
  //  its post is sent again from the shell, and lands. A form there not
  //  aimed upward is left to navigate its own frame.
  await part('comment', async () => {
    await post('page-comments?name=' + encodeURIComponent(PAGE) + '&on=1');
    const cShip = (await (await fetch(env.base + '/~/host')).text()).trim();
    const cBase = (await (await fetch(env.base + '/apps/lattice/streams',
      { headers: { Cookie: env.cookie } })).json()).base;
    const view = '/apps/lattice/x/' + cShip + cBase + '/page/' + PAGE + '/';
    await page.evaluate(() => document.getElementById('rb-browser').click());
    await frontLoaded();
    await sleep(3000);
    const ck = (await front()).key;
    await page.evaluate(() => { window.latSameDoc = 1; });
    await page.evaluate(([s, u]) => { document.querySelector(s).contentWindow.location.href = u; },
      [frameOf(ck), view]);
    const boxUp = () => until(([s, src]) => {
      const f = document.querySelector(s);
      const box = [...(f?.contentDocument?.querySelectorAll('iframe') || [])].some((i) => {
        try { return !!i.contentDocument.querySelector('form.cbox textarea'); } catch { return false; }
      });
      return f.contentWindow.location.pathname === new URL(src, location.href).pathname
        && f.contentDocument.readyState === 'complete' && box;
    }, [frameOf(ck), view], 30000);
    const shown = await boxUp();
    await sleep(1500);
    const mark = 'shelltabscomment' + Date.now();
    //  the reader's page cache may swap the document once more after load
    await sleep(3000);
    await boxUp();
    //  the post must reload the tab's own frame, not open a window
    const nPages = (await browser.pages()).length;
    await page.evaluate((s) => { document.querySelector(s).contentWindow.latBefore = 1; }, frameOf(ck));
    const typed = await page.evaluate(([s, m]) => {
      const f = document.querySelector(s);
      for (const i of f.contentDocument.querySelectorAll('iframe')) {
        let d = null;
        try { d = i.contentDocument; } catch {}
        const t = d && d.querySelector('form.cbox textarea');
        if (!t) continue;
        t.value = m;
        d.querySelector('form.cbox button[type=submit]').click();
        return true;
      }
      return false;
    }, [frameOf(ck), mark]);
    const t0 = Date.now();
    let landed = false;
    while (!landed && Date.now() - t0 < 20000) {
      await sleep(800);
      const r = await fetch(env.base + view, { headers: { Cookie: env.cookie } }).catch(() => null);
      landed = !!r && r.ok && (await r.text()).includes(mark);
    }
    //  the post's answer (303 to the page) reloads the tab's frame
    const reloaded = await until((s) => document.querySelector(s).contentWindow.latBefore !== 1,
      frameOf(ck), 20000);
    const back = await boxUp();
    const same = await page.evaluate(() => window.latSameDoc === 1);
    const popups = (await browser.pages()).length - nPages;
    check('a comment posted on an own page in a browser tab lands, and the tab shows the page',
      shown && typed && landed && back && same && reloaded && !popups,
      JSON.stringify({ shown, typed, landed, back, same, reloaded, popups, at: await frameAt(ck) }));
    //  a form in the srcdoc frame aimed nowhere else navigates that frame only
    await sleep(3000);
    await boxUp();
    await page.evaluate((s) => {
      const fd = document.querySelector(s).contentDocument;
      const d = [...fd.querySelectorAll('iframe')].map((i) => { try { return i.contentDocument; } catch { return null; } })
        .find((x) => x && x.querySelector('form.cbox'));
      const g = d.createElement('form');
      g.action = '/apps/lattice/forum';
      g.method = 'get';
      const i = d.createElement('input');
      i.type = 'hidden';
      i.name = 'own';
      i.value = '1';
      g.append(i);
      d.body.append(g);
      g.requestSubmit();
    }, frameOf(ck));
    const own = await until(([s, src]) => {
      const f = document.querySelector(s);
      let at = null;
      for (const i of f?.contentDocument?.querySelectorAll('iframe') || []) {
        try { if (i.contentWindow.location.pathname === '/apps/lattice/forum') at = '/apps/lattice/forum'; } catch {}
      }
      return at === '/apps/lattice/forum'
        && f.contentWindow.location.pathname === new URL(src, location.href).pathname;
    }, [frameOf(ck), view], 15000);
    check('a form in the srcdoc frame not aimed upward stays in that frame', own);
  });

  await part('chords', async () => {
    const palOpen = () => page.evaluate(() => document.getElementById('palette')?.hidden === false
      && document.activeElement === document.getElementById('palin'));
    const palShut = async () => {
      if (await page.evaluate(() => document.getElementById('palette')?.hidden === false))
        await page.keyboard.press('Escape');
      await sleep(200);
    };
    const tips = await page.evaluate(() => ({
      files: document.querySelector('#ltabs [data-pt=files]').title,
      search: document.querySelector('#ltabs [data-pt=search]').title,
      pal: document.getElementById('rb-palette').title,
    }));
    check('the tooltips name Ctrl+Shift+L, Ctrl+Shift+F and Ctrl+K',
      tips.files === 'Files (Ctrl+Shift+L)' && tips.search === 'Search (Ctrl+Shift+F)'
        && tips.pal === 'Command palette (Ctrl+K)', JSON.stringify(tips));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await chord('KeyK', ['Control']);
    const viaK = await palOpen();
    await palShut();
    await page.focus('#src');
    await chord('KeyP', ['Control']);
    const viaP = await palOpen();
    await palShut();
    check('Ctrl+K opens the palette, and Ctrl+P too', viaK && viaP, JSON.stringify({ viaK, viaP }));
    await page.evaluate(() => { localStorage.appNT = '1'; window.latShell.paneOpen('l', false); });
    await page.focus('#src');
    await chord('KeyF', ['Control', 'Shift']);
    const sF = await page.evaluate(() => ({
      focus: document.activeElement && document.activeElement.id,
      tab: !document.querySelector('section[data-pane=search]').hidden,
      pal: document.getElementById('palette')?.hidden === false,
    }));
    check('Ctrl+Shift+F opens Search and focuses its field', sF.focus === 'qinput' && sF.tab && !sF.pal,
      JSON.stringify(sF));
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await chord('KeyL', ['Control', 'Shift']);
    const a1 = await page.evaluate(() => ({
      files: !document.querySelector('#lbody > [data-pane=files]').hidden,
      inTree: document.getElementById('treelist').contains(document.activeElement),
    }));
    check('Ctrl+Shift+L shows Files and focuses its tree', a1.files && a1.inTree, JSON.stringify(a1));
    //  a chord pressed inside a frame tab reaches the shell
    await page.evaluate(() => document.getElementById('rb-forum').click());
    const fIn = await until(() => {
      const f = document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/forum"]');
      return f?.contentDocument?.readyState === 'complete' && !!f.contentDocument.body
        && [...f.contentDocument.querySelectorAll('style')].some((x) => x.textContent === '.hamw{display:none}');
    });
    //  the reader's page cache may swap the document once more after load
    await sleep(2000);
    await page.evaluate(() => {
      const f = document.querySelector('#toolhost iframe[data-tool="frame:/apps/lattice/forum"]');
      f.focus();
      f.contentWindow.focus();
      //  a field that takes the focus (the bar's first button is a
      //  disabled Back)
      (f.contentDocument.querySelector('input, a[href]') || f.contentDocument.body).focus();
    });
    await chord('KeyK', ['Control']);
    const inFrameK = await palOpen();
    await palShut();
    check('Ctrl+K inside a frame tab opens the palette', fIn && inFrameK, JSON.stringify({ fIn, inFrameK }));
    await page.evaluate((n) => window.latTabs.openIn('page', n), PAGE);
    await sleep(500);
    //  vim keeps Ctrl+P in the editor; Ctrl+K is the app's in vim too
    await page.evaluate(() => { localStorage.edVim = '1'; window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    await sleep(300);
    await page.focus('#src');
    await chord('KeyP', ['Control']);
    const vimP = await palOpen();
    await palShut();
    await page.focus('#src');
    await chord('KeyK', ['Control']);
    const vimK = await palOpen();
    await palShut();
    check('in vim, Ctrl+P stays with the editor and Ctrl+K opens the palette', !vimP && vimK,
      JSON.stringify({ vimP, vimK }));
  });
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate(() => {
    for (const k of ['appNT', 'edVim', 'appTabs']) localStorage.removeItem(k);
  }).catch(() => {});
  await browser.close();
  //  the page, then the folder it made
  for (const n of [PAGE, 'x-' + process.pid])
    await post('page-del?name=' + encodeURIComponent(n)).catch(() => {});
}
check.done();
