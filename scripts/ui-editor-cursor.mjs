#!/usr/bin/env node
//  ui-editor-cursor.mjs: the editor's cursor, its shape under vim and where
//  it is drawn on a long page.
//
//  The editor is a transparent <textarea> (#src, which owns the caret and
//  the text) over a Prism-highlighted <pre> (#hl, the text you see). The
//  caret is drawn where the TEXTAREA puts a character, so wherever the two
//  layers disagree on a glyph's place, a typed character lands somewhere
//  other than the text the caret looks to be in. Two causes are covered:
//
//    - the overlay's text lagging the textarea's. Past 60 KB the highlight
//      waits for 120 ms of quiet, so while a long page was typed into the
//      overlay showed the text from before the burst: characters late, lines
//      under an Enter on their old rows, and its scrollTop clamped short of
//      the textarea's. hlSplice (25-editor.js) now writes every edit into it.
//    - token styles that change the face. Bold and italic faces are wider in
//      proportional fonts (the System and Serif typography choices) and in
//      WebKit's synthetic bold, so each heading and **bold** run pushed its
//      line, and moved soft wraps, away from the textarea's.
//
//  The drift check measures the REAL caret: the overlay's text is made
//  transparent, the caret painted red, and the screenshot's red column is
//  compared with the overlay's box for the character at the caret, the box
//  a typed character fills. On a 2,000 line page with headings, code with
//  tabs, wrapped lines, emoji and CJK; near its end, after scrolling, after
//  a webfont load, after a burst of typing; at several widths, zooms (device pixel ratios) and
//  fonts, wrapped and not, vim on and off. Then the vim cursor: a block in
//  normal, visual and pending, an underline for r, the bar in insert, the
//  theme's colours, redrawn at once on every mode change.
//
//  Chrome through puppeteer, then WebKitGTK (the desktop app's engine)
//  through WebKitWebDriver under xvfb-run when both are installed; set
//  WEBKIT=0 to skip it.
//
//  Usage: LATTICE_URL=http://localhost:8205 LATTICE_COOKIE=/tmp/cookie \
//           node scripts/ui-editor-cursor.mjs
import { spawn, execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'net';
import { shipEnv, makeCheck, launchBrowser, openPage, sleep } from './lib/harness.mjs';
import { wdSession } from './lib/wd-page.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'cur' + (process.pid % 100000);
const LONG = RUN + '/long';

function longDoc(n = 2000) {
  const L = [];
  for (let i = 0; L.length < n; i++) {
    L.push('# Heading number ' + i + ' with **bold** words', '');
    L.push('A long paragraph line ' + i + ' that keeps going so that it soft wraps across the editor width, '.repeat(3)
      + 'with **bold text**, *italic text*, `inline code`, a [link](https://example.com/' + i + ') and an emoji 🎉🚀 plus CJK 漢字かな交じり文 中文字符。');
    L.push('', '```js', '\tfunction f' + i + '(a, b) {', '\t\treturn a + b; // tabbed', '\t}', '```', '');
    L.push('- list item ' + i + ' with __strong__ and ~~strike~~ 👍🏽', '> quote ' + i + ' 日本語の引用', '## Sub heading ' + i + ' **more bold**', '');
  }
  return L.slice(0, n).join('\n');
}
const DOC = longDoc();
//  the places checked, in the page's last 3,000 characters: after bold, an
//  emoji, CJK, tabs, a link, and the very end
const SPOTS = ['bold** words', '🚀', '漢字', '\treturn', 'example.com', 'more bold', ''];
const TOL_X = 2.5;

//  a font file for the webfont check (any TTF fontconfig has)
let FONT = null;
try {
  const f = execFileSync('fc-match', ['-f', '%{file}', 'sans-serif'], { encoding: 'utf8' }).trim();
  if (/\.(ttf|otf)$/i.test(f)) FONT = readFileSync(f).toString('base64');
} catch {}

//  ── in the page ──────────────────────────────────────────────────────────
//  installed into the app's window once per document
const helpers = () => {
  const hl = () => document.getElementById('hl'), src = () => document.getElementById('src');
  const at = (i) => {
    const w = document.createTreeWalker(hl(), NodeFilter.SHOW_TEXT); let n, last = null;
    while ((n = w.nextNode())) { if (i < n.length) return [n, i]; i -= n.length; last = n; }
    return [last, last.length];
  };
  //  the overlay's box for character i (WebKit adds the line end before)
  window.__hlRect = (i) => {
    const r = document.createRange(), a = at(i), b = at(i + 1);
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
    const rs = [...r.getClientRects()];
    const rc = rs.reverse().find((x) => x.width > 0) || rs[0];
    return rc ? { x: rc.left, y: rc.top, w: rc.width, h: rc.height } : null;
  };
  //  the caret at i, its line in the middle of the editor
  window.__place = (i) => {
    const s = src(); s.focus(); s.setSelectionRange(i, i);
    let rc = window.__hlRect(i);
    s.scrollTop += rc.y - s.getBoundingClientRect().top - s.clientHeight / 2;
    if (!document.getElementById('ws').classList.contains('wrap'))
      s.scrollLeft = Math.max(0, s.scrollLeft + rc.x - s.getBoundingClientRect().left - s.clientWidth / 2);
    s.dispatchEvent(new Event('scroll'));
  };
  window.__paintCaret = (on) => {
    let st = document.getElementById('__cst');
    if (!st) { st = document.createElement('style'); st.id = '__cst'; document.head.append(st); }
    st.textContent = on ? '.ehl, .ehl * { color: transparent !important; text-shadow: none !important;'
      + ' text-decoration: none !important; } .esrc { caret-color: rgb(255, 0, 0) !important; }'
      + ' .vimcur { display: none !important; } .esrc::selection { background: transparent; }' : '';
  };
  //  the red caret's box in a viewport screenshot, inside the editor
  window.__findCaret = async (b64) => {
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const k = img.width / innerWidth, e = src().getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(e.left * k)), y0 = Math.max(0, Math.floor(e.top * k));
    const w = Math.min(img.width - x0, Math.ceil(e.width * k)), h = Math.min(img.height - y0, Math.ceil(e.height * k));
    const d = g.getImageData(x0, y0, w, h).data;
    let a = 1e9, b = 1e9, z = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      if (d[q] > 110 && d[q] > 2 * d[q + 1] + 40 && d[q] > 2 * d[q + 2] + 40) { a = Math.min(a, x); z = Math.max(z, x); b = Math.min(b, y); y1 = Math.max(y1, y); }
    }
    return z < 0 ? null : { x: (x0 + a) / k, y: (y0 + b) / k, y1: (y0 + y1 + 1) / k };
  };
  window.__frames = (n = 2) => new Promise((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
};

//  ── one engine ───────────────────────────────────────────────────────────
//  page: puppeteer's, or wd-page's. shot(): a viewport PNG as base64.
async function suite(tag, page, shot, { zooms, widths }) {
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const caretAt = async () => {
    await ev(() => window.__paintCaret(true));
    let c = null;
    //  the caret blinks: a few frames until it shows
    for (let t = 0; t < 15 && !c; t++) {
      c = await ev((b) => window.__findCaret(b), await shot());
      if (!c) await sleep(90);
    }
    await ev(() => window.__paintCaret(false));
    return c;
  };
  //  the drawn caret against the box the character at i fills
  const drift = async (i, what) => {
    await ev((k) => window.__place(k), i);
    await ev(() => window.__frames(2));
    const want = await ev((k) => window.__hlRect(k), i), c = await caretAt();
    //  a caret the screenshots never caught (it blinks) is not counted
    if (!c || !want) return { bad: false, unseen: true, msg: what + ': no caret seen' };
    const dx = c.x - want.x, dy = (c.y + c.y1) / 2 - (want.y + want.h / 2);
    const lh = await ev(() => parseFloat(getComputedStyle(document.getElementById('hl')).lineHeight));
    return { bad: Math.abs(dx) > TOL_X || Math.abs(dy) > lh / 2, msg: `${what}: dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}` };
  };
  const spots = await ev((specs) => {
    const v = document.getElementById('src').value, tail = v.length - 3000;
    return specs.map((s) => [s || 'end', s ? v.indexOf(s, tail) + Math.min(2, s.length) : v.length]);
  }, SPOTS);

  const configs = [];
  for (const width of widths) for (const zoom of zooms) for (const font of ['mono', 'system'])
    for (const wrap of [true, false]) configs.push({ width, zoom, font, wrap, vim: configs.length % 2 === 1 });
  for (const cf of configs) {
    await page.setViewport({ width: cf.width, height: 800 });
    await ev(({ zoom, font, wrap, vim }) => {
      document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom);
      if (font === 'system') document.documentElement.style.setProperty('--ed-font', 'system-ui, sans-serif');
      else document.documentElement.style.removeProperty('--ed-font');
      document.getElementById('ws').classList.toggle('wrap', wrap);
      localStorage.edVim = vim ? '1' : '0';
    }, cf);
    const name = `${tag} ${cf.width}px zoom ${cf.zoom} ${cf.font} ${cf.wrap ? 'wrapped' : 'unwrapped'} vim ${cf.vim ? 'on' : 'off'}`;
    const bad = [];
    let seen = 0;
    for (const [w, i] of spots) { const r = await drift(i, w); if (r.bad) bad.push(r.msg); if (!r.unseen) seen++; }
    check('the caret is drawn where the character at it is shown, near the end of a long page: ' + name,
      !bad.length && seen >= 2, bad.slice(0, 4).join('; ') + ` (${seen} of ${spots.length} carets seen)`);
  }
  await ev(() => { document.documentElement.style.zoom = ''; document.documentElement.style.removeProperty('--ed-font'); });
  await page.setViewport({ width: 1200, height: 800 });

  //  a burst of typing near the end: the overlay holds every character at
  //  once, scrolls with the textarea, and the typed character sits where
  //  the caret was drawn
  await ev(() => document.getElementById('ws').classList.add('wrap'));
  for (const vim of [false, true]) {
    await ev((v) => { localStorage.edVim = v ? '1' : '0'; }, vim);
    const i = spots.find(([w]) => w === '漢字')[1];
    const before = await drift(i, 'before typing');
    const c = await ev((k) => { window.__place(k); return null; }, i);
    void c;
    await sleep(100);
    const caret = await caretAt();
    if (vim) { await page.keyboard.press('Escape'); await page.keyboard.press('i'); }
    await page.keyboard.type('Zq');
    const z = await ev((k) => window.__hlRect(k), i);
    await page.keyboard.type('\nxy\n');
    const now = await ev((k) => {
      const s = document.getElementById('src'), h = document.getElementById('hl');
      return { same: h.textContent === s.value + '\n', top: [h.scrollTop, s.scrollTop], typed: s.value.slice(k, k + 6) };
    }, i);
    now.z = z;
    if (vim) await page.keyboard.press('Escape');
    check(`${tag} a burst of typing shows at once in the overlay (vim ${vim ? 'on' : 'off'})`,
      now.same && now.typed === 'Zq\nxy\n', JSON.stringify(now.typed));
    check(`${tag} and the overlay scrolls with the textarea`, Math.abs(now.top[0] - now.top[1]) < 1, now.top.join(' vs '));
    check(`${tag} the typed character lands where the caret was drawn`,
      !before.bad && caret && now.z && Math.abs(now.z.x - caret.x) <= TOL_X,
      `${before.msg}; caret x ${caret && caret.x.toFixed(1)}, Z at ${now.z && now.z.x.toFixed(1)}`);
    //  put the page back
    await ev((k) => {
      const s = document.getElementById('src');
      s.value = s.value.slice(0, k) + s.value.slice(k + 6);
      s.dispatchEvent(new Event('input'));
    }, i);
  }

  //  a webfont that loads after the page is laid out
  if (FONT) {
    await ev(() => { localStorage.edVim = '1'; });
    await ev((b64) => {
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bin], { type: 'font/ttf' }));
      const st = document.createElement('style');
      st.textContent = `@font-face { font-family: "LatLate"; src: url(${url}); font-display: swap; }`;
      document.head.append(st);
      document.documentElement.style.setProperty('--ed-font', '"LatLate", ui-monospace, monospace');
    }, FONT);
    const i = spots.find(([w]) => w === '🚀')[1];
    await ev((k) => window.__place(k), i);
    await page.keyboard.press('Escape');
    await ev(() => document.fonts.ready);
    await sleep(300);
    const r = await drift(i, 'after the font loaded');
    check(`${tag} after a webfont loads the caret is still on its character`, !r.bad, r.msg);
    const blk = await ev((k) => {
      const c = document.querySelector('.vimcur'), w = window.__hlRect(k);
      if (!c || c.hidden) return null;
      const b = c.getBoundingClientRect();
      return { dx: b.left - w.x, dw: b.width - w.w };
    }, i);
    check(`${tag} and the vim block follows it there`, blk && Math.abs(blk.dx) <= 1 && Math.abs(blk.dw) <= 1, JSON.stringify(blk));
    await ev(() => document.documentElement.style.removeProperty('--ed-font'));
  }

  //  ── the vim cursor's shape ────────────────────────────────────────────
  const look = () => ev(() => {
    const s = document.getElementById('src'), c = document.querySelector('.vimcur');
    const st = c && getComputedStyle(c), on = !!c && !c.hidden && st.display !== 'none';
    const p = s.selectionStart, r = window.__hlRect(p);
    const b = on ? c.getBoundingClientRect() : null;
    const probe = document.createElement('i'); probe.style.color = 'var(--text)'; probe.style.background = 'var(--bg)';
    document.body.append(probe); const ps = getComputedStyle(probe);
    const theme = [ps.color, ps.backgroundColor]; probe.remove();
    return { on, under: on && c.classList.contains('under'), caret: getComputedStyle(s).caretColor,
      bg: on ? st.backgroundColor : '', fg: on ? st.color : '', theme, ch: on ? c.textContent : '',
      at: s.value.charAt(p), dx: on && r ? b.left - r.x : null, dw: on && r ? b.width - r.w : null };
  });
  const key = async (k) => { await page.keyboard.press(k); };
  await ev(() => { localStorage.edVim = '1'; const s = document.getElementById('src'); s.focus(); });
  await ev((k) => window.__place(k), spots.find(([w]) => w === 'example.com')[1]);
  await key('Escape');
  let L = await look();
  check(`${tag} vim normal mode draws a block over the character`, L.on && !L.under
    && Math.abs(L.dx) <= 1 && Math.abs(L.dw) <= 1 && L.ch === L.at, JSON.stringify(L));
  check(`${tag} the block wears the theme: text colour behind, background colour on the character`,
    L.bg === L.theme[0] && L.fg === L.theme[1] && /rgba\(0, 0, 0, 0\)|transparent/.test(L.caret), JSON.stringify(L));
  const x0 = (await ev(() => (document.querySelector('.vimcur') || { getBoundingClientRect: () => ({ left: NaN }) }).getBoundingClientRect().left));
  await key('l');
  L = await look();
  const x1 = await ev(() => (document.querySelector('.vimcur') || { getBoundingClientRect: () => ({ left: NaN }) }).getBoundingClientRect().left);
  check(`${tag} l moves the block one character right`, x1 > x0 && Math.abs(L.dx) <= 1, `${x0} -> ${x1}`);
  for (const [k, back] of [['i', 'Escape'], ['a', 'Escape'], ['o', 'Escape'], ['A', 'Escape']]) {
    await key(k);
    L = await look();
    check(`${tag} ${k} turns it into the bar at once`, !L.on && !/rgba\(0, 0, 0, 0\)/.test(L.caret), JSON.stringify(L));
    await key(back);
    L = await look();
    check(`${tag} and Esc brings the block back at once`, L.on && !L.under && Math.abs(L.dx) <= 1, JSON.stringify(L));
  }
  await key('u'); await key('u');
  await key('v'); L = await look();
  check(`${tag} visual mode keeps the block`, L.on && !L.under, JSON.stringify(L));
  await key('Escape');
  await key('d'); L = await look();
  check(`${tag} operator-pending (d) keeps the block`, L.on && !L.under, JSON.stringify(L));
  await key('Escape');
  await key('r'); L = await look();
  check(`${tag} r waiting for its character is an underline`, L.on && L.under, JSON.stringify(L));
  await key('Escape');
  await key(':'); L = await look();
  check(`${tag} the : line keeps the block`, L.on && !L.under, JSON.stringify(L));
  await key('Escape'); L = await look();
  check(`${tag} and Esc from it too`, L.on && !L.under, JSON.stringify(L));
  //  a theme change repaints it in the new colours
  await ev(() => { const r = document.documentElement.style; r.setProperty('--text', 'rgb(10, 200, 30)'); r.setProperty('--bg', 'rgb(5, 6, 7)'); });
  L = await look();
  check(`${tag} a theme change recolours it`, L.bg === 'rgb(10, 200, 30)' && L.fg === 'rgb(5, 6, 7)', JSON.stringify(L));
  await ev(() => { const r = document.documentElement.style; r.removeProperty('--text'); r.removeProperty('--bg'); });
  await ev(() => { localStorage.edVim = '0'; window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
  L = await look();
  check(`${tag} vim off keeps the textarea's own caret`, !L.on && !/rgba\(0, 0, 0, 0\)/.test(L.caret), JSON.stringify(L));
}

//  ── the page, and the two engines ────────────────────────────────────────
const open = async (page) => {
  await page.evaluate(() => { for (const k of ['appTabs', 'appPage', 'edVim']) localStorage.removeItem(k); localStorage.appWrap = '1'; });
  await page.goto(env.app);
  await page.waitForFunction(() => window.latTabs && document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await page.evaluate((k) => window.latTabs.openIn('page', k, { newTab: true }), LONG);
  await page.waitForFunction((n) => {
    const s = document.getElementById('src'), h = document.getElementById('hl');
    return s && s.value.length === n && h.textContent === s.value + '\n';
  }, { timeout: 60000 }, DOC.length);
  await sleep(1500);
  await page.evaluate(helpers);
};

let drv = null;
const stopDriver = () => { if (drv) try { process.kill(-drv.pid, 'SIGTERM'); } catch {} };
try {
  await fetch(env.base + '/apps/lattice/page-save?type=md&new=1&name=' + encodeURIComponent(LONG),
    { method: 'POST', headers: { Cookie: env.cookie }, body: DOC });

  const browser = await launchBrowser();
  try {
    for (const dsf of [1, 1.25, 1.5]) {
      const page = await openPage(browser, env, { viewport: { width: 1200, height: 800, deviceScaleFactor: dsf },
        onPageError: (e) => check('chrome: no page error: ' + e.message, false) });
      await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await open(page);
      const shot = () => page.screenshot({ encoding: 'base64' });
      //  keep the deviceScaleFactor across setViewport
      const sv = page.setViewport.bind(page);
      page.setViewport = (v) => sv({ ...v, deviceScaleFactor: dsf });
      await suite(`chrome zoom ${dsf}:`, page, shot, dsf === 1
        ? { zooms: [1], widths: [1400, 900] } : { zooms: [1], widths: [1100] });
      await page.close();
    }
  } finally { await browser.close(); }

  const have = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (process.env.WEBKIT === '0') console.log('  skip webkit - WEBKIT=0');
  else if (!process.env.WD && (!have('WebKitWebDriver') || !have('xvfb-run'))) console.log('  skip webkit - no WebKitWebDriver or xvfb-run here');
  else {
    let wd = process.env.WD;
    if (!wd) {
      const port = await new Promise((res) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
      drv = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1200x24', 'WebKitWebDriver', '--port=' + port], { detached: true, stdio: 'ignore' });
      wd = 'http://localhost:' + port;
      for (let i = 0; i < 40; i++) { if (await fetch(wd + '/status').then((r) => r.ok, () => false)) break; await sleep(250); }
    }
    const p = await wdSession(wd);
    try {
      await p.goto(env.base + '/~/host');
      await p.setCookie({ name: env.cookieName, value: env.cookieValue, path: '/' });
      await p.setViewport({ width: 1200, height: 800 });
      await p.goto(env.app);
      await open(p);
      const press = p.keyboard.press.bind(p.keyboard);
      //  wd-page's press names letters by code; vim reads e.key
      p.keyboard.press = (k) => (k.length === 1 || k === 'Escape' ? p.evaluate((kk) => {
        const t = document.activeElement || document.body;
        t.dispatchEvent(new KeyboardEvent('keydown', { key: kk, bubbles: true, cancelable: true }));
        t.dispatchEvent(new KeyboardEvent('keyup', { key: kk, bubbles: true }));
      }, k) : press(k));
      await suite('webkit:', p, async () => (await p.screenshot({})).b64, { zooms: [1], widths: [1200] });
    } finally { await p.close(); }
  }
} catch (e) {
  check('suite crashed: ' + (e.stack || e.message), false);
} finally {
  stopDriver();
  for (const n of [LONG, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
