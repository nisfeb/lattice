#!/usr/bin/env node
//  ui-loading.mjs: the loading line. A wait on the ship shows a thin line
//  at the top of what is waiting, only once it has run 180 ms, and the line
//  always goes again.
//
//    A slow page open (its body not in the tree dump, its page-source held
//      back) shows the editor's line after the delay and clears when the
//      page lands
//    A fast one (page-source answered at once) never shows it
//    A slow open superseded by another open clears at once, and the late
//      answer brings it back nowhere; a failed open clears too
//    A browser tab whose page is slow shows the line on its frame's host
//      and a spinner on its tab, both clearing once the page loads, and so
//      does a navigation in it
//    A comment posted from the reader view shows progress, disables Post
//      until the reply, and a second click sends nothing; in a browser tab
//      the tab's line shows while it is sent
//    A comment that fails from a browser tab keeps its text: the frame
//      stays on the page with the reason shown, and Back then Forward
//      bring the box back with the text still in it
//
//  The slowness is request interception, not a slow ship, so the suite
//  makes four pages and writes one comment.
//
//  Usage: LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> \
//           node scripts/ui-loading.mjs
import { shipEnv, launchBrowser, openPage, seed, makeCheck, sleep, shipName } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const X = 'x-' + process.pid + '/loading-';
const SLOW = X + 'slow', SLOW2 = X + 'slow2', FAST = X + 'fast', FAIL = X + 'fail';
const body = (n) => '# ' + n + '\n\nloadmark ' + n + '\n';
const post = (path) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie } });
const getText = async (path) => (await fetch(env.base + path, { headers: { Cookie: env.cookie } })).text();

await seed(env, [SLOW, SLOW2, FAST, FAIL].map((n) => [n, body(n)]));
await post('page-comments?name=' + encodeURIComponent(FAST) + '&on=1');
//  FAST's render, answered from here at once when the editor asks
const fastSrc = await getText('/apps/lattice/page-source?name=' + encodeURIComponent(FAST) + '&render=1');

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
//  the worker would answer some of these itself, out of the interceptor's view
await page.setBypassServiceWorker(true);
await page.setRequestInterception(true);
const named = (u, n) => u.includes('page-source?') && new URL(u).searchParams.get('name') === n;
let frameDelay = 0;        // ms to hold a frame's document request
let commentDelay = 0;      // ms to hold a comment post
let comments = 0;          // comment posts seen
let commentFail = false;   // answer comment posts with a 500
page.on('request', async (r) => {
  const u = r.url();
  try {
    //  the tree dump without the bodies of the test pages, so their opens
    //  go to the ship (the unpainted open)
    if (u.includes('/apps/lattice/page-dump')) {
      const res = await fetch(u, { headers: { Cookie: env.cookie } });
      const d = await res.json();
      for (const n of d.nodes || []) if (n.page && n.path.startsWith(X)) delete n.body;
      return r.respond({ status: res.status, contentType: 'application/json', body: JSON.stringify(d) });
    }
    if (named(u, FAST)) return r.respond({ status: 200, contentType: 'application/json', body: fastSrc });
    if (named(u, SLOW)) await sleep(2500);
    if (named(u, SLOW2)) await sleep(4000);
    if (named(u, FAIL)) {
      await sleep(1200);
      return r.respond({ status: 500, contentType: 'application/json', body: '{"error":"held"}' });
    }
    if (r.method() === 'POST' && /\/apps\/lattice\/comment\?/.test(u)) {
      comments++;
      if (commentDelay) await sleep(commentDelay);
      if (commentFail) return r.respond({ status: 500, contentType: 'text/plain', body: 'held' });
    }
    if (frameDelay && r.isNavigationRequest() && r.frame() !== page.mainFrame()) await sleep(frameDelay);
    await r.continue();
  } catch {}
});
const until = (fn, arg, ms = 30000) => page.waitForFunction(fn, { timeout: ms }, arg)
  .then(() => true, () => false);

