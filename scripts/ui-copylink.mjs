// Copy link: a page's urb:// address on the clipboard, from the files
// tree's menu (a right-click or the row's ⋯), the page menu in the tab
// header, and the Page tab's sharing panel. Mine copies urb://<our
// ship>/<name>; a shared with me entry copies urb://<host>/<name>. Where
// navigator.clipboard is missing or refuses (the desktop app's WebKitGTK
// can), the hidden-textarea execCommand fallback still copies, and the
// status line says so either way.
//
// With B_URL and B_COOKIE (a second ship that can reach this one) it also
// proves the address resolves: B reads a private page this ship shared
// with it over /fetch, and still gets a 404 for a private page it was not
// given, from a path-scoped agent key, or once the share is revoked.
//   LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-copylink.mjs
import { readFileSync } from 'fs';
import { shipEnv, shipName, launchBrowser, openPage, makeCheck, swControlled, seed, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uicl' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const P = (s) => RUN + '/' + s;
const our = await shipName(env);

await seed(env, [[P('priv'), '# priv\n'], [P('open'), '# open\n'], [P('mine'), '# mine\n']]);

// a shared with me entry, as a share notice from another ship leaves it.
// The list is the client's to read, so the suite answers it: nothing on
// this ship has to be another ship's.
const SWM_HOST = '~zod';
const SWM_PATH = '/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app/page/notes/plan/code';
const SWM_KEY = ' shared/' + SWM_HOST + '/' + SWM_PATH;

const browser = await launchBrowser();
const errors = [];
const until = (pg, fn, arg, ms = 30000) =>
  pg.waitForFunction(fn, { timeout: ms }, arg).then(() => true, () => false);
const rowAt = (pg, tk) => pg.evaluate((k) => {
  const r = [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k);
  if (!r) return null;
  r.scrollIntoView({ block: 'center' });
  const b = r.getBoundingClientRect();
  return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
}, tk);
const rightClick = async (pg, tk) => {
  const at = await rowAt(pg, tk);
  if (!at) return false;
  await pg.mouse.click(at.x, at.y, { button: 'right' });
  return until(pg, () => !!document.querySelector('.treemenu'), null, 5000);
};
// a real click, so the copy runs inside a user gesture as it does for a person
const clickSel = async (pg, sel) => {
  const el = await pg.waitForSelector(sel, { visible: true, timeout: 5000 }).catch(() => null);
  if (!el) return false;
  await el.click();
  return true;
};
const clip = (pg) => pg.evaluate(() => navigator.clipboard.readText()).catch((e) => 'ERR ' + e);
const clearClip = (pg) => pg.evaluate(() => navigator.clipboard.writeText('-')).catch(() => {});
const status = (pg) => pg.evaluate(() => (document.getElementById('status') || {}).textContent || '');
const copiedSays = (pg, u) => until(pg, (x) =>
  ((document.getElementById('status') || {}).textContent || '').includes('link copied: ' + x), u, 5000);

try {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(env.base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await openPage(browser, env, { viewport: { width: 1280, height: 900 },
    onPageError: (e) => errors.push(String(e)) });
  await page.setRequestInterception(true);
  page.on('request', (rq) => {
    if (/\/apps\/lattice\/shared-with-me(\?|$)/.test(rq.url()))
      return rq.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ host: SWM_HOST, path: SWM_PATH, mode: 'read' }]) });
    rq.continue();
  });
  await page.goto(env.app + '?name=' + encodeURIComponent(P('open')), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await swControlled(page);
  await until(page, () => document.getElementById('src').value.includes('# open'), null, 90000);
  await until(page, (k) => [...document.querySelectorAll('#treelist [role=treeitem]')]
    .some((r) => r.dataset.tk === k), 'p:' + P('priv'), 60000);

  // ── the tree's menu, on one of my pages ─────────────────────────────────
  const mine = 'urb://' + our + '/' + P('priv');
  await clearClip(page);
  check('right-click on a page opens its menu', await rightClick(page, 'p:' + P('priv')));
  check('the menu offers Copy link first', await page.evaluate(() => {
    const b = document.querySelector('.treemenu button');
    return !!b && b.dataset.mi === 'link' && b.textContent === 'Copy link';
  }));
  check('Copy link clicked', await clickSel(page, '.treemenu [data-mi="link"]'));
  check('the status says the link was copied', await copiedSays(page, mine), await status(page));
  check.eq('the clipboard holds urb://<our ship>/<page>', await clip(page), mine);

  // ── a shared with me entry: the host's address, not mine ────────────────
  check('the shared with me entry is in the tree', await until(page, (k) =>
    [...document.querySelectorAll('#treelist [role=treeitem]')].some((r) => r.dataset.tk === k), SWM_KEY, 30000));
  const theirs = 'urb://' + SWM_HOST + '/notes/plan';
  await clearClip(page);
  check('right-click on the entry opens its menu', await rightClick(page, SWM_KEY));
  check('Copy link clicked on the entry', await clickSel(page, '.treemenu [data-mi="link"]'));
  check('the status names the host\'s link', await copiedSays(page, theirs), await status(page));
  check.eq('the clipboard holds urb://<host>/<page>', await clip(page), theirs);

  // ── the page menu, for the open page ────────────────────────────────────
  const open = 'urb://' + our + '/' + P('open');
  await clearClip(page);
  check('the page menu opens', await clickSel(page, '#tmenu'));
  check('Copy link clicked in the page menu', await clickSel(page, '.tmenu [data-mi="link"]'));
  check('the status says it', await copiedSays(page, open), await status(page));
  check.eq('the clipboard holds the open page\'s link', await clip(page), open);

  // ── the Page tab's sharing panel ────────────────────────────────────────
  // the right pane open on its Page tab, without closing it when it is
  const shown = () => page.evaluate(() => {
    const b = document.getElementById('shcopy');
    return !!b && !b.hidden && b.offsetParent !== null;
  });
  if (!(await shown())) await page.evaluate(() => {
    const t = document.querySelector('#rtabs [data-pt="page"]');
    if (t) t.click();
  });
  if (!(await shown())) await page.evaluate(() => document.getElementById('ctlt').click());
  await clearClip(page);
  const panel = await until(page, () => {
    const b = document.getElementById('shcopy');
    return !!b && !b.hidden && b.offsetParent !== null;
  }, null, 10000);
  check('the sharing panel shows copy link', panel);
  if (panel) {
    check('copy link clicked in the sharing panel', await clickSel(page, '#shcopy'));
    check('the panel copies the open page\'s link', await copiedSays(page, open), await status(page));
    check.eq('the clipboard holds it', await clip(page), open);
  }

  // ── no navigator.clipboard: the execCommand fallback ────────────────────
  // what an older WebKitGTK gives the desktop app. The page's own
  // clipboard goes, and execCommand is watched for what it copies.
  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const real = document.execCommand.bind(document);
    document.execCommand = (cmd, ...a) => {
      if (cmd === 'copy') {
        const el = document.activeElement;
        window.__copied = el && 'value' in el ? el.value.slice(el.selectionStart, el.selectionEnd) : null;
      }
      return real(cmd, ...a);
    };
  });
  const mine2 = 'urb://' + our + '/' + P('mine');
  check('right-click on another page', await rightClick(page, 'p:' + P('mine')));
  check('Copy link clicked without navigator.clipboard', await clickSel(page, '.treemenu [data-mi="link"]'));
  check('the fallback copies it, and says so', await copiedSays(page, mine2), await status(page));
  check.eq('execCommand copied the link', await page.evaluate(() => window.__copied), mine2);
  check('the hidden textarea is gone', await page.evaluate(() =>
    ![...document.querySelectorAll('body > textarea')].some((t) => t.style.opacity === '0')));
  check('the focus went back to the row', await page.evaluate((k) =>
    document.activeElement && document.activeElement.dataset.tk === k, 'p:' + P('mine')));

  check('no uncaught errors', errors.length === 0, errors.join(' | '));

  // ── two ships: the address resolves for a ship on the ACL, and only it ──
  if (process.env.B_URL && process.env.B_COOKIE) {
    const bBase = process.env.B_URL.replace(/\/$/, '');
    const bCookie = readFileSync(process.env.B_COOKIE.replace(/^~/, process.env.HOME), 'utf8').trim();
    const bShip = (await (await fetch(bBase + '/~/host')).text()).trim();
    const bFetch = (u) => fetch(bBase + '/apps/lattice/fetch?url=' + encodeURIComponent(u),
      { headers: { Cookie: bCookie }, signal: AbortSignal.timeout(90000) });
    const r0 = await bFetch(mine).catch(() => null);
    check('before a grant, ' + bShip + ' cannot read the private page', !!r0 && r0.status === 404,
      r0 && r0.status);
    const g = await api('share-file?name=' + encodeURIComponent(P('priv')) + '&ship=' +
      encodeURIComponent(bShip) + '&mode=read', { method: 'POST' });
    check('the page is shared with ' + bShip, g.ok, g.status);
    let got = null;
    await waitFor(async () => {
      const r = await bFetch(mine).catch(() => null);
      if (r && r.ok) got = await r.json();
      return !!got;
    }, 120000, 3000);
    check(bShip + ' reads the private page at its urb:// address', !!got && /# priv/.test(got.body || ''),
      JSON.stringify(got));
    check('as the page\'s own kind', !!got && got.mark === 'md', got && got.mark);
    const rv = await fetch(bBase + '/apps/lattice?url=' + encodeURIComponent(mine),
      { headers: { Cookie: bCookie }, signal: AbortSignal.timeout(90000) }).catch(() => null);
    const html = rv ? await rv.text() : '';
    check('and in the reader', !!rv && rv.ok && html.includes('priv') && !html.includes('not published here'),
      rv && rv.status);
    const r1 = await bFetch(mine2).catch(() => null);
    check('a private page not shared with ' + bShip + ' stays a 404', !!r1 && r1.status === 404, r1 && r1.status);
    // a miss costs one bounded extra ask, not a second full remote wait
    const t0 = Date.now();
    const r2 = await bFetch('urb://' + our + '/' + P('nothing-here')).catch(() => null);
    const missMs = Date.now() - t0;
    check('a name that is not there is a 404', !!r2 && r2.status === 404, r2 && r2.status);
    check('and answers inside 20 s', missMs < 20000, missMs + ' ms');
    // the share went to B's ship, not to its agent keys: a key whose web
    // scope names paths on this ship reads published pages there only,
    // while a web-wide key reads what B's ship could over /browse-file
    const bMint = async (web) => {
      const r = await fetch(bBase + '/apps/lattice/key-mint', { method: 'POST',
        headers: { Cookie: bCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: RUN, by: RUN, scope: { memory: 'none', pages: { all: 'none' },
          web, sensitive: false } }) }).then((x) => x.json()).catch(() => null);
      return r && r.token ? r : null;
    };
    const bKeyFetch = (k, u) => fetch(bBase + '/apps/lattice/fetch?url=' + encodeURIComponent(u),
      { headers: { Authorization: 'Bearer ' + k.token }, signal: AbortSignal.timeout(90000) }).catch(() => null);
    const kSome = await bMint({ some: { [our]: { read: ['/' + RUN], write: [] } } });
    const kAll = await bMint({ all: null });
    check('B mints a path-scoped and a web-wide key', !!kSome && !!kAll);
    if (kSome && kAll) {
      const rs = await bKeyFetch(kSome, mine);
      check('a path-scoped key does not read the page shared with B\'s ship', !!rs && rs.status === 404,
        rs && rs.status);
      const ra = await bKeyFetch(kAll, mine);
      const ja = ra && ra.ok ? await ra.json() : null;
      check('a web-wide key reads it, as /browse-file already lets it', !!ja && /# priv/.test(ja.body || ''),
        ra && ra.status);
    }
    for (const k of [kSome, kAll]) if (k) await fetch(bBase + '/apps/lattice/key-revoke?id=' +
      encodeURIComponent(k.key.id), { method: 'POST', headers: { Cookie: bCookie } }).catch(() => {});
    // revoked: the link goes dark again, with nothing cached on B
    const rg = await api('share-group-del?name=' + encodeURIComponent(bShip.replace(/^~/, '')),
      { method: 'POST' });
    check('the share with ' + bShip + ' is revoked', rg.ok, rg.status);
    let dark = false;
    await waitFor(async () => {
      const r = await bFetch(mine).catch(() => null);
      dark = !!r && r.status === 404;
      return dark;
    }, 60000, 3000);
    check('after the revoke, ' + bShip + ' gets a 404 again', dark);
    // the share notice left an entry in B's shared with me: take it off,
    // so a re-run starts from the same list
    const sw = await fetch(bBase + '/apps/lattice/shared-with-me', { headers: { Cookie: bCookie } })
      .then((r) => r.json()).catch(() => []);
    for (const it of sw.filter((x) => x.host === our && x.path.includes('/page/' + RUN + '/')))
      await fetch(bBase + '/apps/lattice/shared-with-me-del?host=' + encodeURIComponent(it.host) +
        '&path=' + encodeURIComponent(it.path), { method: 'POST', headers: { Cookie: bCookie } }).catch(() => {});
  } else {
    console.log('  skip - the two-ship checks: set B_URL and B_COOKIE');
  }
} catch (e) {
  check('suite ran to the end', false, e.stack || String(e));
} finally {
  await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' }).catch(() => {});
  await browser.close();
}
check.done();
