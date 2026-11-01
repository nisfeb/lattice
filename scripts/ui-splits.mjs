#!/usr/bin/env node
//  ui-splits.mjs: tab groups side by side (28-splits.js), and every save
//  guarantee of the tabs holding with more than one live group.
//
//    S1  Ctrl+\ splits right and Ctrl+Shift+\ splits down, each new group
//        in front with a new page, laid out beside or below
//    S2  a split that would leave a group under its least size is refused:
//        the button is disabled and its tooltip says why, the key does nothing
//    S3  a tab dragged to another group's strip moves there, and one dropped
//        on a group's edge splits it; closing a group's last tab closes it
//    S4  one tab per document across groups: opening a document open in
//        another group focuses that tab and group
//    S5  two documents typed into in two groups are both saved, nothing lost
//    S6  switching tabs inside each group while autosaves are held in flight
//    S7  autosave off with two groups dirty: nothing is written, the unsaved
//        work is counted, and Ctrl+S in each group saves it
//    S8  a reload restores the groups, their tabs and fronts, and the tree
//    S9  a corrupt layout falls back to one group
//    S10 vim and list editing work in the second group
//    S11 a read-only link is locked in its group and only there
//    S12 a phone shows one group, splits nothing, and its tabs sheet switches
//        groups
//    S13 the live editor moves between groups with moveBefore, keeping the
//        preview frame's page, and the same without moveBefore (Firefox,
//        Safari, WebKitGTK), where the frame is made again
//
//  Slow writes are made by holding requests in the browser (request
//  interception), so the races are deterministic. Everything seeded is under
//  one run folder and deleted.
//
//  Usage: LATTICE_URL=http://localhost:8135 LATTICE_COOKIE=/tmp/mun-cookie.txt \
//           node scripts/ui-splits.mjs        (ONLY=S1,S5 runs just those)
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'sp-' + process.pid;
const [A, B, C, D, E, F, L] = ['a', 'b', 'c', 'd', 'e', 'f', 'lnk'].map((x) => RUN + '/' + x);

const check = makeCheck();
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
page.on('dialog', (d) => d.accept().catch(() => {}));

//  rule(req): a number holds the request that many ms; 'dump' rewrites a
//  page dump so L reads as a read-only link. seen collects page saves.
let rule = null;
let linkL = false;
const seen = [];
const saves = [];       // every page save sent: its address and body
await page.setRequestInterception(true);
page.on('request', async (r) => {
  const u = r.url();
  if (/\/page-save\?/.test(u) || /\/know-save\?/.test(u)) {
    seen.push(u);
    saves.push({ u, b: r.postData() || '' });
  }
  if (linkL && /\/page-dump/.test(u)) {
    try {
      const res = await fetch(u, { headers: { Cookie: env.cookie } });
      const d = await res.json();
      for (const n of d.nodes || []) if (n.page && n.path === L) n.link = { host: '~zod', mode: 'read' };
      await r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
    } catch { r.continue().catch(() => {}); }
    return;
  }
  const act = rule ? rule(r) : null;
  if (typeof act === 'number') setTimeout(() => r.continue().catch(() => {}), act);
  else r.continue().catch(() => {});
});

