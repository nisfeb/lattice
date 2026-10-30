#!/usr/bin/env node
//  ui-reins-small.mjs: five small fixes to the editor shell, one block each.
//
//    the Files and Knowledge trees are ARIA trees the arrow keys walk, Enter
//      opens a page (Ctrl+Enter in a new tab) and Alt+1 focuses Files
//      (not from behind the palette); type-ahead finds folders, and Enter on
//      a folder's + is the +
//    the discard dialog for a long grub path (a shared page's) wraps the
//      path and keeps its buttons inside the box, at desktop and phone width
//    the share buttons say what each mode does, with the page's real
//      urb:// and https addresses, and no em-dash
//    Access & groups lists every published page by its full address, shared
//      by urb:// and clearweb by the Page tab's https link, each copyable
//    clicking the words beside "mark sensitive" or "Comments on this page"
//      leaves the box alone; only the box itself toggles
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-reins-small.mjs
import { shipEnv, launchBrowser, openPage, seed, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'reins-' + process.pid;
const PA = RUN + '/a';
const PB = RUN + '/sub/b';
const LONG = RUN + '/a-really-long-page-name-that-keeps-going-and-going-past-the-dialog-edge';
const PS = RUN + '/zpub/shared-one';
const PC = RUN + '/zpub/web-one';
const made = [PA, PB, LONG, PS, PC];
const MEM = 'test/reins-suite';
//  screenshots for the report, when asked for
const SHOTS = process.env.REINS_SHOTS || '';
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});

const boot = async (p = page) => {
  await p.goto(env.app, { waitUntil: 'networkidle2', timeout: 90000 });
  await p.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
};
// the focused tree row's key, '' when the focus is elsewhere
const focusKey = () => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.getAttribute('role') === 'treeitem' ? a.dataset.tk : '';
});
const focusRow = (k) => page.evaluate((key) => {
  const r = document.querySelector('#treelist [data-tk="' + CSS.escape(key) + '"]');
  if (r) r.focus();
  return !!r;
}, k);
const press = async (k, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(k);
  for (const m of mods.reverse()) await page.keyboard.up(m);
  await sleep(150);
};

