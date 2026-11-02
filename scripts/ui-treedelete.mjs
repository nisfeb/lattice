// Deleting from the files tree: a right-click (or a long press on a phone)
// opens the row's menu, and Delete there, or the Delete key on a focused
// row, asks in the app's own modal first. The modal names what goes and
// how many pages, says it is permanent, and holds the focus on Cancel, so
// Enter never deletes. What is open stays open unless it is what went.
//   LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-treedelete.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, swControlled, seed, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uitd' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const exists = async (n) => (await api('page-source?name=' + encodeURIComponent(n))).ok;
const P = (s) => RUN + '/' + s;

await seed(env, [[P('keep'), '# keep\n'], [P('a'), '# a\n'], [P('f/x'), '# x\n'], [P('f/y'), '# y\n'],
  [P('k'), '# k\n'], [P('kf/z'), '# z\n'], [P('e'), '# e\n'], [P('open'), '# open\n'], [P('ph'), '# ph\n'],
  [P('mf/a'), '# a\n'], [P('mf/b'), '# b\n'], [P('click'), '# click\n'], [P('pf/a'), '# a\n'], [P('pf/b'), '# b\n']]);
await seed(env, [[P('pub'), '# pub\n']], { share: 'shared' });

const browser = await launchBrowser();
const errors = [];
const noNative = (pg) => pg.evaluateOnNewDocument(() => {
  for (const f of ['alert', 'confirm', 'prompt'])
    window[f] = () => { throw new Error('native ' + f + '() used'); };
});

const until = (pg, fn, arg, ms = 30000) =>
  pg.waitForFunction(fn, { timeout: ms }, arg).then(() => true, () => false);
const dlgUp = (pg) => until(pg, () => !document.getElementById('dlg').hidden, null, 10000);
const dlgDown = (pg) => until(pg, () => document.getElementById('dlg').hidden, null, 10000);
const dlgText = (pg) => pg.evaluate(() => document.getElementById('dlgmsg').textContent);
const rowThere = (pg, tk) => pg.evaluate((k) =>
  [...document.querySelectorAll('#treelist [role=treeitem]')].some((r) => r.dataset.tk === k), tk);
// the row on screen, by its tree key: its centre, for a pointer
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
const menuPick = (pg, id) => pg.evaluate((i) => {
  const b = document.querySelector('.treemenu [data-mi="' + i + '"]');
  if (b) b.click();
  return !!b;
}, id);
const focusRow = (pg, tk) => pg.evaluate((k) => {
  const r = [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k);
  if (r) r.focus();
  return !!r && document.activeElement === r;
}, tk);
const pname = (pg) => pg.evaluate(() => document.getElementById('pname').value);
const gone = (n) => waitFor(async () => !(await exists(n)), 30000, 500);

