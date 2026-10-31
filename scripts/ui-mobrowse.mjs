//  ui-mobrowse.mjs: a browsing tab's frame header (src/29-fhead.js).
//
//  A browser, forum or explorer tab hides the reader bar in its frame and
//  its group shows one slim header instead: Back, Forward and an omnibar
//  with the reader's history and suggestions, where Return or a tap on a
//  suggestion navigates (no Go). On a phone the front group's header sits in
//  the top row between the drawer toggles, with no Forward. On the desktop
//  each group shows the header of its own browsing tab.
//
//  Seeds two shared pages in a mobrowse-<pid> folder.
//
//  Usage:  LATTICE_URL=http://localhost:8135 LATTICE_COOKIE=/tmp/mun-cookie.txt \
//          node scripts/ui-mobrowse.mjs        (SHOTS=1 saves /tmp/mobrowse-*.png)
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep, shipName } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'mobrowse-' + process.pid;
const ONE = RUN + '/one';
const TWO = RUN + '/two';
const PAGE = RUN + '/page';
await seed(env, [[ONE, '# mobrowse one\n\nThe first page.'], [TWO, '# mobrowse two\n\nThe second page.']],
  { share: 'shared' });
await seed(env, [[PAGE, '# a page tab\n']]);
const SHIP = await shipName(env);
const U1 = 'urb://' + SHIP + '/' + ONE;
const U2 = 'urb://' + SHIP + '/' + TWO;
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const SHOTS = !!process.env.SHOTS;

const open = async (vp) => {
  const p = await openPage(browser, env, { viewport: vp,
    onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false) });
  await p.goto(env.app, { waitUntil: 'networkidle2', timeout: 90000 });
  await p.waitForFunction(() => window.latTabs && window.latSplits
    && document.querySelector('#ribbon .rtop button'), { timeout: 90000 });
  await sleep(800);
  // a clean slate: no tool tabs, one group, the page in front
  await p.evaluate(async (n) => {
    for (const t of window.latTabs.state().tabs.filter((x) => x.kind === 'tool'))
      await window.latTabs.closeTab(t.id);
    await window.latTabs.openIn('page', n);
  }, PAGE);
  await sleep(500);
  return p;
};
const until = (p, fn, arg, ms = 30000) => p.waitForFunction(fn, { timeout: ms }, arg)
  .then(() => true, () => false);
// the header of the i-th group (in creation order), as the user sees it
const hdr = (p, i = null) => p.evaluate((gi) => {
  const gs = [...document.querySelectorAll('#groot .tgroup')];
  const g = gi === null ? document.querySelector('#groot .tgroup.gfocus') : gs[gi];
  const h = g && g.querySelector(':scope > .fhead');
  const shown = !!h && !h.hidden && h.getBoundingClientRect().height > 0;
  const fr = g && [...g.querySelectorAll('.toolhost iframe')].find((f) => !f.hidden);
  let at = null, barShown = null;
  try {
    const d = fr && fr.contentDocument;
    at = d ? fr.contentWindow.location.pathname + fr.contentWindow.location.search : null;
    const bar = d && d.querySelector('form.bar, form.cbar');
    barShown = bar ? getComputedStyle(bar).display !== 'none' : false;
  } catch {}
  const b = h && h.querySelector('[data-fh=back]');
  const f = h && h.querySelector('[data-fh=fwd]');
  const r = h ? h.getBoundingClientRect() : null;
  return { shown, addr: h ? h.querySelector('.fhin').value : null,
    back: b ? !b.disabled : null, fwd: f ? !f.disabled : null,
    fwdShown: !!f && getComputedStyle(f).display !== 'none',
    go: !!h && !!h.querySelector('button[type=submit], [data-fh=go]'),
    rect: r && { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height },
    pos: h ? getComputedStyle(h).position : null, at, barShown,
    tabhead: !document.getElementById('tabhead').hidden };
}, i);
//  the frame of group gi (null: the one in front) loaded and dressed, at a
//  page whose path and query, less the service worker's u=, decoded, match
const frameReady = (p, gi, pathRe) => until(p, ([g, re]) => {
  const gs = [...document.querySelectorAll('#groot .tgroup')];
  const el = g === null ? document.querySelector('#groot .tgroup.gfocus') : gs[g];
  const fr = el && [...el.querySelectorAll('.toolhost iframe')].find((f) => !f.hidden);
  try {
    const d = fr.contentDocument;
    const u = new URL(fr.contentWindow.location.href);
    u.searchParams.delete('u');
    return d.readyState === 'complete' && new RegExp(re).test(decodeURIComponent(u.pathname + u.search))
      && !!d.querySelector('style') && !!el.querySelector(':scope > .fhead:not([hidden])');
  } catch { return false; }
}, [gi, pathRe.source]);
const browseTo = (p, url) => p.evaluate((u) => window.latTabs.openIn('tool',
  'frame:/apps/lattice?url=' + encodeURIComponent(u) + '#b' + Math.random().toString(36).slice(2),
  { newTab: true }), url);