//  Records each change of the line on anything `sel` matches in the shell
//  as [ms since the mark, on]. The action under test follows at once, so
//  the times are near enough to it. lineLog() reads the record back.
//  With `slot` 'tl' it records the tab's spinner (.lload) instead, beside
//  the line's record, read back by tabLog().
const mark = (sel, slot = 'bl', cls = slot === 'tl' ? 'lload' : 'lbusy') => page.evaluate((sel, slot, cls) => {
  const log = window['__' + slot] = [];
  const t0 = performance.now();
  const look = () => {
    const on = [...document.querySelectorAll(sel)].some((e) => e.classList.contains(cls));
    const last = log.length ? log[log.length - 1][1] : false;
    if (on !== last) log.push([Math.round(performance.now() - t0), on]);
  };
  if (window['__' + slot + 'Obs']) window['__' + slot + 'Obs'].disconnect();
  window['__' + slot + 'Obs'] = new MutationObserver(look);
  window['__' + slot + 'Obs'].observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });
}, sel, slot, cls);
const tabLog = () => page.evaluate(() => window.__tl.slice());
const openIn = (n) => page.evaluate((n) => { window.latTabs.openIn('page', n); }, n);
const lineLog = () => page.evaluate(() => window.__bl.slice());
const firstOn = (log) => (log.find((e) => e[1]) || [null])[0];
const lastOff = (log) => { const o = log.filter((e) => !e[1]); return o.length ? o[o.length - 1][0] : null; };
const shows = (n) => until((n) => document.getElementById('src').value.includes('loadmark ' + n), n, 20000);