const shipGet = async (path) => {
  const r = await fetch(env.base + '/apps/lattice/' + path, { headers: { Cookie: env.cookie } });
  return r.ok ? r.json() : null;
};
const body = async (name) => ((await shipGet('page-source?name=' + encodeURIComponent(name))) || {}).body || '';
const until = async (fn, arg, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(250);
  }
  return false;
};
const shipHas = async (name, text, ms = 30000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    if ((await body(name)).includes(text)) return true;
    await sleep(1000);
  }
  return false;
};
const boot = async (url = env.app) => {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(800);
};
const fresh = async () => {
  await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.evaluate(() => {
    for (const k of ['appTabs', 'appPage', 'edVim']) localStorage.removeItem(k);
    localStorage.latAutosave = '1';
  });
  await boot();
};
const groups = () => page.evaluate(() => window.latTabs.groups());
const gi = async () => (await groups()).findIndex((g) => g.focus);
//  the group in front shows `key` live and writable (or locked, `ro`)
const waitFront = async (kind, key, ro = false) => {
  try {
    await page.waitForFunction((k, y, r) => {
      const s = window.latTabs && window.latTabs.state();
      return !!s && s.active >= 0 && s.tabs[s.active].kind === k && s.tabs[s.active].key === y && s.shows
        && document.getElementById('src').readOnly === r;
    }, { timeout: 30000 }, kind, key, ro);
    return true;
  } catch { return false; }
};
const openHere = (key, newTab = false) =>
  page.evaluate((k, n) => window.latTabs.openIn('page', k, { newTab: n }), key, newTab);
const focusG = (i) => page.evaluate((x) => window.latTabs.focus(x), i);
const typeEnd = async (text) => {
  await page.focus('#src');
  await page.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(s.value.length, s.value.length); });
  await page.keyboard.type(text);
};
const key = async (k, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(k);
  for (const m of mods.reverse()) await page.keyboard.up(m);
};
//  a click into group i's parked text, where a user would click
const clickGhost = async (i) => {
  const r = await page.evaluate((x) => {
    const g = document.querySelectorAll('.tgroup')[x];
    const ta = g && g.querySelector('.gghost:not([hidden]) .esrc');
    if (!ta) return null;
    const b = ta.getBoundingClientRect();
    return { x: b.left + 40, y: b.top + 20 };
  }, i);
  if (!r) return false;
  await page.mouse.click(r.x, r.y);
  return true;
};
const rects = () => page.evaluate(() => [...document.querySelectorAll('.tgroup')]
  .map((g) => { const r = g.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, id: g.dataset.g }; }));
//  a tab dragged by real drag events: to group `to`'s strip, or to a spot
//  in it given as fractions of its body
const drag = (id, to, where) => page.evaluate((tid, gid, w) => {
  const src = document.querySelector('.dtw[data-id="' + tid + '"]');
  const g = document.querySelector('.tgroup[data-g="' + gid + '"]');
  if (!src || !g) return false;
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const s = g.querySelector('.doctabs').getBoundingClientRect();
  const r = g.getBoundingClientRect();
  const at = w === 'strip' ? { clientX: s.right - 90, clientY: s.top + s.height / 2 }
    : { clientX: r.left + r.width * w[0], clientY: s.bottom + (r.bottom - s.bottom) * w[1] };
  const tgt = document.elementFromPoint(at.clientX, at.clientY) || g;
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, ...at };
  tgt.dispatchEvent(new DragEvent('dragover', o));
  tgt.dispatchEvent(new DragEvent('drop', o));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return true;
}, id, to, where);
const tabId = async (k) => (await groups()).flatMap((g) => g.tabs).find((t) => t.key === k)?.id;
//  two groups: A in front of the left, B of the right, the left in front
const twoGroups = async (left = A, right = B) => {
  await fresh();
  await openHere(left);
  await waitFront('page', left);
  await key('Backslash', ['Control']);
  await until(() => window.latTabs.groups().length === 2);
  await openHere(right);
  await waitFront('page', right);
  await focusG(0);
  return waitFront('page', left);
};

