#!/usr/bin/env node
//  ui-reins-small.mjs: five small fixes to the editor shell, one block each.
//
//    the Files and Knowledge trees are ARIA trees the arrow keys walk, Enter
//      opens a page (Ctrl+Enter in a new tab) and Ctrl+Shift+E focuses Files
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-reins-small.mjs
import { shipEnv, launchBrowser, openPage, seed, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'reins-' + process.pid;
const PA = RUN + '/a';
const PB = RUN + '/sub/b';
const made = [PA, PB];
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
  await seed(env, [[PA, '# a\n'], [PB, '# b\n']]);
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