const forum = (p) => p.evaluate(() => window.latTabs.openIn('tool', 'frame:/apps/lattice/forum',
  { newTab: true }));
const esc = (u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const atUrl = (u) => new RegExp('^/apps/lattice\\?url=' + esc(u) + '$');
// type into the front group's address and press Return
const typeGo = async (p, v, gi = null) => {
  const sel = gi === null ? '#groot .tgroup.gfocus > .fhead .fhin'
    : `#groot .tgroup:nth-of-type(${gi + 1}) > .fhead .fhin`;
  await p.click(sel);
  await p.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
  await p.type(sel, v);
  await p.keyboard.press('Enter');
};
const theme = async (p, dark) => {
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await sleep(400);
};
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: '/tmp/mobrowse-' + name + '.png' }); };

try {
  // ── phone ────────────────────────────────────────────────────────────────
  {
    const m = await open({ width: 390, height: 844, isMobile: true, hasTouch: true });
    let h = await hdr(m);
    check('phone: a page tab shows the normal top row (no header)', !h.shown, JSON.stringify(h));

    await browseTo(m, U1);
    check('phone: the browser tab loads', await frameReady(m, null, atUrl(U1)));
    h = await hdr(m);
    check('phone: the header shows for a browser tab', h.shown, JSON.stringify(h));
    const row = await m.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { l: r('treet').right, r: r('ctlt').left, t: r('treet').top, b: r('treet').bottom };
    });
    check('phone: it sits in the top row, between the side toggles',
      h.rect.l >= row.l - 1 && h.rect.r <= row.r + 1 && h.rect.t < row.b && h.rect.b > row.t
      && h.rect.h <= 40, JSON.stringify({ h: h.rect, row }));
    check('phone: it holds the address', h.addr === U1, h.addr);
    check('phone: no Go and no Forward', !h.go && !h.fwdShown, JSON.stringify(h));
    check('phone: Back is disabled at the start', h.back === false);
    check('phone: the in-frame bar is hidden', h.barShown === false);
    check('phone: no tab header under the strip either', !h.tabhead);
    // the frame takes the space from the strip down
    const gap = await m.evaluate(() => {
      const f = [...document.querySelectorAll('#toolhost iframe')].find((x) => !x.hidden);
      return f.getBoundingClientRect().top - document.getElementById('doctabs').getBoundingClientRect().bottom;
    });
    check('phone: the page starts right under the tab strip', Math.abs(gap) <= 1, String(gap));

    await typeGo(m, U2);
    check('phone: Return navigates', await frameReady(m, null, atUrl(U2)));
    h = await hdr(m);
    check('phone: the address follows the frame', h.addr === U2, h.addr);
    check('phone: and Back is enabled', h.back === true);
    await m.tap('#groot .tgroup.gfocus > .fhead [data-fh=back]');
    check('phone: Back goes back', await frameReady(m, null, atUrl(U1)));
    await until(m, () => document.querySelector('#groot .tgroup.gfocus > .fhead [data-fh=back]').disabled, null, 5000);
    h = await hdr(m);
    check('phone: back at the start, Back is disabled again', h.addr === U1 && h.back === false,
      JSON.stringify(h));

    // a link inside the page moves the address too
    const clicked = await m.evaluate(() => {
      const f = [...document.querySelectorAll('#toolhost iframe')].find((x) => !x.hidden);
      const a = f.contentDocument.createElement('a');
      a.href = '/apps/lattice/forum';
      f.contentDocument.body.append(a);
      a.click();
      return true;
    });
    check('phone: a link in the page moves the address',
      clicked && await frameReady(m, null, /^\/apps\/lattice\/forum$/)
      && await until(m, () => document.querySelector('#groot .tgroup.gfocus > .fhead .fhin').value === '/forum'));
    await m.tap('#groot .tgroup.gfocus > .fhead [data-fh=back]');
    await frameReady(m, null, atUrl(U1));

    // the suggestions: typing shows them, a tap on one navigates
    for (const dark of [true, false]) {
      await theme(m, dark);
      await shot(m, 'phone-browser-' + (dark ? 'dark' : 'light'));
    }
    await m.tap('#groot .tgroup.gfocus > .fhead .fhin');
    await m.evaluate(() => { document.querySelector('#groot .tgroup.gfocus > .fhead .fhin').value = ''; });
    await m.type('#groot .tgroup.gfocus > .fhead .fhin', RUN + '/two');
    const sug = await until(m, (u) => [...document.querySelectorAll('.tgroup.gfocus .fhrow')]
      .some((r) => r.querySelector('.fhurl').textContent === u), U2, 10000);
    check('phone: typing shows the history and suggestions', sug);
    for (const dark of [true, false]) {
      await theme(m, dark);
      await shot(m, 'phone-omnibar-' + (dark ? 'dark' : 'light'));
    }
    const rowAt = await m.evaluate((u) => {
      const r = [...document.querySelectorAll('.tgroup.gfocus .fhrow')]
        .find((x) => x.querySelector('.fhurl').textContent === u);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, U2);
    await m.touchscreen.tap(rowAt.x, rowAt.y);
    check('phone: a tap on a suggestion navigates', await frameReady(m, null, atUrl(U2)));
    h = await hdr(m);
    check('phone: and the list goes away', h.addr === U2 && await m.evaluate(() =>
      document.querySelector('.tgroup.gfocus .fhlist').hidden), JSON.stringify(h));

    // the forum: its route is the address, and Return goes where it says
    await forum(m);
    check('phone: the forum tab loads', await frameReady(m, null, /^\/apps\/lattice\/forum$/));
    h = await hdr(m);
    check('phone: the header shows for the forum, with its route', h.shown && h.addr === '/forum',
      JSON.stringify(h));
    check('phone: the forum starts with Back disabled', h.back === false);
    check('phone: the forum\'s own bar is hidden', h.barShown === false);
    for (const dark of [true, false]) {
      await theme(m, dark);
      await shot(m, 'phone-forum-' + (dark ? 'dark' : 'light'));
    }
    await typeGo(m, '/forum/_new');
    check('phone: Return on a route goes to it', await frameReady(m, null, /^\/apps\/lattice\/forum\/_new$/));
    h = await hdr(m);
    check('phone: the forum route follows', h.addr === '/forum/_new' && h.back === true, JSON.stringify(h));

    // tab switches carry the header over
    const tabs = await m.evaluate(() => window.latTabs.state().tabs);
    const bt = tabs.find((t) => t.kind === 'tool' && t.key.startsWith('frame:/apps/lattice?'));
    await m.evaluate((id) => window.latTabs.switchTab(id), bt.id);
    await sleep(400);
    h = await hdr(m);
    check('phone: switching to the browser tab shows its address and Back',
      h.shown && h.addr === U2 && h.back === true, JSON.stringify(h));
    const pt = tabs.find((t) => t.kind === 'page');
    await m.evaluate((id) => window.latTabs.switchTab(id), pt.id);
    await sleep(400);
    h = await hdr(m);
    check('phone: a page tab shows the normal top row again', !h.shown && !(await m.evaluate(() =>
      document.querySelector('.fhead:not([hidden])'))), JSON.stringify(h));
    const ft = tabs.find((t) => t.key === 'frame:/apps/lattice/forum');
    await m.evaluate((id) => window.latTabs.switchTab(id), ft.id);
    await sleep(400);
    h = await hdr(m);
    check('phone: and back to the forum, its route', h.shown && h.addr === '/forum/_new', JSON.stringify(h));
    await m.close();
  }

  // ── desktop ──────────────────────────────────────────────────────────────
  {
    const d = await open({ width: 1400, height: 900 });
    let h = await hdr(d, 0);
    check('desktop: a page tab has no frame header', !h.shown && h.tabhead, JSON.stringify(h));
    await browseTo(d, U1);
    check('desktop: the browser tab loads', await frameReady(d, 0, atUrl(U1)));
    h = await hdr(d, 0);
    const strip = await d.evaluate(() => document.getElementById('doctabs').getBoundingClientRect().height);
    check('desktop: one slim header in the group, the strip\'s height',
      h.shown && h.pos !== 'fixed' && Math.abs(h.rect.h - strip) <= 1, JSON.stringify({ h, strip }));
    check('desktop: Back, Forward, the address, no Go',
      h.fwdShown && !h.go && h.addr === U1 && h.back === false && h.fwd === false, JSON.stringify(h));
    check('desktop: the in-frame bar and the tab header are hidden', h.barShown === false && !h.tabhead,
      JSON.stringify(h));

    // a second group with its own browser tab
    await d.evaluate(() => window.latSplits.split('r'));
    await sleep(600);
    await browseTo(d, U2);
    check('desktop: a browser tab in a second group loads', await frameReady(d, 1, atUrl(U2)));
    const h0 = await hdr(d, 0), h1 = await hdr(d, 1);
    check('desktop: each group shows its own browser tab\'s header',
      h0.shown && h1.shown && h0.addr === U1 && h1.addr === U2, JSON.stringify({ h0, h1 }));
    check('desktop: the parked group shows no tab header over its frame', await d.evaluate(() =>
      [...document.querySelectorAll('.tgroup:not(.gfocus) .ghead')].every((x) => x.hidden
        || x.closest('.gghost').hidden)));

    // back and forward in the second group, the first left alone
    await typeGo(d, U1, 1);
    check('desktop: Return navigates in its own group', await frameReady(d, 1, atUrl(U1)));
    h = await hdr(d, 1);
    check('desktop: Back on, Forward off', h.back === true && h.fwd === false && h.addr === U1,
      JSON.stringify(h));
    await d.click('#groot .tgroup:nth-of-type(2) > .fhead [data-fh=back]');
    check('desktop: Back goes back', await frameReady(d, 1, atUrl(U2)));
    await until(d, () => !document.querySelector('#groot .tgroup:nth-of-type(2) > .fhead [data-fh=fwd]').disabled, null, 5000);
    h = await hdr(d, 1);
    check('desktop: then Back off, Forward on', h.back === false && h.fwd === true && h.addr === U2,
      JSON.stringify(h));
    await d.click('#groot .tgroup:nth-of-type(2) > .fhead [data-fh=fwd]');
    check('desktop: Forward goes forward', await frameReady(d, 1, atUrl(U1)));
    await until(d, () => document.querySelector('#groot .tgroup:nth-of-type(2) > .fhead [data-fh=fwd]').disabled, null, 5000);
    h = await hdr(d, 1);
    check('desktop: and Forward is off again', h.back === true && h.fwd === false, JSON.stringify(h));
    h = await hdr(d, 0);
    check('desktop: the other group kept its own page and history',
      h.addr === U1 && h.back === false && h.at && atUrl(U1).test(decodeURIComponent(h.at).replace(/[?&]u=sw\d+$/, '')), JSON.stringify(h));

    // the suggestions on the desktop
    await d.click('#groot .tgroup:nth-of-type(1) > .fhead .fhin');
    await d.keyboard.type(RUN);
    check('desktop: typing shows suggestions', await until(d, () =>
      document.querySelectorAll('#groot .tgroup:nth-of-type(1) .fhrow').length > 0, null, 10000));
    await d.keyboard.press('ArrowDown');
    const want = await d.evaluate(() => document.querySelector('#groot .tgroup:nth-of-type(1) .fhrow.on .fhurl').textContent);
    for (const dark of [true, false]) {
      await theme(d, dark);
      await shot(d, 'desktop-omnibar-' + (dark ? 'dark' : 'light'));
    }
    await d.keyboard.press('Enter');
    check('desktop: Return on a picked suggestion goes there', await frameReady(d, 0, atUrl(want)), want);

    // the header follows the tab in front of its group: a forum beside,
    // in the second group, brought to the front by a press in it
    await d.click('#groot .tgroup:nth-of-type(2) > .fhead .fhin');
    await d.keyboard.press('Escape');
    await sleep(300);
    await forum(d);
    check('desktop: a forum tab in the second group loads', await frameReady(d, 1, /^\/apps\/lattice\/forum$/));
    h = await hdr(d, 1);
    check('desktop: its header shows the forum route', h.shown && h.addr === '/forum' && h.barShown === false,
      JSON.stringify(h));
    h = await hdr(d, 0);
    check('desktop: the browser beside it keeps its header', h.shown && h.addr === want, JSON.stringify(h));
    for (const dark of [true, false]) {
      await theme(d, dark);
      await shot(d, 'desktop-split-' + (dark ? 'dark' : 'light'));
    }
    const pt = await d.evaluate(() => window.latTabs.state().tabs.find((t) => t.kind === 'page').id);
    await d.evaluate((id) => window.latTabs.switchTab(id), pt);
    await sleep(500);
    h = await hdr(d, 1);
    check('desktop: a page tab in front of the group takes the header away', !h.shown && h.tabhead,
      JSON.stringify(h));
    await d.evaluate(async () => {
      for (const t of window.latTabs.state().tabs.filter((x) => x.kind === 'tool'))
        await window.latTabs.closeTab(t.id);
    });
    await d.close();
  }
} catch (e) {
  check('threw: ' + String(e && e.message).slice(0, 160), false);
} finally {
  await browser.close();
  await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(RUN),
    { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
