#!/usr/bin/env node
//  ui-reins-small.mjs: five small fixes to the editor shell, one block each.
//
//    the Files and Knowledge trees are ARIA trees the arrow keys walk, Enter
//      opens a page (Ctrl+Enter in a new tab) and Ctrl+Shift+E focuses Files
//    the discard dialog for a long grub path (a shared page's) wraps the
//      path and keeps its buttons inside the box, at desktop and phone width
//    the share buttons say what each mode does, with the page's real
//      urb:// and https addresses, and no em-dash
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
const made = [PA, PB, LONG];
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
  check('the Knowledge list is an ARIA tree', aria.know === 'tree', JSON.stringify(aria));
  check('the Files tree is one tab stop', aria.stops === 1, JSON.stringify(aria));
  check('the Files tab tooltip names Ctrl+Shift+E', aria.tip === 'Files (Ctrl+Shift+E)', aria.tip);

  await page.evaluate(() => window.latShell.paneTab('l', 'know'));
  await page.evaluate(() => document.body.focus());
  await press('E', ['Control', 'Shift']);
  const viaKey = await page.evaluate(() => ({
    files: !document.querySelector('#lbody > [data-pane=files]').hidden,
    inTree: document.getElementById('treelist').contains(document.activeElement),
  }));
  check('Ctrl+Shift+E shows Files and focuses its tree', viaKey.files && viaKey.inTree, JSON.stringify(viaKey));

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
  check('Down skips the collapsed folder\'s rows', await focusKey() === A, await focusKey());
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
    check('shared says it publishes over Urbit to any lattice ship',
      /published over Urbit/.test(c.t.shared) && /Any ship running lattice can open it/.test(c.t.shared)
      && c.t.shared.includes('urb://' + ship + '/' + PA), JSON.stringify(c.t.shared));
    check('clearweb gives the https address and says it is public',
      /public on the web/.test(c.t.clearweb) && c.t.clearweb.includes(env.base + '/apps/lattice/c/' + PA),
      JSON.stringify(c.t.clearweb));
    check('private says who can read it', /^Private: only you/.test(c.t.private || ''), JSON.stringify(c.t.private));
    check('the open page\'s mode is described under the buttons', /^Private: /.test(c.what), c.what);
    check('no em-dash in the share copy', !JSON.stringify(c).includes('\u2014'), '');
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
  await browser.close();
}
check.done();