try {
  await page.goto(env.app, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(() => window.latTabs && document.querySelector('#ribbon .rtop button'),
    { timeout: 90000 });
  await sleep(1500);
  //  the frame of the browser tab in front
  await page.evaluate(() => {
    window.__frontF = () => {
      const s = window.latTabs.state();
      return document.querySelector('#toolhost iframe[data-tool="' + s.tabs[s.active].key + '"]');
    };
  });

  // ── the editor ─────────────────────────────────────────────────────────
  await mark('#center');
  await openIn(SLOW);
  const early = await page.evaluate(() => document.getElementById('center').classList.contains('lbusy'));
  const slowShown = await shows(SLOW);
  await sleep(300);
  const slowLog = await lineLog();
  const slowOff = await page.evaluate(() => !document.getElementById('center').classList.contains('lbusy'));
  check('a slow page open shows the line after the delay, not before',
    !early && firstOn(slowLog) !== null && firstOn(slowLog) >= 150 && firstOn(slowLog) < 1000,
    JSON.stringify(slowLog));
  check('and clears it when the page lands', slowShown && slowOff && lastOff(slowLog) >= 2300,
    JSON.stringify({ slowShown, slowLog }));

  await mark('#center');
  await openIn(FAST);
  const fastShown = await shows(FAST);
  await sleep(1200);
  const fastLog = await lineLog();
  check('a fast page open never shows the line', fastShown && fastLog.length === 0, JSON.stringify(fastLog));

  //  superseded: SLOW2 is held 4 s, FAST (now in the session cache) opens over it
  await mark('#center');
  await openIn(SLOW2);
  const on2 = await until(() => document.getElementById('center').classList.contains('lbusy'), null, 2000);
  const tSup = await page.evaluate((n) => {
    const t = Math.round(performance.now());
    window.latTabs.openIn('page', n);
    return t;
  }, FAST);
  await shows(FAST);
  const offSup = await until(() => !document.getElementById('center').classList.contains('lbusy'), null, 400);
  await sleep(4500);              // SLOW2's answer lands meanwhile, superseded
  const supLog = await lineLog();
  const after = await page.evaluate(() => ({
    on: document.getElementById('center').classList.contains('lbusy'),
    ed: document.getElementById('src').value.includes('loadmark'),
  }));
  check('a slow open superseded by another clears at once and stays clear',
    on2 && offSup && !after.on && supLog.filter((e) => e[1]).length === 1,
    JSON.stringify({ on2, offSup, tSup, supLog, after }));

  await mark('#center');
  await openIn(FAIL);
  const failOff = await until(() => /open failed/.test(document.getElementById('status').textContent)
    && !document.getElementById('center').classList.contains('lbusy'), null, 8000);
  const failLog = await lineLog();
  check('a failed open shows the line and clears it', failOff && firstOn(failLog) !== null,
    JSON.stringify({ failOff, failLog }));

  // ── a browser tab ──────────────────────────────────────────────────────
  frameDelay = 2500;
  await mark('.toolhost');
  await mark('.dtab', 'tl');
  await page.evaluate(() => document.getElementById('rb-browser').click());
  const frameUp = await until(() => {
    const s = window.latTabs.state();
    const k = s.tabs[s.active]?.key;
    const f = k && document.querySelector(`#toolhost iframe[data-tool="${k}"]`);
    return !!f && f.contentDocument?.readyState === 'complete'
      && f.contentWindow.location.href !== 'about:blank' && !!f.contentDocument.querySelector('form.bar');
  }, null, 30000);
  await sleep(300);
  const frameLog = await lineLog();
  const hostOff = await page.evaluate(() => ![...document.querySelectorAll('.toolhost')].some((h) => h.classList.contains('lbusy')));
  check('a slow browser tab shows the line on its frame after the delay and clears on load',
    frameUp && hostOff && firstOn(frameLog) >= 150 && firstOn(frameLog) < 1500 && lastOff(frameLog) >= 2000,
    JSON.stringify({ frameUp, hostOff, frameLog }));
  const spinLog = await tabLog();
  const spinOff = await page.evaluate(() => !document.querySelector('.dtab.lload'));
  check('a slow browser tab spins on its tab after the delay and stops on load',
    frameUp && spinOff && firstOn(spinLog) >= 150 && firstOn(spinLog) < 1500 && lastOff(spinLog) >= 2000,
    JSON.stringify({ spinOff, spinLog }));

  //  a navigation inside it (a script's, which the navigation API hears)
  const ship = await shipName(env);
  const cBase = JSON.parse(await getText('/apps/lattice/streams')).base;
  const view = '/apps/lattice/x/' + ship + cBase + '/page/' + FAST + '/';
  await mark('.toolhost');
  await page.evaluate((u) => { window.__frontF().contentWindow.location.href = u; }, view);
  const boxIn = (sel) => until((sel) => {
    const s = window.latTabs.state();
    const f = document.querySelector('#toolhost iframe[data-tool="' + s.tabs[s.active].key + '"]');
    return [...(f?.contentDocument?.querySelectorAll('iframe') || [])].some((i) => {
      try { return i.contentDocument.readyState === 'complete' && !!i.contentDocument.querySelector(sel); } catch { return false; }
    });
  }, sel, 30000);
  const navUp = await boxIn('form.cbox button');
  //  the frame's load comes after the srcdoc frame's inside it
  const navOff = await until(() => ![...document.querySelectorAll('.toolhost')].some((h) => h.classList.contains('lbusy')), null, 5000);
  const navLog = await lineLog();
  check('a navigation in a browser tab shows its line and clears on load',
    navUp && navOff && firstOn(navLog) !== null && navLog[navLog.length - 1][1] === false,
    JSON.stringify({ navUp, navOff, navLog }));

  //  the comment box there: the tab's line while the post is sent
  frameDelay = 0;
  commentDelay = 2500;
  await sleep(3000);                // the reader's page cache may swap the document once
  await boxIn('form.cbox button');
  comments = 0;
  const tabMark = 'loadingtab' + Date.now();
  await mark('.toolhost');
  await page.evaluate((m) => {
    for (const i of window.__frontF().contentDocument.querySelectorAll('iframe')) {
      const d = i.contentDocument;
      const t = d && d.querySelector('form.cbox textarea');
      if (!t) continue;
      t.value = m;
      window.__cbtn = d.querySelector('form.cbox button[type=submit]');
      window.__cbtn.click();
    }
  }, tabMark);
  await sleep(80);
  const tabBtn = await page.evaluate(() => !!window.__cbtn && window.__cbtn.disabled);
  await page.evaluate(() => { try { window.__cbtn.click(); } catch {} });
  await sleep(1000);
  const tabOn = await page.evaluate(() => [...document.querySelectorAll('.toolhost')].some((h) => h.classList.contains('lbusy')));
  await boxIn('form.cbox button:not([disabled])');
  await sleep(1500);
  const tabOff = await page.evaluate(() => ![...document.querySelectorAll('.toolhost')].some((h) => h.classList.contains('lbusy')));
  check('a comment sent from a browser tab disables Post and shows the tab\'s line until the reply',
    tabBtn && tabOn && tabOff && comments === 1,
    JSON.stringify({ tabBtn, tabOn, tabOff, comments, log: await lineLog() }));

  //  a comment that fails there: the text stays, through Back and Forward
  commentDelay = 0;
  commentFail = true;
  comments = 0;
  const failMark = 'loadingfail' + Date.now();
  const tabBox = () => page.evaluate(() => {
    const f = window.__frontF();
    for (const i of f?.contentDocument?.querySelectorAll('iframe') || []) {
      let d = null;
      try { d = i.contentDocument; } catch {}
      const t = d && d.querySelector('form.cbox textarea');
      if (t) return { text: t.value, err: (d.getElementById('latcerr') || {}).textContent || '',
        url: f.contentWindow.location.href };
    }
    return { text: null, url: f && f.contentWindow.location.href };
  });
  await page.evaluate((m) => {
    for (const i of window.__frontF().contentDocument.querySelectorAll('iframe')) {
      const d = i.contentDocument;
      const t = d && d.querySelector('form.cbox textarea');
      if (!t) continue;
      t.value = m;
      d.querySelector('form.cbox button[type=submit]').click();
    }
  }, failMark);
  await sleep(2500);
  const failed = await tabBox();
  const key = await page.evaluate(() => { const s = window.latTabs.state(); return s.tabs[s.active].key; });
  const fhClick = (b) => page.evaluate((b) => document.querySelector('.fhead:not([hidden]) [data-fh=' + b + ']').click(), b);
  await fhClick('back');
  await sleep(2500);
  await fhClick('fwd');
  await sleep(2500);
  await boxIn('form.cbox textarea');
  const again = await tabBox();
  const fnavNow = await page.evaluate((k) => window.latFnav(k), key);
  check('a comment that fails from a browser tab keeps its text and says why',
    comments === 1 && failed.text === failMark && /Not posted/.test(failed.err),
    JSON.stringify({ comments, failed }));
  check('and the text is still there after Back and Forward',
    again.text === failMark && fnavNow.cur === failed.url,
    JSON.stringify({ again, fnavNow }));
  commentFail = false;

  // ── the reader view on its own ─────────────────────────────────────────
  const rd = await openPage(browser, env, { viewport: { width: 1200, height: 900 } });
  await rd.setBypassServiceWorker(true);
  await rd.setRequestInterception(true);
  let rposts = 0;
  rd.on('request', async (r) => {
    try {
      if (r.method() === 'POST' && /\/apps\/lattice\/comment\?/.test(r.url())) { rposts++; await sleep(2500); }
      await r.continue();
    } catch {}
  });
  await rd.goto(env.base + view, { waitUntil: 'load', timeout: 60000 });
  const inner = async () => {
    for (const f of rd.frames()) {
      if (f === rd.mainFrame()) continue;
      try { if (await f.$('form.cbox button')) return f; } catch {}
    }
    return null;
  };
  let box = null;
  for (let i = 0; i < 40 && !box; i++) { box = await inner(); if (!box) await sleep(250); }
  //  the box's Post sits under its textarea, inside its edges, not out at
  //  the frame's right edge (a flex row once pushed it there)
  const boxAt = () => box.evaluate(() => {
    const t = document.querySelector('form.cbox textarea').getBoundingClientRect();
    const b = document.querySelector('form.cbox button[type=submit]').getBoundingClientRect();
    return { taL: t.left, taR: t.right, taB: t.bottom, btL: b.left, btR: b.right, btT: b.top, vw: innerWidth };
  });
  const placed = (r) => r.btT >= r.taB - 1 && r.btL >= r.taL - 4 && r.btR <= r.taR + 4 && r.btR < r.vw - 8;
  const wide = await boxAt();
  await rd.setViewport({ width: 375, height: 800 });
  await sleep(300);
  const phone = await boxAt();
  await rd.setViewport({ width: 1200, height: 900 });
  await sleep(300);
  check('the comment box\'s Post sits under its textarea, at desktop and phone width',
    placed(wide) && placed(phone), JSON.stringify({ wide, phone }));
  await rd.evaluate(() => { window.__before = 1; });
  const rdMark = 'loadingrd' + Date.now();
  const t0 = Date.now();
  //  The post navigates the reader's window, and puppeteer holds every
  //  evaluate in it until the new document is in. So the page notes what
  //  it shows at 60 ms and 450 ms itself, in localStorage, which the
  //  document after the reply reads back. At 60 ms it also clicks Post
  //  again and sends the form by script.
  await box.evaluate((m) => {
    const look = () => {
      const f = document.querySelector('form.cbox');
      const b = f.querySelector('button[type=submit]');
      const l = document.querySelector('.latbusy');
      return { dis: b.disabled, aria: f.getAttribute('aria-busy'),
        line: !!l && !l.hidden && getComputedStyle(l).position === 'fixed' };
    };
    localStorage.removeItem('latLoadA'); localStorage.removeItem('latLoadB');
    document.querySelector('form.cbox textarea').value = m;
    document.querySelector('form.cbox button[type=submit]').click();
    setTimeout(() => {
      localStorage.latLoadA = JSON.stringify(look());
      const f = document.querySelector('form.cbox');
      f.querySelector('button[type=submit]').click();
      try { f.requestSubmit(); } catch {}
    }, 60);
    setTimeout(() => { localStorage.latLoadB = JSON.stringify(look()); }, 450);
  }, rdMark);
  const replied = await rd.waitForFunction(() => window.__before !== 1, { timeout: 30000 }).then(() => true, () => false);
  const tReply = Date.now() - t0;
  box = null;
  for (let i = 0; i < 40 && !box; i++) { box = await inner(); if (!box) await sleep(250); }
  const fresh = box && await box.evaluate(() => !document.querySelector('form.cbox button[type=submit]').disabled);
  const once = (await getText(view)).split(rdMark).length - 1;
  const [busyNow, busyLater] = await rd.evaluate(() =>
    [JSON.parse(localStorage.latLoadA || '{}'), JSON.parse(localStorage.latLoadB || '{}')]);
  check('a reader comment disables Post at once, with no line before the delay',
    busyNow.dis && busyNow.aria === 'true' && !busyNow.line, JSON.stringify(busyNow));
  check('the line shows while the post is on its way', busyLater.line && busyLater.dis,
    JSON.stringify(busyLater));
  check('a second send while it is on its way sends nothing, and the reply re-enables Post',
    replied && rposts === 1 && once === 1 && fresh,
    JSON.stringify({ replied, rposts, once, fresh, tReply }));
  await rd.close();
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 160), false);
} finally {
  await browser.close();
}
check.done();
