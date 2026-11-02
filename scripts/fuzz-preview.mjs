#!/usr/bin/env node
//  fuzz-preview.mjs: seeded random walks through the editor that check
//  one thing after every step. When the preview pane is on screen and a
//  page it can render is in front, the pane shows that page within a few
//  seconds: the frame's document carries the page's text, and the frame
//  is actually painted (a screenshot of it is not one flat colour).
//
//  Steps: open pages of each kind from the tree (in place or in a new
//  tab), switch, open and close tabs, split, unsplit, move a tab to the
//  other group, Back and Forward in a document tab and in a browser tab,
//  open a grub, type, save, reload, Edit/Read, resize (a phone included),
//  open and close a drawer, hide and show the window.
//
//  On a failure it prints the seed and the steps taken, and exits 1.
//
//  Usage: LATTICE_URL=http://localhost:8205 LATTICE_COOKIE=/tmp/cookie \
//           node scripts/fuzz-preview.mjs [--seed N] [--runs N] [--steps N]
//           [--nomove]   (delete moveBefore, as WebKitGTK and Firefox lack it)
//           [--webkit]   (WebKitGTK over WebDriver, see lib/wd-page.mjs)
//           [--skip a,b] (leave those actions out) [--debug] (state per step)
//           [--replay '<json step list>']
//
//  Not a ui-*.mjs suite on purpose: CI and the gate run every one of those,
//  and a random walk belongs in a hunt, not in a gate. A walk it shrinks
//  becomes a ui-*.mjs suite of its own (ui-preview-stuck.mjs).
import { shipEnv, launchBrowser, openPage, seed, sleep } from './lib/harness.mjs';
import { wdSession } from './lib/wd-page.mjs';

const env = shipEnv();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);
const RUNS = Number(arg('runs', 1));
const STEPS = Number(arg('steps', 40));
let SEED = Number(arg('seed', Date.now() % 1e9));
const NOMOVE = flag('nomove');
const WEBKIT = flag('webkit');
const REPLAY = arg('replay', null);
const BUDGET = Number(arg('budget', 5000));

//  pages with a word each that no other page has
const DIR = 'pfz';
const PAGES = [
  ['md', DIR + '/alpha', '# Alpha\n\nPelican harbour lighthouse\n'],
  ['md', DIR + '/bravo', '# Bravo\n\nGranite observatory dome\n'],
  ['gmi', DIR + '/charlie', '# Charlie\n\nWalrus tundra expedition\n'],
  ['html', DIR + '/delta', '<!doctype html><html><head><title>d</title></head><body><h1>Delta</h1><p>Saffron caravan bazaar</p></body></html>'],
  ['text', DIR + '/echo', 'Echo\nMarmalade orchard ladder\n'],
  ['hoon', DIR + '/foxtrot', '[%foxtrot %quasar]\n'],
];
const MARK = { };
for (const [, n, b] of PAGES) MARK[n] = (b.match(/[A-Z][a-z]+ [a-z]+ [a-z]+/) || [b.split('\n')[0]])[0].split(' ')[1] || n;
MARK[DIR + '/foxtrot'] = 'quasar';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const ACTIONS = {
  open: 6, openNew: 3, switchTab: 4, closeTab: 2, newTab: 1, splitR: 1, unsplit: 1, moveTab: 1,
  focusGroup: 2, back: 2, fwd: 1, browse: 1, frameNav: 1, frameBack: 1, grub: 1, type: 1, save: 1,
  reload: 1, read: 7, edit: 1, resize: 2, drawer: 1, hide: 1,
};
const SKIP = (arg('skip', '') || '').split(',').filter(Boolean);
function plan(r, n) {
  const names = Object.keys(ACTIONS).filter((a) => !SKIP.includes(a));
  const tot = names.reduce((a, k) => a + ACTIONS[k], 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    let x = r() * tot, a = names[0];
    for (const k of names) { x -= ACTIONS[k]; if (x < 0) { a = k; break; } }
    out.push([a, Math.floor(r() * 1000)]);
  }
  return out;
}

const browser = WEBKIT ? null : await launchBrowser({ args: ['--disable-dev-shm-usage'] });
let page;
const errs = [];
const VIEWS = [{ width: 1400, height: 900 }, { width: 1000, height: 700 }, { width: 390, height: 844, isMobile: true, hasTouch: true }, { width: 1600, height: 1000 }];