try {
  const page = await openPage(browser, env, { viewport: { width: 1280, height: 900 },
    onPageError: (e) => errors.push(String(e)) });
  await noNative(page);
  await page.goto(env.app + '?name=' + encodeURIComponent(P('keep')), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await swControlled(page);
  await until(page, () => document.getElementById('src').value.includes('# keep'), null, 90000);
  await until(page, (k) => [...document.querySelectorAll('#treelist [role=treeitem]')]
    .some((r) => r.dataset.tk === k), 'p:' + P('ph'), 60000);

  // ── a page, from its menu: Cancel keeps it, Delete removes it ───────────
  check('right-click on a page opens its menu', await rightClick(page, 'p:' + P('a')));
  check('the menu offers Rename / move and Delete', await page.evaluate(() =>
    ['mv', 'del'].every((i) => !!document.querySelector('.treemenu [data-mi="' + i + '"]'))));
  await menuPick(page, 'del');
  check('Delete asks in the modal', await dlgUp(page));
  let msg = await dlgText(page);
  check('the modal names the page and says it is permanent',
    msg.includes(P('a')) && /permanent/.test(msg), msg);
  check('Cancel holds the focus', await page.evaluate(() => document.activeElement.id === 'dlgcancel'));
  await page.click('#dlgcancel');
  await dlgDown(page);
  await sleep(1500);
  check('Cancel keeps the page', (await exists(P('a'))) && (await rowThere(page, 'p:' + P('a'))));
  await rightClick(page, 'p:' + P('a'));
  await menuPick(page, 'del');
  await dlgUp(page);
  await page.click('#dlgok');
  check('Delete removes the page', await gone(P('a')));
  check('and its row', await until(page, (k) => ![...document.querySelectorAll('#treelist [role=treeitem]')]
    .some((r) => r.dataset.tk === k), 'p:' + P('a'), 10000));
  check('the open page stays open', (await pname(page)) === P('keep')
    && await page.evaluate(() => document.getElementById('src').value.includes('# keep')), await pname(page));

  // ── a folder with pages in it ────────────────────────────────────────────
  check('right-click on a folder opens its menu', await rightClick(page, 'f:' + P('f')));
  check('a folder\'s menu offers New page here', await page.evaluate(() =>
    !!document.querySelector('.treemenu [data-mi="new"]')));
  await menuPick(page, 'del');
  await dlgUp(page);
  msg = await dlgText(page);
  check('the modal names the folder and counts its 2 pages',
    msg.includes('folder ' + P('f')) && /\b2 pages\b/.test(msg) && /permanent/.test(msg), msg);
  await page.click('#dlgcancel');
  await dlgDown(page);
  await sleep(1500);
  check('Cancel keeps the folder and its pages', (await exists(P('f/x'))) && (await exists(P('f/y'))));
  await rightClick(page, 'f:' + P('f'));
  await menuPick(page, 'del');
  await dlgUp(page);
  await page.click('#dlgok');
  check('Delete removes the folder and its pages', (await gone(P('f/x'))) && (await gone(P('f/y'))));
  check('and the open page stays open', (await pname(page)) === P('keep'), await pname(page));

  // ── a published page says so ─────────────────────────────────────────────
  await rightClick(page, 'p:' + P('pub'));
  await menuPick(page, 'del');
  await dlgUp(page);
  msg = await dlgText(page);
  check('a published page\'s modal says it is published', /published/.test(msg), msg);
  await page.click('#dlgcancel');
  await dlgDown(page);

  // ── the Delete key ───────────────────────────────────────────────────────
  check('a tree row takes the keyboard focus', await focusRow(page, 'p:' + P('k')));
  //  moved there by the arrow keys, as a keyboard user gets there
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  check('the arrow keys move the focus, and it is visible', await page.evaluate((k) =>
    document.activeElement.dataset.tk === k
    && getComputedStyle(document.activeElement).outlineStyle !== 'none', 'p:' + P('k')));
  await page.keyboard.press('Delete');
  check('Delete on a focused page asks', await dlgUp(page));
  msg = await dlgText(page);
  check('naming that page', msg.includes(P('k')), msg);
  await page.click('#dlgcancel');
  await dlgDown(page);
  check('Cancel hands the focus back to the row', await page.evaluate((k) =>
    document.activeElement && document.activeElement.dataset.tk === k, 'p:' + P('k')));
  await sleep(1000);
  check('and keeps the page', await exists(P('k')));
  await page.keyboard.press('Delete');
  await dlgUp(page);
  await page.click('#dlgok');
  check('confirmed, the Delete key removes the page', await gone(P('k')));
  await focusRow(page, 'f:' + P('kf'));
  await page.keyboard.press('Delete');
  await dlgUp(page);
  msg = await dlgText(page);
  check('Delete on a focused folder counts its page', /\b1 page\b/.test(msg) && msg.includes('folder'), msg);
  await page.click('#dlgok');
  check('and removes it', await gone(P('kf/z')));

  // ── Enter never deletes ──────────────────────────────────────────────────
  await focusRow(page, 'p:' + P('e'));
  await page.keyboard.press('Delete');
  await dlgUp(page);
  await page.keyboard.press('Enter');
  check('Enter on the modal closes it', await dlgDown(page));
  await sleep(2500);
  check('and the page is still there', await exists(P('e')));
  await rightClick(page, 'p:' + P('e'));
  await menuPick(page, 'del');
  await dlgUp(page);
  await page.keyboard.press('Enter');
  await dlgDown(page);
  await sleep(2500);
  check('Enter on the modal from the menu does not delete either', await exists(P('e')));

  // ── the row's ⋯ button ───────────────────────────────────────────────────
  const moreAt = (pg, tk) => pg.evaluate((k) => {
    const r = [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k);
    const b = r && r.querySelector(':scope > .rmore');
    if (!b) return null;
    r.scrollIntoView({ block: 'center' });
    const q = b.getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2, label: b.getAttribute('aria-label') };
  }, tk);
  let mb = await moreAt(page, 'f:' + P('mf'));
  check('a folder row has a ⋯ button, labelled for it', !!mb && mb.label === 'More actions for folder mf',
    JSON.stringify(mb));
  check('every page and folder row has one', await page.evaluate(() =>
    [...document.querySelectorAll('#treelist [role=treeitem]')]
      .filter((r) => /^[pf]:/.test(r.dataset.tk)).every((r) => !!r.querySelector(':scope > .rmore'))));
  const faint = await page.evaluate(() => {
    const b = document.querySelector('#treelist [role=treeitem] > .rmore');
    return +getComputedStyle(b).opacity;
  });
  check('it is hidden until hover or focus on desktop', faint === 0, String(faint));
  // a click on the row away from the button still opens the page
  const clickAt = await rowAt(page, 'p:' + P('click'));
  check('the button is not under the row\'s text', await page.evaluate(({ x, y }) =>
    !document.elementFromPoint(x, y).closest('.rmore'), clickAt));
  await page.mouse.click(clickAt.x, clickAt.y);
  check('a normal click on the row still opens it', await until(page, (n) =>
    document.getElementById('pname').value === n, P('click'), 30000), await pname(page));
  check('and opens no menu', await page.evaluate(() => !document.querySelector('.treemenu')));
  mb = await moreAt(page, 'f:' + P('mf'));
  await page.mouse.move(mb.x, mb.y);
  check('hovering the row shows it', await page.evaluate((k) => +getComputedStyle(
    [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k)
      .querySelector(':scope > .rmore')).opacity > 0, 'f:' + P('mf')));
  await page.mouse.click(mb.x, mb.y);
  check('⋯ opens the row\'s menu', await until(page, () => !!document.querySelector('.treemenu'), null, 5000));
  check('the folder menu: New page here, Rename / move, Delete', await page.evaluate(() =>
    [...document.querySelectorAll('.treemenu [data-mi]')].map((b) => b.dataset.mi).join() === 'new,mv,del'));
  check('anchored to the button', await page.evaluate(({ x, y }) => {
    const r = document.querySelector('.treemenu').getBoundingClientRect();
    return Math.abs(r.right - x) < 30 && r.top >= y - 2 && r.top - y < 30;
  }, mb));
  check('and the folder stays unopened', (await pname(page)) === P('click'), await pname(page));
  await menuPick(page, 'del');
  await dlgUp(page);
  msg = await dlgText(page);
  check('⋯ > Delete asks, naming the folder and its 2 pages, permanent',
    msg.includes('folder ' + P('mf')) && /\b2 pages\b/.test(msg) && /permanent/.test(msg), msg);
  check('with Cancel focused', await page.evaluate(() => document.activeElement.id === 'dlgcancel'));
  await page.click('#dlgok');
  check('and removes the folder', (await gone(P('mf/a'))) && (await gone(P('mf/b'))));
  check('the open page stays open', (await pname(page)) === P('click'), await pname(page));

  // ── deleting the open page ───────────────────────────────────────────────
  await page.goto(env.app + '?name=' + encodeURIComponent(P('open')), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await until(page, () => document.getElementById('src').value.includes('# open'), null, 90000);
  await until(page, (k) => [...document.querySelectorAll('#treelist [role=treeitem]')]
    .some((r) => r.dataset.tk === k), 'p:' + P('open'), 60000);
  //  typed, not yet saved: the delete must not leave an autosave behind
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value = '# open\nunsaved\n';
    s.dispatchEvent(new Event('input'));
  });
  await rightClick(page, 'p:' + P('open'));
  await menuPick(page, 'del');
  await dlgUp(page);
  msg = await dlgText(page);
  check('the open page\'s modal warns of its unsaved changes', /unsaved/.test(msg), msg);
  await page.click('#dlgok');
  check('the open page is deleted', await gone(P('open')));
  const blank = await until(page, () => document.getElementById('pname').value === ''
    && document.getElementById('src').value === '', null, 10000);
  check('and leaves a clean new page', blank, JSON.stringify(await page.evaluate(() =>
    ({ name: document.getElementById('pname').value, src: document.getElementById('src').value.slice(0, 40) }))));
  check('with no dialog up', await page.evaluate(() => document.getElementById('dlg').hidden));
  await sleep(5000);
  check('and nothing saves it back', !(await exists(P('open'))));
  check('no uncaught errors on desktop', errors.length === 0, errors.join(' | '));
  await page.close();

  // ── phone: a long press opens the menu, a tap still opens the row ────────
  const m = await openPage(browser, env, { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
    onPageError: (e) => errors.push(String(e)) });
  await noNative(m);
  await m.goto(env.app + '?name=' + encodeURIComponent(P('keep')), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await until(m, () => document.getElementById('src').value.includes('# keep'), null, 90000);
  await m.evaluate(() => document.getElementById('ws').classList.remove('ldraw', 'rdraw'));
  await m.tap('#treet');
  await sleep(500);
  await until(m, (k) => [...document.querySelectorAll('#treelist [role=treeitem]')]
    .some((r) => r.dataset.tk === k), 'p:' + P('ph'), 60000);
  //  the drawer open, and settled: a page's late render can still shut it
  //  (applyPage closes the drawers), which is not what is tested here
  const drawer = async () => {
    await sleep(1500);
    if (!(await m.evaluate(() => document.getElementById('ws').classList.contains('ldraw')))) {
      await m.tap('#treet');
      await sleep(600);
    }
  };
  await drawer();
  const cdp = await m.target().createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  // a finger that moves is a scroll: no menu
  let at = await rowAt(m, 'p:' + P('ph'));
  await touch('touchStart', [{ x: at.x, y: at.y }]);
  for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: at.x, y: at.y - i * 10 }]); await sleep(30); }
  await sleep(700);
  await touch('touchEnd', []);
  await sleep(300);
  check('phone: a moving finger opens no menu', await m.evaluate(() => !document.querySelector('.treemenu')));
  // held still: the menu, and the row does not open
  await drawer();
  at = await rowAt(m, 'p:' + P('ph'));
  await sleep(400);         // the scroll into view settles first
  await touch('touchStart', [{ x: at.x, y: at.y }]);
  await sleep(800);
  await touch('touchEnd', []);
  check('phone: a long press opens the row\'s menu', await until(m, () => !!document.querySelector('.treemenu'), null, 3000), JSON.stringify({ at, ws: await m.evaluate(() => document.getElementById('ws').className) }));
  await sleep(500);
  check('phone: and does not open the row', (await pname(m)) === P('keep'), await pname(m));
  await m.tap('.treemenu [data-mi="del"]');
  check('phone: Delete there asks in the modal', await dlgUp(m));
  msg = await dlgText(m);
  check('phone: naming the page', msg.includes(P('ph')), msg);
  await m.tap('#dlgcancel');
  await dlgDown(m);
  await sleep(1000);
  check('phone: Cancel keeps it', await exists(P('ph')));
  // a tap still opens the row
  await drawer();
  at = await rowAt(m, 'p:' + P('ph'));
  if (at) await m.touchscreen.tap(at.x, at.y);
  check('phone: a tap still opens the row', await until(m, (n) =>
    document.getElementById('pname').value === n, P('ph'), 30000), await pname(m));
  // the ⋯ on a phone: always shown, and it deletes a folder
  await m.evaluate(() => document.getElementById('ws').classList.remove('ldraw', 'rdraw'));
  await sleep(500);
  await m.tap('#treet');
  await sleep(600);
  const pm = await m.evaluate((k) => {
    const r = [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k);
    const b = r && r.querySelector(':scope > .rmore');
    if (!b) return null;
    r.scrollIntoView({ block: 'center' });
    const q = b.getBoundingClientRect();
    return { x: q.left + q.width / 2, y: q.top + q.height / 2, op: +getComputedStyle(b).opacity, w: q.width };
  }, 'f:' + P('pf'));
  check('phone: the ⋯ shows without hover, a finger wide', !!pm && pm.op > 0 && pm.w >= 24, JSON.stringify(pm));
  await sleep(400);
  if (pm) await m.touchscreen.tap(pm.x, pm.y);
  check('phone: a tap on ⋯ opens the menu', await until(m, () => !!document.querySelector('.treemenu'), null, 5000));
  await m.tap('.treemenu [data-mi="del"]');
  check('phone: Delete asks', await dlgUp(m));
  msg = await dlgText(m);
  check('phone: naming the folder and its 2 pages', msg.includes('folder ' + P('pf')) && /\b2 pages\b/.test(msg), msg);
  await m.tap('#dlgok');
  check('phone: and the folder goes', (await gone(P('pf/a'))) && (await gone(P('pf/b'))));
  check('no uncaught errors on the phone', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('suite ran to the end', false, e.stack || String(e));
} finally {
  await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' }).catch(() => {});
  await browser.close();
}
check.done();