try {
  await seed(env, [[A, 'alpha page\n'], [B, 'beta page\n'], [C, 'gamma page\n'],
    [D, 'delta page\n'], [E, 'epsilon page\n'], [F, 'list page\n'], [L, 'a linked page\n']]);
  await sleep(3000);

  // ── S1: split right and down ─────────────────────────────────────────
  if (on('S1')) {
    await fresh();
    await openHere(A);
    check('S1 page open', await waitFront('page', A));
    check('S1 one group to start', (await groups()).length === 1);
    await key('Backslash', ['Control']);
    const two = await until(() => window.latTabs.groups().length === 2);
    let g = await groups();
    let r = await rects();
    check('S1 Ctrl+\\ splits right: a new group in front with a new page',
      two && g[1].focus && g[1].tabs.length === 1 && g[1].tabs[0].key === '' && g[0].tabs[0].key === A,
      JSON.stringify(g));
    check('S1 the new group is beside the first, sharing the width',
      r.length === 2 && Math.abs(r[0].r - r[1].l) < 3 && Math.abs(r[0].w - r[1].w) < 4 && Math.abs(r[0].t - r[1].t) < 2,
      JSON.stringify(r));
    await openHere(C);
    check('S1 a page opens into the new group', await waitFront('page', C));
    await key('Backslash', ['Control', 'Shift']);
    const three = await until(() => window.latTabs.groups().length === 3);
    g = await groups();
    r = await rects();
    check('S1 Ctrl+Shift+\\ splits down: the new group below, in front',
      three && g[2].focus && Math.abs(r[2].t - r[1].b) < 3 && Math.abs(r[2].l - r[1].l) < 2
      && Math.abs(r[1].h - r[2].h) < 4, JSON.stringify(r));
    const tree = await page.evaluate(() => window.latSplits.tree());
    check('S1 the tree: left | (top / bottom)',
      tree.d === 'r' && tree.k[0] === 0 && tree.k[1].d === 'd', JSON.stringify(tree));
    check('S1 one focus mark, on the group in front',
      await page.evaluate(() => document.querySelectorAll('.tgroup.gfocus').length === 1
        && document.querySelectorAll('.tgroup')[2].classList.contains('gfocus')
        && document.getElementById('doctabs') === document.querySelectorAll('.tgroup')[2].querySelector('.doctabs')));

    // ── S2: the least width ──────────────────────────────────────────
    const btn = await page.evaluate(() => {
      const b = document.querySelector('#doctabs [data-sb="r"]');
      return { dis: b.disabled, title: b.title, why: window.latSplits.why('r') };
    });
    check('S2 a split under the least width is disabled, and its tooltip says why',
      btn.dis && /^Split right \(Ctrl\+\\\): not enough room/.test(btn.title) && /360px/.test(btn.title),
      JSON.stringify(btn));
    await key('Backslash', ['Control']);
    await sleep(800);
    check('S2 Ctrl+\\ there splits nothing', (await groups()).length === 3);
    check('S2 the status says why', await page.evaluate(() =>
      /cannot split: not enough room/.test(document.getElementById('status').textContent)));
    const left = await page.evaluate(() => window.latPalette.applies('splitr'));
    check('S2 the palette does not offer it', left === false);
    const downOk = await page.evaluate(() => {
      const b = document.querySelectorAll('.tgroup')[0].querySelector('[data-sb="d"]');
      return !b.disabled && b.title === 'Split down (Ctrl+Shift+\\)';
    });
    check('S2 a split with room is offered, named with its key', downOk);

    // the bottom group's only tab closes, and the group with it
    const bottom = (await groups())[2];
    await page.evaluate((id) => window.latTabs.closeTab(id), bottom.tabs[0].id);
    await until(() => window.latTabs.groups().length === 2);
    g = await groups();
    r = await rects();
    check('S3 closing a group\'s last tab closes the group, the other takes its room',
      g.length === 2 && Math.abs(r[1].h - r[0].h) < 3, JSON.stringify(r));
  }

  // ── S3: dragging tabs ─────────────────────────────────────────────────
  if (on('S3')) {
    await twoGroups(A, C);
    await openHere(B, true);
    await waitFront('page', B);
    let g = await groups();
    const bid = await tabId(B);
    const ok = await drag(bid, g[1].id, 'strip');
    await until((k) => window.latTabs.groups()[1].tabs.some((t) => t.key === k), B, 10000);
    await sleep(1500);
    g = await groups();
    check('S3 a tab dragged to another strip moves there, in front of its group',
      ok && g[0].tabs.map((t) => t.key).join() === A && g[1].tabs.map((t) => t.key).join() === [C, B].join()
      && g[1].focus && g[1].tabs[g[1].active].key === B, JSON.stringify(g));
    check('S3 and shows live there', await waitFront('page', B));
    // C to the bottom edge of the left group: a new group below it
    const cid = await tabId(C);
    await drag(cid, g[0].id, [0.5, 0.92]);
    await until(() => window.latTabs.groups().length === 3, null, 10000);
    g = await groups();
    const r = await rects();
    const tree = await page.evaluate(() => window.latSplits.tree());
    check('S3 a tab dropped on a group\'s edge splits it, the tab alone in the new half',
      g.length === 3 && g[2].tabs.length === 1 && g[2].tabs[0].key === C && g[2].focus
      && Math.abs(r[2].t - r[0].b) < 3 && tree.k[0].d === 'd', JSON.stringify({ g, tree }));
    check('S3 the dragged tab shows live', await waitFront('page', C));
    // B, the right group's last but one: C's group closes when C is dragged out
    await drag(cid, g[1].id, 'strip');
    await until(() => window.latTabs.groups().length === 2, null, 10000);
    g = await groups();
    check('S3 dragging a group\'s last tab out closes the group',
      g.length === 2 && g[1].tabs.map((t) => t.key).join() === [B, C].join(), JSON.stringify(g));

    // a tab drag whose source went away mid-drag (no dragend reaches us),
    // then a text drag in the editor: the text drag is the editor's
    const before = JSON.stringify(await groups());
    const text = await page.evaluate((id) => {
      const w = document.querySelector('.dtw[data-id="' + id + '"]');
      w.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
      w.remove();
      const s = document.getElementById('src');
      const r = s.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/plain', 'dragged words');
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: r.top + 30 };
      s.dispatchEvent(new DragEvent('dragover', o));
      const drop = new DragEvent('drop', o);
      s.dispatchEvent(drop);
      return drop.defaultPrevented;
    }, await tabId(B));
    await sleep(1200);
    check('S3 a text drag after a lost tab drag is left to the editor, and moves no tab',
      !text && JSON.stringify(await groups()) === before);
  }

  // ── S4: one tab per document across groups ───────────────────────────
  if (on('S4')) {
    await twoGroups(A, B);
    await focusG(1);
    await waitFront('page', B);
    await openHere(A, true);       // open in a new tab, from the right group
    check('S4 opening a document open in another group focuses it there', await waitFront('page', A)
      && (await gi()) === 0);
    let g = await groups();
    const count = g.flatMap((x) => x.tabs).filter((t) => t.key === A).length;
    check('S4 still one tab for it, across every group', count === 1 && g[1].tabs.length === 1,
      JSON.stringify(g));
    await focusG(1);
    await waitFront('page', B);
    await page.evaluate((k) => {
      const a = document.querySelector('#treelist a.pg[href$="name=' + encodeURIComponent(k) + '"]');
      a.click();
    }, A);
    check('S4 a Files click on it does the same', await waitFront('page', A) && (await gi()) === 0);
    g = await groups();
    check('S4 and opens no second tab', g.flatMap((x) => x.tabs).filter((t) => t.key === A).length === 1
      && g[1].tabs.map((t) => t.key).join() === B, JSON.stringify(g));

    // closing a clean tab in the group not in front leaves the front alone
    await focusG(1);
    await waitFront('page', B);
    await openHere(E, true);
    await waitFront('page', E);
    await focusG(0);
    await waitFront('page', A);
    await page.evaluate((id) => window.latTabs.closeTab(id), await tabId(B));
    await sleep(600);
    g = await groups();
    check('S4 closing a background group\'s tab keeps the group in front where it was',
      (await gi()) === 0 && g[1].tabs.map((t) => t.key).join() === E
      && await page.evaluate((k) => window.latTabs.state().tabs[window.latTabs.state().active].key === k, A),
      JSON.stringify(g));
    await page.evaluate((id) => window.latTabs.closeTab(id), await tabId(E));
    await sleep(600);
    g = await groups();
    check('S4 and its last tab closes that group, the front still where it was',
      g.length === 1 && g[0].focus && await waitFront('page', A), JSON.stringify(g));
  }

  // ── S5: two documents typed in two groups ────────────────────────────
  if (on('S5')) {
    await twoGroups(A, B);
    const m1 = ' left-' + RUN, m2 = ' right-' + RUN;
    await typeEnd(m1);
    await clickGhost(1);
    const moved = await waitFront('page', B);
    const ghost = await page.evaluate(() => document.querySelectorAll('.tgroup')[0].querySelector('.gghost .esrc').value);
    check('S5 a click into the other group brings it to the front at once', moved);
    check('S5 the group left behind shows what was typed in it', ghost.includes(m1.trim()), ghost.slice(-60));
    await typeEnd(m2);
    check('S5 the left page is saved', await shipHas(A, m1.trim()));
    check('S5 the right page is saved', await shipHas(B, m2.trim()));
    await until(() => !window.__latUnsaved(), null, 15000);
    const g = await groups();
    check('S5 nothing left unsaved, no dot on either',
      !(await page.evaluate(() => window.__latUnsaved())) && g.every((x) => x.tabs.every((t) => !t.dirty)),
      JSON.stringify(g));
    // back to the left: its text, with what was typed
    await clickGhost(0);
    await waitFront('page', A);
    check('S5 the left page comes back as typed', await page.evaluate((m) =>
      document.getElementById('src').value.includes(m), m1.trim()));
  }

  // ── S6: switching tabs inside each group mid-autosave ────────────────
  if (on('S6')) {
    await twoGroups(A, B);
    await openHere(D, true);
    await waitFront('page', D);
    await focusG(1);
    await waitFront('page', B);
    await openHere(E, true);
    await waitFront('page', E);
    await focusG(0);
    await waitFront('page', D);
    rule = (r) => (/\/page-save\?/.test(r.url()) ? 3500 : null);
    const mk = (n) => ' m' + n + '-' + RUN;
    await page.click('#doctabs .dtab[data-key="' + A + '"]');
    await waitFront('page', A);
    await typeEnd(mk(1));
    await sleep(2300);            // its autosave is on the wire, held
    await page.click('#doctabs .dtab[data-key="' + D + '"]');
    await waitFront('page', D);
    await typeEnd(mk(2));
    await clickGhost(1);          // the other group, D's autosave still to come
    await waitFront('page', E);
    await typeEnd(mk(3));
    await sleep(2300);
    await page.click('#doctabs .dtab[data-key="' + B + '"]');
    await waitFront('page', B);
    await typeEnd(mk(4));
    await clickGhost(0);
    await waitFront('page', D);
    rule = null;
    const got = [];
    for (const [n, k] of [[1, A], [2, D], [3, E], [4, B]]) got.push(await shipHas(k, mk(n).trim(), 40000));
    check('S6 every page typed into, across two groups and mid-flight switches, is saved',
      got.every(Boolean), JSON.stringify(got));
    check('S6 nothing is left unsaved', await until(() => !window.__latUnsaved(), null, 20000));
    const ed = await page.evaluate(() => document.getElementById('src').value);
    check('S6 the page in front kept its text', ed.includes(mk(2).trim()));
  }

  // ── S6b: a group left while its autosave flies saves once ────────────
  if (on('S6')) {
    await twoGroups(A, B);
    rule = (r) => (/\/page-save\?/.test(r.url()) ? 1500 : null);
    const m = ' once-' + RUN;
    saves.length = 0;
    await typeEnd(m);
    await sleep(2200);            // its autosave is on the wire
    await clickGhost(1);
    await waitFront('page', B);
    rule = null;
    await shipHas(A, m.trim());
    await sleep(4000);
    const sent = saves.filter((x) => x.u.includes(encodeURIComponent(A)) && x.b.includes(m.trim()));
    check('S6 a group left mid-autosave writes its text once, not again from the park',
      sent.length === 1, JSON.stringify(sent.map((x) => x.u.slice(-60))));
  }

  // ── S7: autosave off, two groups dirty ───────────────────────────────
  if (on('S7')) {
    await twoGroups(A, B);
    await page.evaluate(() => { localStorage.latAutosave = '0'; });
    seen.length = 0;
    const n1 = ' n1-' + RUN, n2 = ' n2-' + RUN;
    await typeEnd(n1);
    await clickGhost(1);
    await waitFront('page', B);
    await typeEnd(n2);
    await sleep(3500);
    let g = await groups();
    check('S7 autosave off: nothing is written on its own', seen.length === 0, JSON.stringify(seen));
    check('S7 both groups hold unsaved work, both dotted',
      g[0].tabs[0].dirty && g[1].tabs[0].dirty
      && await page.evaluate(() => document.querySelectorAll('.tgroup .dtab.dirty').length === 2), JSON.stringify(g));
    check('S7 the unload guard counts the parked group', await page.evaluate(() => window.__latUnsaved()));
    await key('s', ['Control']);
    check('S7 Ctrl+S saves the right group', await shipHas(B, n2.trim(), 20000));
    check('S7 and the left is still not written', !(await body(A)).includes(n1.trim()));
    await clickGhost(0);
    await waitFront('page', A);
    check('S7 the left group comes back with its unsaved text',
      await page.evaluate((m) => document.getElementById('src').value.includes(m), n1.trim()));
    await key('s', ['Control']);
    check('S7 Ctrl+S saves the left group', await shipHas(A, n1.trim(), 20000));
    check('S7 nothing unsaved after both', await until(() => !window.__latUnsaved(), null, 15000));
    await page.evaluate(() => { localStorage.latAutosave = '1'; });
  }

  // ── S8: reload restores the layout ───────────────────────────────────
  if (on('S8')) {
    await twoGroups(A, B);
    await openHere(C, true);
    await waitFront('page', C);
    await focusG(1);
    await waitFront('page', B);
    await key('Backslash', ['Control', 'Shift']);
    await until(() => window.latTabs.groups().length === 3);
    await openHere(D);
    await waitFront('page', D);
    // a size of its own, by its handle
    const h = await page.evaluate(() => { const r = document.querySelector('.gres.r').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + 25, h.y, { steps: 5 });
    await page.mouse.up();
    const before = { g: await groups(), tree: await page.evaluate(() => window.latSplits.tree()), r: await rects() };
    await sleep(2500);
    await boot(page.url());
    await waitFront('page', D);
    await sleep(1500);
    const after = { g: await groups(), tree: await page.evaluate(() => window.latSplits.tree()), r: await rects() };
    const shape = (x) => JSON.stringify(x.g.map((g) => ({ f: g.focus, a: g.active, k: g.tabs.map((t) => t.key) })));
    check('S8 a reload restores every group, its tabs and its front, and which is in front',
      shape(before) === shape(after), shape(before) + ' / ' + shape(after));
    check('S8 the handle moved the sizes', before.tree.s && before.tree.s[0] > before.tree.s[1],
      JSON.stringify(before.tree));
    check('S8 and the tree with its sizes', JSON.stringify(before.tree) === JSON.stringify(after.tree)
      && Math.abs(before.r[0].w - after.r[0].w) < 2, JSON.stringify([before.tree, after.tree]));
    const ghosts = await page.evaluate(() => [...document.querySelectorAll('.tgroup:not(.gfocus) .gghost .esrc')].map((t) => t.value));
    check('S8 the groups not in front paint their pages', ghosts.length === 2
      && ghosts.some((v) => v.includes('gamma page')) && ghosts.some((v) => v.includes('beta page')),
      JSON.stringify(ghosts.map((v) => v.slice(0, 20))));
    check('S8 no body is stored', !(await page.evaluate(() => localStorage.appTabs)).includes('page\\n'));
  }

  // ── S9: a corrupt layout falls back ──────────────────────────────────
  if (on('S9')) {
    await twoGroups(A, B);
    await sleep(500);
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.appTabs);
      s.tree = { d: 'r', k: [0, 0], s: [1, 1] };      // a group twice, the other never
      localStorage.appTabs = JSON.stringify(s);
    });
    await boot(page.url());
    await sleep(1000);
    let g = await groups();
    check('S9 a tree that does not name each group once: one group with every tab',
      g.length === 1 && [A, B].every((k) => g[0].tabs.some((t) => t.key === k)), JSON.stringify(g));
    await page.evaluate(() => { localStorage.appTabs = JSON.stringify({ v: 2, groups: 'x', tree: 7 }); });
    await boot(env.app);
    await sleep(1000);
    g = await groups();
    check('S9 groups that are not a list: one group', g.length === 1 && g[0].tabs.length === 1, JSON.stringify(g));
    await page.evaluate(() => { localStorage.appTabs = '{'; });
    await boot(env.app);
    await sleep(1000);
    g = await groups();
    check('S9 unparseable: one group, one tab', g.length === 1 && g[0].tabs.length === 1, JSON.stringify(g));
    check('S9 and it still splits', await page.evaluate(async () => {
      await window.latSplits.split('r');
      return window.latTabs.groups().length === 2;
    }));
  }

  // ── S10: vim and list editing in the second group ────────────────────
  if (on('S10')) {
    await twoGroups(A, F);
    await clickGhost(1);
    await waitFront('page', F);
    await typeEnd('- one');
    await key('Enter');
    await page.keyboard.type('two');
    const listed = await page.evaluate(() => document.getElementById('src').value);
    check('S10 list editing continues a list in the second group', /- one\n- two$/.test(listed),
      JSON.stringify(listed.slice(-20)));
    await page.evaluate(() => { localStorage.edVim = '1'; });
    await page.focus('#src');
    await key('Escape');
    await page.keyboard.type('dd');
    const vim = await page.evaluate(() => document.getElementById('src').value);
    check('S10 vim works in the second group (dd deletes the line)', !vim.includes('- two') && vim.includes('- one'),
      JSON.stringify(vim.slice(-20)));
    await page.keyboard.type('i');
    await page.keyboard.type('Z');
    await key('Escape');
    check('S10 and insert mode types', await page.evaluate(() => /Z- one/.test(document.getElementById('src').value)));
    await page.evaluate(() => { localStorage.edVim = '0'; });
    await clickGhost(0);
    await waitFront('page', A);
    check('S10 the second group\'s edits are saved', await shipHas(F, 'Z- one'));
  }

  // ── S11: a read-only link, per group ─────────────────────────────────
  if (on('S11')) {
    linkL = true;
    await twoGroups(A, B);
    await sleep(1500);
    await clickGhost(1);
    await waitFront('page', B);
    await openHere(L);
    check('S11 the read-only link is locked in its group', await waitFront('page', L, true));
    await clickGhost(0);
    check('S11 the other group\'s page is not', await waitFront('page', A, false));
    const gh = await page.evaluate(() => document.querySelectorAll('.tgroup')[1].querySelector('.gghost .esrc').title);
    check('S11 the parked link says it is read-only', gh === 'read-only', gh);
    await clickGhost(1);
    check('S11 back in front, it is locked again', await waitFront('page', L, true));
    await page.keyboard.type('nope');
    check('S11 and takes no typing', !(await page.evaluate(() => document.getElementById('src').value.includes('nope'))));
    linkL = false;
  }

  // ── S12: a phone ─────────────────────────────────────────────────────
  if (on('S12')) {
    await twoGroups(A, B);
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await sleep(1000);
    const vis = await page.evaluate(() => [...document.querySelectorAll('.tgroup')]
      .filter((g) => getComputedStyle(g).display !== 'none').map((g) => g.classList.contains('gfocus')));
    check('S12 a phone shows one group, the one in front', vis.length === 1 && vis[0], JSON.stringify(vis));
    check('S12 and no split', await page.evaluate(() =>
      getComputedStyle(document.querySelector('#doctabs [data-sb="r"]')).display === 'none'
      && !window.latPalette.applies('splitr')));
    const full = await page.evaluate(() => {
      const g = document.querySelector('.tgroup.gfocus').getBoundingClientRect();
      const c = document.getElementById('groot').getBoundingClientRect();
      return Math.abs(g.width - c.width) < 2 && Math.abs(g.height - c.height) < 2;
    });
    check('S12 the group fills the center', full);
    await page.evaluate(() => document.getElementById('mtabsw').click());
    await sleep(400);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#mtsheet .mtgrp button')].map((b) => b.textContent));
    check('S12 the tabs sheet lists the groups', rows.length === 2, JSON.stringify(rows));
    await page.evaluate(() => document.querySelectorAll('#mtsheet .mtgrp button')[1].click());
    check('S12 and switches to one', await waitFront('page', B) && (await gi()) === 1);
    await page.screenshot({ path: '/tmp/splits-phone.png' });
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(800);
  }
  // ── S13: moving the live editor, with and without moveBefore ────────
  //  last, because the second half takes moveBefore out of every document
  //  this page loads from here on
  if (on('S13')) {
    const where = () => page.evaluate(() => {
      const gl = document.getElementById('glive');
      const gs = [...document.querySelectorAll('.tgroup')];
      return { g: gs.indexOf(gl.parentNode), src: document.getElementById('src').value,
        mb: typeof gl.moveBefore === 'function' };
    });
    //  a mark on the preview's window: kept while its page is, gone with it
    const mark = () => page.evaluate(() => { window.__pvw = document.getElementById('prev').contentWindow; });
    const kept = () => page.evaluate(() => document.getElementById('prev').contentWindow === window.__pvw);
    const round = async (tag) => {
      check(tag + ' two groups, A in front of the left', await twoGroups(A, B));
      let w = await where();
      check(tag + ' the live editor is in the left group, showing A',
        w.g === 0 && w.src.includes('alpha page'), JSON.stringify(w));
      await mark();
      await clickGhost(1);
      check(tag + ' a click into the right group brings B to the front', await waitFront('page', B));
      w = await where();
      check(tag + ' the live editor moved to the right group, showing B',
        w.g === 1 && w.src.includes('beta page'), JSON.stringify(w));
      const k = await kept();
      await typeEnd(' moved ' + tag.slice(0, 4));
      check(tag + ' typing there is saved', await shipHas(B, 'moved ' + tag.slice(0, 4)));
      await clickGhost(0);
      check(tag + ' and back to the left', await waitFront('page', A) && (await where()).g === 0);
      return { w, k };
    };
    const nat = await page.evaluate(() => typeof Element.prototype.moveBefore === 'function');
    if (nat) {
      const r = await round('S13a moveBefore');
      check('S13a the engine has moveBefore', r.w.mb);
      check('S13a the move kept the preview\'s page', r.k);
    }
    await page.evaluateOnNewDocument(() => {
      for (const P of [Element, Document, DocumentFragment]) delete P.prototype.moveBefore;
    });
    const r = await round('S13b without moveBefore');
    check('S13b the engine has no moveBefore here', !r.w.mb);
    check('S13b the move made the preview again (insertBefore)', !r.k);
  }
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await browser.close();
  for (const n of [A, B, C, D, E, F, L, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