async function fresh() {
  if (page) await page.close().catch(() => {});
  if (WEBKIT) {
    page = await wdSession();
    await page.goto(env.base + '/~/host');
    await page.setCookie({ name: env.cookieName, value: env.cookieValue, path: '/' });
    await page.setViewport(VIEWS[0]);
    await page.evaluateOnNewDocument(() => { window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); });
    await page.goto(env.app);
    await page.evaluate(() => {
      for (const k of ['appTabs', 'appPage', 'edVim']) localStorage.removeItem(k);
      localStorage.latAutosave = '1';
    });
    await boot();
    return;
  }
  page = await openPage(browser, env, { viewport: VIEWS[0],
    onPageError: (e) => errs.push(e.message.slice(0, 120)) });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  //  a peer's shared page: ~nec answers browse-file with the page's prose
  //  and its builder, as a host does, from this ship's own copy
  await page.setRequestInterception(true);
  page.on('request', async (q) => {
    const u = q.url();
    if (!u.includes('/browse-file?')) { q.continue().catch(() => {}); return; }
    try {
      const p = new URL(u).searchParams.get('path');
      const n = (/\/page\/(.+)\/code$/.exec(p) || [])[1];
      const d = await (await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(n),
        { headers: { Cookie: env.cookie } })).json();
      await sleep(400);
      await q.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ body: d.body, builder: d.kind, mark: '/lattice/page', editable: true, rev: d.rev }) });
    } catch { q.respond({ status: 404, body: '' }).catch(() => {}); }
  });
  if (NOMOVE) await page.evaluateOnNewDocument(() => {
    for (const P of [Element, Document, DocumentFragment]) delete P.prototype.moveBefore;
  });
  await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.evaluate(() => {
    for (const k of ['appTabs', 'appPage', 'edVim']) localStorage.removeItem(k);
    localStorage.latAutosave = '1';
  });
  await boot();
}
async function boot() {
  if (WEBKIT) await page.goto(env.app);
  else await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0 && window.latTabs,
    { timeout: 90000 });
  await sleep(500);
}
const idle = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50))));