try {
  await seed(env, [[PA, '# a\n'], [PB, '# b\n'], [LONG, 'long\n']]);
  // a fixed key, restored and reused: know-delete is a soft delete with
  // no purge, so a per-run key would leave one in the trash every run
  const kpost = (q, body) => fetch(env.base + '/apps/lattice/' + q,
    { method: 'POST', headers: { Cookie: env.cookie }, body });
  await kpost('know-restore?key=' + encodeURIComponent(MEM)).catch(() => {});
  await kpost('know-save?key=' + encodeURIComponent(MEM), 'reins suite memory');
  await seed(env, [[PS, '# shared\n']], { share: 'shared' });
  await seed(env, [[PC, '# web\n']], { share: 'clearweb' });
  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => {
    for (const k of ['appNT', 'appNC', 'appLTab', 'appRTab', 'appTabs', 'appColl']) localStorage.removeItem(k);
  });
  await boot();

  // ── 1. tree keyboard navigation ────────────────────────────────────────
  const aria = await page.evaluate(() => {
    const t = document.getElementById('treelist');
    const k = document.getElementById('knowlist');
    return {
      tree: t.getAttribute('role'), know: k.getAttribute('role'),
      items: t.querySelectorAll('[role=treeitem]').length,
      stops: t.querySelectorAll('[role=treeitem][tabindex="0"]').length,
      tip: document.querySelector('[data-pt=files]').title,
    };
  });
  check('the Files list is an ARIA tree', aria.tree === 'tree' && aria.items > 2, JSON.stringify(aria));
  // the memories load when their tab is first shown; until a row exists
  // the list carries no tree role (a tree must own treeitems)
  await page.evaluate(() => window.latShell.paneTab('l', 'know'));
  await page.waitForFunction(() => document.querySelector('#knowlist [role=treeitem]'), { timeout: 30000 })
    .catch(() => {});
  const know = await page.evaluate(() => document.getElementById('knowlist').getAttribute('role'));
  check('the Knowledge list is an ARIA tree once it has rows', know === 'tree', know);
  check('it was not a tree while it held only the loading note', aria.know === null, String(aria.know));
  check('the Files tree is one tab stop', aria.stops === 1, JSON.stringify(aria));
  check('the Files tab tooltip names Alt+1', aria.tip === 'Files (Alt+1)', aria.tip);

  await page.evaluate(() => window.latShell.paneTab('l', 'know'));
  await page.evaluate(() => document.body.focus());
  await press('Digit1', ['Alt']);
  const viaKey = await page.evaluate(() => ({
    files: !document.querySelector('#lbody > [data-pane=files]').hidden,
    inTree: document.getElementById('treelist').contains(document.activeElement),
  }));
  check('Alt+1 shows Files and focuses its tree', viaKey.files && viaKey.inTree, JSON.stringify(viaKey));
  // not from behind a modal: the palette keeps the focus
  await page.evaluate(() => document.getElementById('rb-palette').click());
  await sleep(300);
  await press('Digit1', ['Alt']);
  const behind = await page.evaluate(() => ({
    open: !document.getElementById('palette').hidden,
    inTree: document.getElementById('treelist').contains(document.activeElement),
  }));
  check('Alt+1 does nothing while the palette is open', behind.open && !behind.inTree,
    JSON.stringify(behind));
  await press('Escape');

  const F = 'f:' + RUN, SUB = 'f:' + RUN + '/sub', A = 'p:' + PA, B = 'p:' + PB;
  await focusRow(F);
  await press('ArrowDown');
  check('Down moves to the folder\'s first child', await focusKey() === SUB, await focusKey());
  await press('ArrowDown');
  check('Down again reaches the nested page', await focusKey() === B, await focusKey());
  await press('ArrowLeft');
  check('Left on a page moves to its parent', await focusKey() === SUB, await focusKey());
  await press('ArrowLeft');
  const shut = await page.evaluate((k) =>
    document.querySelector('#treelist [data-tk="' + CSS.escape(k) + '"]').getAttribute('aria-expanded'), SUB);
  check('Left on an open folder collapses it, focus kept',
    shut === 'false' && await focusKey() === SUB, shut + ' ' + await focusKey());
  await press('ArrowDown');
  const past = await focusKey();
  check('Down skips the collapsed folder\'s rows',
    past && past !== SUB && !past.includes(RUN + '/sub/'), past);
  await press('ArrowUp');
  await press('ArrowRight');
  const opened = await page.evaluate((k) =>
    document.querySelector('#treelist [data-tk="' + CSS.escape(k) + '"]').getAttribute('aria-expanded'), SUB);
  check('Right on a closed folder expands it', opened === 'true' && await focusKey() === SUB, opened);
  await press('ArrowRight');
  check('Right on an open folder moves to its first child', await focusKey() === B, await focusKey());
  await press('Home');
  const first = await page.evaluate(() => document.querySelector('#treelist [role=treeitem]').dataset.tk);
  check('Home goes to the first row', await focusKey() === first, await focusKey());
  await press('End');
  const last = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#treelist [role=treeitem]')].filter((x) => x.style.display !== 'none');
    return r[r.length - 1].dataset.tk;
  });
  check('End goes to the last row', await focusKey() === last, await focusKey());
  await focusRow(F);
  await press('z');
  check('type-ahead lands on a folder by its name', await focusKey() === 'f:' + RUN + '/zpub', await focusKey());

  // Enter on a folder's + makes a page there, it does not select the folder
  await page.evaluate((k) => document.querySelector('#treelist [data-tk="' + CSS.escape(k) + '"] .addf').focus(), SUB);
  await press('Enter');
  await sleep(800);
  const plus = await page.evaluate(() => ({
    dlg: !document.getElementById('dlg').hidden, seed: document.getElementById('dlginput').value,
  }));
  check('Enter on a folder\'s + opens the new page dialog in it',
    plus.dlg && plus.seed.startsWith(RUN + '/sub'), JSON.stringify(plus));
  if (plus.dlg) await page.evaluate(() => document.getElementById('dlgcancel').click());
  await sleep(300);

  await focusRow(A);
  await press('Enter');
  await sleep(1500);
  const st1 = await page.evaluate(() => window.latTabs.state());
  check('Enter opens the page', st1.tabs[st1.active] && st1.tabs[st1.active].key === PA, JSON.stringify(st1));
  const n1 = st1.tabs.length;
  await focusRow(B);
  await press('Enter', ['Control']);
  await sleep(1500);
  const st2 = await page.evaluate(() => window.latTabs.state());
  check('Ctrl+Enter opens it in a new tab',
    st2.tabs.length === n1 + 1 && st2.tabs[st2.active].key === PB, JSON.stringify(st2));

  // ── 2. the discard dialog stays inside the viewport ────────────────────
  // A grub opened by ship, the way a shared-with-me page opens, made
  // dirty, then left: guardDirty asks with the whole grub path.
  for (const vp of [{ width: 1400, height: 900, tag: 'desktop' },
    { width: 390, height: 844, isMobile: true, hasTouch: true, tag: 'phone' }]) {
    const p = await openPage(browser, env, { viewport: vp });
    await boot(p);
    const base = await p.evaluate(() => localStorage.latBase);
    await p.evaluate(async (g) => window.latTabs.openIn('grub', g,
      { ship: (await (await fetch('/~/host')).text()).trim() }), base + '/page/' + LONG + '/code');
    await sleep(2500);
    await p.evaluate(() => {
      const s = document.getElementById('src');
      s.value += 'x';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(300);
    p.evaluate(() => window.latTabs.openIn('page', '', {}));
    await sleep(1200);
    const g = await p.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const box = r('.dlgbox'), msg = r('#dlgmsg'), ok = r('#dlgok'), no = r('#dlgcancel');
      const inside = (x) => x.left >= box.left - 0.5 && x.right <= box.right + 0.5
        && x.top >= box.top - 0.5 && x.bottom <= box.bottom + 0.5;
      return {
        shown: !document.getElementById('dlg').hidden,
        long: document.getElementById('dlgmsg').textContent.length > 120,
        inView: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
        msgIn: inside(msg), okIn: inside(ok), noIn: inside(no),
        box: [box.left, box.right, innerWidth].map(Math.round),
      };
    });
    if (SHOTS) await p.screenshot({ path: SHOTS + '/dialog-' + vp.tag + '.png' });
    check('the discard dialog asks with the long path (' + vp.tag + ')', g.shown && g.long, JSON.stringify(g));
    check('the dialog fits the viewport (' + vp.tag + ')', g.inView, JSON.stringify(g));
    check('the path wraps inside the box (' + vp.tag + ')', g.msgIn, JSON.stringify(g));
    check('both buttons sit inside the box (' + vp.tag + ')', g.okIn && g.noIn, JSON.stringify(g));
    await p.evaluate(() => document.getElementById('dlgok').click());
    await sleep(500);
    await p.close();
  }

  // ── 3. the sharing control says what each mode means ───────────────────
  {
    const ship = (await (await fetch(env.base + '/~/host')).text()).trim();
    await page.evaluate((k) => window.latTabs.openIn('page', k, {}), PA);
    await sleep(1500);
    await page.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'page'); });
    await sleep(300);
    const c = await page.evaluate(() => ({
      t: Object.fromEntries([...document.querySelectorAll('.share button')].map((b) => [b.dataset.m, b.title])),
      what: document.getElementById('sharewhat') ? document.getElementById('sharewhat').textContent : '',
    }));
    check('shared says any ship can read it over Urbit, at its address',
      c.t.shared.startsWith('Shared: any ship can read it over Urbit at urb://' + ship + '/' + PA + '.'),
      JSON.stringify(c.t.shared));
    check('clearweb gives the https address and says anyone can read it',
      /^Clearweb: anyone with the link can read it on the web at /.test(c.t.clearweb)
      && c.t.clearweb.includes(env.base + '/apps/lattice/c/' + PA), JSON.stringify(c.t.clearweb));
    check('private says who can read it', /^Private: only you/.test(c.t.private || ''), JSON.stringify(c.t.private));
    check('the open page\'s mode is described under the buttons', /^Private: /.test(c.what), c.what);
    check('no em-dash in the share copy', !JSON.stringify(c).includes('\u2014'), '');
    // a folder has no urb:// address, and a mixed one still says something
    await page.evaluate((k) => document.querySelector('#treelist [data-tk="' + CSS.escape(k) + '"]').click(),
      'f:' + RUN + '/zpub');
    await sleep(1200);
    const f = await page.evaluate(() => ({
      t: [...document.querySelectorAll('.share button')].map((b) => b.title),
      what: document.getElementById('sharewhat').textContent,
    }));
    check('a mixed folder is described, not left blank', /^Mixed: /.test(f.what), f.what);
    check('no folder gets a urb:// address', !/urb:\/\/~/.test(JSON.stringify(f)), JSON.stringify(f));
  }

  // ── 4. Published pages in Access & groups ──────────────────────────────
  {
    const ship = (await (await fetch(env.base + '/~/host')).text()).trim();
    // the Page tab's own link for the clearweb page, to match against
    await page.evaluate((k) => window.latTabs.openIn('page', k, {}), PC);
    await sleep(1500);
    const pageLink = await page.evaluate(() => {
      const a = document.querySelector('#cwurl a');
      return a ? a.href : '';
    });
    check('the palette lists Published pages', await page.evaluate(() =>
      window.latPalette.ids().includes('published')), '');
    await page.evaluate(() => document.getElementById('rb-access').click());
    await sleep(1200);
    const pub = await page.evaluate((run) => {
      const rows = [...document.querySelectorAll('#publist .pubrow')];
      const mine = rows.filter((r) => r.dataset.page.startsWith(run + '/'));
      const grp = (m) => rows.filter((r) => r.dataset.share === m).map((r) => r.dataset.page);
      return {
        shown: !document.getElementById('aclpub').closest('[hidden]'),
        mine: mine.map((r) => [r.dataset.share, r.dataset.page, r.querySelector('a').textContent]),
        sorted: ['shared', 'clearweb'].every((m) => {
          const g = grp(m);
          return g.every((x, i) => !i || g[i - 1].localeCompare(x) <= 0);
        }),
        tips: mine.map((r) => r.querySelector('button').title),
      };
    }, RUN);
    check('the list is in the Access & groups tab', pub.shown, JSON.stringify(pub));
    const sh = pub.mine.find((r) => r[1] === PS), cw = pub.mine.find((r) => r[1] === PC);
    check('the shared page is listed by its urb:// address',
      sh && sh[0] === 'shared' && sh[2] === 'urb://' + ship + '/' + PS, JSON.stringify(pub.mine));
    check('the clearweb page is listed by its https link',
      cw && cw[0] === 'clearweb' && cw[2] === env.base + '/apps/lattice/c/' + PC, JSON.stringify(pub.mine));
    check('the same link the Page tab shows', cw && cw[2] === pageLink, pageLink);
    check('private pages are not listed', pub.mine.length === 2, JSON.stringify(pub.mine));
    check('each group is sorted by path', pub.sorted, '');
    check('the copy button is named', pub.tips.every((t) => t === 'Copy address'), JSON.stringify(pub.tips));
    await page.evaluate(() => {
      window.__clip = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async (t) => { window.__clip.push(t); } } });
    });
    await page.evaluate((k) => document.querySelector('#publist .pubrow[data-page="' + k + '"] button').click(), PS);
    await sleep(200);
    const clip = await page.evaluate(() => window.__clip);
    check('copy puts the address on the clipboard', clip[0] === 'urb://' + ship + '/' + PS, JSON.stringify(clip));
    if (SHOTS) {
      await page.evaluate(() => document.getElementById('aclpub').scrollIntoView());
      await page.screenshot({ path: SHOTS + '/published-desktop.png' });
      const p = await openPage(browser, env, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
      await boot(p);
      await p.evaluate(() => window.latTabs.openIn('tool', 'access', { newTab: true }));
      await sleep(1500);
      await p.evaluate(() => document.getElementById('aclpub').scrollIntoView());
      await p.screenshot({ path: SHOTS + '/published-phone.png' });
      await p.close();
    }
  }

  // ── 4b. no ship name, no address: never a placeholder ─────────────────
  {
    const p = await openPage(browser, env, { viewport: { width: 1400, height: 900 } });
    await p.setRequestInterception(true);
    p.on('request', (r) => (r.url().endsWith('/~/host') ? r.abort() : r.continue()));
    await boot(p);
    await p.evaluate(() => document.getElementById('rb-access').click());
    await sleep(1200);
    const r = await p.evaluate((k) => {
      const row = document.querySelector('#publist .pubrow[data-page="' + k + '"]');
      return row ? { text: row.textContent, off: row.querySelector('button').disabled } : null;
    }, PS);
    check('without the ship name a shared row says so, and cannot copy',
      r && /address unavailable/.test(r.text) && !r.text.includes('urb://') && r.off, JSON.stringify(r));
    await p.evaluate((k) => window.latTabs.openIn('page', k, {}), PS);
    await sleep(1500);
    const t = await p.evaluate(() => document.querySelector('.share button[data-m=shared]').title);
    check('and the share copy says the address is unavailable',
      /\(address unavailable\)/.test(t) && !t.includes('urb://'), t);
    await p.close();
  }

  // ── 5. only the checkbox toggles, not the words beside it ──────────────
  {
    await page.evaluate((k) => window.latTabs.openIn('page', k, {}), PA);
    await sleep(1500);
    await page.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'page'); });
    await page.waitForFunction(() => !document.getElementById('shsens').disabled
      && !document.getElementById('cmton').disabled, { timeout: 20000 });
    await sleep(800);
    // a real click on the middle of the words, wherever they are drawn
    const clickText = async (needle) => {
      const at = await page.evaluate((n) => {
        const w = document.createTreeWalker(document.querySelector('aside.ctl'), NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode(); t; t = w.nextNode()) {
          const i = t.data.indexOf(n);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(t, i); r.setEnd(t, i + n.length);
          // the first line's box: a phrase that wraps has a bounding box
          // whose middle can fall between the words
          const b = r.getClientRects()[0];
          if (b && b.width) return [b.left + b.width / 2, b.top + b.height / 2];
        }
        return null;
      }, needle);
      if (at) await page.mouse.click(at[0], at[1]);
      await sleep(600);
      return !!at;
    };
    const box = async (id) => {
      const b = await page.evaluate((x) => {
        const r = document.getElementById(x).getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      }, id);
      await page.mouse.click(b[0], b[1]);
    };
    const checked = (id) => page.evaluate((x) => document.getElementById(x).checked, id);
    for (const [id, words] of [['shsens', 'without clearance'], ['cmton', 'Comments on this page']]) {
      const was = await checked(id);
      const hit = await clickText(words);
      check('clicking the words beside ' + id + ' leaves it alone', hit && await checked(id) === was,
        JSON.stringify({ hit, was, now: await checked(id) }));
      await box(id);
      await page.waitForFunction((x) => !document.getElementById(x).disabled, { timeout: 20000 }, id);
      check('clicking the ' + id + ' box toggles it', await checked(id) === !was, '');
      await box(id);       // and back, so the page is left as it was
      await page.waitForFunction((x) => !document.getElementById(x).disabled, { timeout: 20000 }, id);
      const named = await page.evaluate((x) => {
        const e = document.getElementById(x);
        return !!(e.getAttribute('aria-label') || e.labels.length);
      }, id);
      check(id + ' keeps an accessible name', named, '');
    }
  }

  // ── 4c. a urb:// row leaves the editor through the unsaved-work guard ──
  {
    const base = await page.evaluate(() => localStorage.latBase);
    const ship = (await (await fetch(env.base + '/~/host')).text()).trim();
    await page.evaluate(async (g, sh) => window.latTabs.openIn('grub', g, { ship: sh }),
      base + '/page/' + LONG + '/code', ship);
    await sleep(2500);
    await page.evaluate(() => {
      const s = document.getElementById('src');
      s.value += 'y';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => document.getElementById('rb-access').click());
    await sleep(1200);
    const before = page.url();
    await page.evaluate((k) =>
      document.querySelector('#publist .pubrow[data-page="' + k + '"] a').click(), PS);
    await sleep(800);
    const asked = await page.evaluate(() => ({
      dlg: !document.getElementById('dlg').hidden, msg: document.getElementById('dlgmsg').textContent,
    }));
    check('a urb:// row asks about unsaved work before leaving', asked.dlg && page.url() === before,
      JSON.stringify(asked));
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }).catch(() => null),
      page.evaluate(() => document.getElementById('dlgok').click()),
    ]);
    const u = new URL(page.url());
    check('and then opens the page in the reader',
      u.pathname === '/apps/lattice' && u.searchParams.get('url') === 'urb://' + ship + '/' + PS, page.url());
  }
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  for (const n of made) {
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  }
  await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(RUN),
    { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  await fetch(env.base + '/apps/lattice/know-delete?key=' + encodeURIComponent(MEM),
    { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  await browser.close();
}
check.done();