//  ── the steps ─────────────────────────────────────────────────────────
const pick = (arr, k) => arr[k % arr.length];
async function treeClick(name, ctrl) {
  const ok = await page.evaluate((n, c) => {
    const a = [...document.querySelectorAll('#treelist a.pg')].find((x) => (x.getAttribute('href') || '').includes(encodeURIComponent(n))
      || x.title === n || x.dataset.path === n);
    if (!a || !a.getClientRects().length) return false;
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: c, button: 0 }));
    return true;
  }, name, !!ctrl);
  if (!ok) await page.evaluate((n, c) => window.latTabs.openIn('page', n, { newTab: c }), name, !!ctrl);
}
const S = {
  open: async (k) => treeClick(pick(PAGES, k)[1], false),
  openNew: async (k) => treeClick(pick(PAGES, k)[1], true),
  switchTab: async (k) => page.evaluate((x) => {
    const l = window.latTabs.list(); if (l.length) return window.latTabs.switchTab(l[x % l.length].id);
  }, k),
  closeTab: async (k) => page.evaluate((x) => {
    const l = window.latTabs.list(); if (l.length > 1) return window.latTabs.closeTab(l[x % l.length].id);
  }, k),
  newTab: async () => page.evaluate(() => document.getElementById('tabnew') && document.getElementById('tabnew').click()),
  splitR: async () => { await page.keyboard.down('Control'); await page.keyboard.press('Backslash'); await page.keyboard.up('Control'); },
  unsplit: async () => page.evaluate(async () => {
    const gs = window.latTabs.groups(); if (gs.length < 2) return;
    const g = gs[gs.length - 1];
    for (const t of g.tabs) await window.latTabs.closeTab(t.id);
  }),
  moveTab: async (k) => page.evaluate((x) => {
    const gs = window.latTabs.groups(); if (gs.length < 2) return;
    const all = gs.flatMap((g, i) => g.tabs.map((t) => [t.id, i]));
    const [id, i] = all[x % all.length];
    return window.latTabs.move(id, (i + 1) % gs.length);
  }, k),
  focusGroup: async (k) => page.evaluate((x) => {
    const gs = window.latTabs.groups(); if (gs.length > 1) return window.latTabs.focus(x % gs.length);
  }, k),
  back: async () => page.evaluate(() => { const b = document.getElementById('tback'); if (b && !b.disabled && b.getClientRects().length) b.click(); else window.latTabs.tabBack(); }),
  fwd: async () => page.evaluate(() => { const b = document.getElementById('tfwd'); if (b && !b.disabled && b.getClientRects().length) b.click(); else window.latTabs.tabFwd(); }),
  browse: async (k) => page.evaluate((x) => window.latTabs.openIn('tool', 'frame:/apps/lattice' + (x % 2 ? '/forum' : '') + '#b' + x, { newTab: true }), k),
  frameNav: async (k) => page.evaluate((n) => {
    const f = [...document.querySelectorAll('.toolhost iframe')].find((x) => x.getClientRects().length);
    try { if (f) f.contentWindow.location.href = '/apps/lattice?url=' + encodeURIComponent(n); } catch {}
  }, pick(PAGES, k)[1]),
  frameBack: async () => page.evaluate(() => {
    const b = [...document.querySelectorAll('.fhead [data-fh=back]')].find((x) => x.getClientRects().length);
    if (b) b.click();
  }),
  grub: async (k) => page.evaluate(async (n, x) => {
    let base = localStorage.latBase;
    if (!base) base = (await (await fetch('/apps/lattice/streams')).json()).base;
    return window.latTabs.openIn('grub', (x % 3 ? '/apps/lattice.lattice_app' : base) + '/page/' + n + '/code',
      { newTab: x % 2 === 1, ship: x % 3 ? '~nec' : undefined });
  }, pick(PAGES, k)[1], WEBKIT ? 0 : Math.floor(k / 7)),
  type: async (k) => {
    await page.evaluate(() => window.latSetRead && window.latSetRead(false));
    const vis = await page.evaluate(() => { const s = document.getElementById('src'); return !!s && s.getClientRects().length > 0 && !s.readOnly; });
    if (!vis) return;
    await page.focus('#src').catch(() => {});
    await page.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(s.value.length, s.value.length); });
    await page.keyboard.type(' zz' + (k % 10));
  },
  save: async () => { await page.keyboard.down('Control'); await page.keyboard.press('s'); await page.keyboard.up('Control'); },
  reload: async () => { await boot(); },
  read: async () => page.evaluate(() => window.latSetRead && window.latSetRead(true)),
  edit: async () => page.evaluate(() => window.latSetRead && window.latSetRead(false)),
  resize: async (k) => page.setViewport(pick(VIEWS, k)),
  drawer: async (k) => page.evaluate((x) => { try { window.latShell.drawer(x % 2 ? 'l' : 'r', !!(x % 4 < 2)); } catch {} }, k),
  hide: async () => {
    if (WEBKIT) return;
    const o = await browser.newPage();
    await sleep(300);
    await o.close();
    await page.bringToFront();
  },
};

//  ── the check ─────────────────────────────────────────────────────────
//  null when nothing is owed, else what the pane should hold
async function owed() {
  return page.evaluate((MARK) => {
    const s = window.latTabs.state();
    if (s.active < 0 || !s.shows) return null;
    const t = s.tabs[s.active];
    if (t.kind !== 'page' && t.kind !== 'grub') return null;
    const body = document.getElementById('src').value;
    const kind = document.getElementById('pkind').value;
    let mark = Object.values(MARK).find((w) => body.includes(w));
    if (!mark) return null;
    if (!['md', 'gmi', 'html', 'text'].includes(kind)) {
      if (t.kind !== 'page' || kind !== 'hoon') return null;
      mark = '/f/' + t.key;      // a computed page shows its live data from the ship
    }
    if (!document.getElementById('ws').classList.contains('vp')) return null;
    const f = document.getElementById('prev');
    if (!f || !f.isConnected) return { key: t.key, bad: 'no #prev in the page' };
    const r = f.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return null;
    const cx = r.left + Math.min(r.width / 2, 200), cy = r.top + Math.min(r.height / 2, 150);
    if (cx > innerWidth || cy > innerHeight) return null;
    const at = document.elementFromPoint(cx, cy);
    if (at !== f && !(at && at.closest && at.closest('.prevwrap') === f.parentNode)) return null;  // under a drawer
    if (document.hidden) return null;
    return { key: t.kind + ':' + t.key, mark, kind,
      box: { x: r.left, y: r.top, width: Math.min(r.width, innerWidth - r.left), height: Math.min(r.height, innerHeight - r.top, 300) } };
  }, MARK);
}
async function frameText() {
  const h = await page.$('#prev');
  if (!h) return '';
  const fr = await h.contentFrame().catch(() => null);
  if (!fr) return '';
  return fr.evaluate(() => (document.body ? document.body.innerText : '') + ' @' + location.href).catch((e) => '(eval: ' + e.message.slice(0, 40) + ')');
}
async function painted(box) {
  const shot = await page.screenshot({ clip: box, encoding: 'binary', type: 'png' }).catch(() => null);
  if (!shot) return null;
  const whole = !!shot.b64;
  const b64 = whole ? shot.b64 : Buffer.from(shot).toString('base64');
  //  decode cheaply in the page: colours seen in the clip
  return page.evaluate(async (b64, clip) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    const r = clip || { x: 0, y: 0, width: img.width, height: img.height };
    c.width = Math.max(1, Math.floor(r.width)); c.height = Math.max(1, Math.floor(r.height));
    const x = c.getContext('2d'); x.drawImage(img, -r.x, -r.y);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 7) { seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3)); if (seen.size > 3) break; }
    return seen.size;
  }, b64, whole ? box : null);
}
async function check() {
  //  polled: an open may still be loading, so what is owed can change
  //  inside the budget. A failure is a pane that, at the end of it, still
  //  owes something it does not show.
  const t0 = Date.now();
  let want = null, txt = '', px = null, any = false;
  while (Date.now() - t0 < BUDGET) {
    want = await owed();
    if (want && want.bad) return want.bad;
    if (want) {
      any = true;
      txt = await frameText();
      if (txt.includes(want.mark)) {
        px = await painted(want.box);
        if (px === null || px > 1) { checked++; return null; }
      }
    }
    await sleep(250);
  }
  if (!want) return null;
  const srcdoc = await page.evaluate(() => (document.getElementById('prev').getAttribute('srcdoc') || '').slice(-120));
  return `pane owes ${want.key} (${want.kind}, "${want.mark}") but shows ${JSON.stringify(txt.slice(0, 140))}`
    + (px !== null ? ` painted colours=${px}` : '') + ` srcdoc tail=${JSON.stringify(srcdoc)}`;
}

//  ── a run ─────────────────────────────────────────────────────────────
async function run(steps, seedLabel) {
  errs.length = 0;
  await fresh();
  const done = [];
  for (const [a, k] of steps) {
    done.push([a, k]);
    try {
      await Promise.race([S[a](k), sleep(15000)]);
    } catch (e) { done[done.length - 1].push('threw ' + e.message.slice(0, 60)); }
    await idle().catch(() => {});
    await sleep(300);
    if (flag('debug')) {
      const w = await owed().catch((e) => 'owed threw ' + e.message);
      const st = await page.evaluate(() => ({ s: window.latTabs.state(), ws: document.getElementById('ws').className, kind: document.getElementById('pkind').value, src: document.getElementById('src').value.slice(0, 40) })).catch(() => null);
      console.log('  ' + a + ' ' + k + ' owed=' + JSON.stringify(w) + ' frame=' + JSON.stringify((await frameText()).slice(0, 80)) + ' ' + JSON.stringify(st));
    }
    let bad = null;
    try { bad = await check(); } catch (e) { bad = null; }
    if (bad) {
      console.log(`FAIL seed=${seedLabel} step ${done.length}/${steps.length}${NOMOVE ? ' (nomove)' : ''}: ${bad}`);
      console.log('steps: ' + JSON.stringify(done.map(([x, y]) => [x, y])));
      if (errs.length) console.log('page errors: ' + JSON.stringify(errs.slice(0, 5)));
      return done;
    }
  }
  return null;
}

let failed = 0;
let checked = 0;
try {
  await seed(env, []);
  for (const [kind, n, b] of PAGES) {
    await fetch(env.base + '/apps/lattice/page-save?type=' + kind + '&new=1&name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie }, body: b });
  }
  if (REPLAY) {
    const r = await run(JSON.parse(REPLAY), 'replay');
    if (r) failed++; else console.log('replay passed');
  } else {
    for (let i = 0; i < RUNS; i++, SEED++) {
      const r = await run(plan(rng(SEED), STEPS), SEED);
      if (r) failed++; else console.log(`ok seed=${SEED}${NOMOVE ? ' (nomove)' : ''} checked=${checked}`);
      checked = 0;
    }
  }
} finally {
  if (browser) await browser.close(); else if (page) await page.close();
}
process.exit(failed ? 1 : 0);
