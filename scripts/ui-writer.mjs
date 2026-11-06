#!/usr/bin/env node
//  ui-writer.mjs: the Writer editor for fodt pages, in a browser against a
//  fake ship (plan, Tasks 9 and 10).
//
//    lazy loading: a cold boot and a markdown open never ask for writer.js,
//      the first fodt open asks once (as ?h=, answered immutable), a second
//      one not at all; app.js stays in its budget and never names the
//      bundled editor library
//    the view: the page sheet, the draft layout note once, opaque boxes
//      read-only, a tracked-changes document read-only with a banner
//    the toolbar: every action changes the saved body as expected, and
//      Ctrl+Z puts the body back byte for byte
//    paste: HTML with a script and handlers brings only its text
//    links: a javascript: link is not followed, and the link form warns and
//      refuses to make one
//    paired markers: deleting one half of a bookmark is refused, and said
//    a phone-width viewport scales the sheet and keeps the toolbar usable
//    IME composition commits its text
//    the shell: create from the dialog starts from the blank document,
//      Source in the page menu shows the XML, the kind picker refuses to
//      switch to or from fodt, vim stays off, a tab switch inside the
//      debounce saves, a split parks the page as a render, an offline edit
//      queues and lands, a conflict keeps a fodt copy, and a page opened
//      once opens offline with writer.js from the worker's cache
//    twins: two pages with the same body keep their own undo history
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-writer.mjs
//  ONLY=A,C runs just those sections after the setup.
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { readFileSync } from 'fs';
import { MAX as SIZE_MAX } from './app-js-size.mjs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor, swControlled } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uiwriter-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const corpus = (f) => readFileSync(join(here, '..', 'tests', 'writer', 'corpus', f), 'utf8');
const check = makeCheck();
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
//  app.js's budget: the size ratchet (scripts/app-js-size.mjs), measured
//  here on the served file. It used to be release 107 plus the 8 KB the
//  Writer spec allowed, which main outgrew by release 109.
const APP_JS_MAX = SIZE_MAX;

const P = {
  md: RUN + '/notes',
  inline: RUN + '/inline',
  links: RUN + '/links',
  marks: RUN + '/marks',
  track: RUN + '/track',
  lists: RUN + '/lists',
  made: RUN + '/made',
  tabs: RUN + '/tabs',
  off: RUN + '/off',
  focus: RUN + '/focus',
  twinA: RUN + '/twin-a',
  twinB: RUN + '/twin-b',
};
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
const put = (name, body, type = 'fodt') => api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(name),
  { method: 'POST', body });
const shipBody = async (name) => {
  const r = await api('page-source?name=' + encodeURIComponent(name));
  return r.ok ? r.json() : null;
};

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1300, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
let reqs = [];
page.on('request', (r) => { if (r.url().includes('/apps/lattice')) reqs.push(r.url()); });
let shipDown = false;
await page.setRequestInterception(true);
page.on('request', (r) => {
  const down = shipDown && /page-save|legacy-status|page-cmd/.test(r.url());
  (down ? r.abort() : r.continue()).catch(() => {});
});
const wjsReqs = (from = 0) => reqs.slice(from).filter((u) => /\/app\/writer\.js/.test(u));
//  the writer.js loads this document made, by resource timing: a request
//  the service worker answers does not always reach the request event
const wjsLoads = () => page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => e.initiatorType === 'script' && /\/app\/writer\.js/.test(e.name)).map((e) => e.name));
const wait = (fn, ...a) => page.waitForFunction(fn, { timeout: 60000 }, ...a);

// ---------------------------------------------------------------- helpers
const srcVal = () => page.evaluate(() => document.getElementById('src').value);
const status = () => page.evaluate(() => document.getElementById('status').textContent || '');
const mounted = () => wait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc'));
//  open a page in the tab in front, as the tree does
async function open(name) {
  await page.evaluate((n) => window.latTabs.openIn('page', n), name);
  await wait((n) => document.getElementById('pname').value === n, name);
}
//  the src text once it differs from `before` (the 300 ms write)
async function changed(before, ms = 5000) {
  return waitFor(async () => { const v = await srcVal(); return v !== before ? v : null; }, ms, 50);
}
//  select `word` (or put the caret at its end with caret) in the first
//  block of the editor whose text has it
async function select(word, caret = false) {
  const ok = await page.evaluate((w, c) => {
    const doc = document.querySelector('lat-writer .lw-doc');
    const walk = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.data.indexOf(w);
      if (i < 0) continue;
      doc.focus();
      const r = document.createRange();
      r.setStart(n, c ? i + w.length : i);
      r.setEnd(n, i + w.length);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    }
    return false;
  }, word, caret);
  await sleep(120);
  return ok;
}
const tool = (id) => page.evaluate((i) => {
  const b = document.querySelector('lat-writer .lw-bar [data-lw="' + i + '"]');
  if (!b || b.disabled) return false;
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  b.click();
  return true;
}, id);
const pick = (id, value) => page.evaluate((i, v) => {
  const s = document.querySelector('lat-writer .lw-bar [data-lw="' + i + '"]');
  if (!s || s.disabled) return false;
  s.value = v;
  s.dispatchEvent(new Event('change'));
  return true;
}, id, value);
async function undoBack(orig) {
  await page.evaluate(() => document.querySelector('lat-writer .lw-doc').focus());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  return waitFor(async () => (await srcVal()) === orig, 5000, 50);
}
const menuItem = (id) => page.evaluate((i) => {
  document.getElementById('tmenu').click();
  const b = document.querySelector('.tmenu [data-mi="' + i + '"]');
  if (!b) { document.getElementById('tmenu').click(); return null; }
  return b;
}, id);

let step = 'setup';
try {
  // ------------------------------------------------------------ setup
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  const seeds = [
    [P.md, '# notes\n\nplain markdown', 'md'],
    [P.inline, corpus('03-inline.fodt')],
    [P.links, corpus('05-links.fodt')],
    [P.marks, corpus('10-unknown.fodt').replace('<text:tracked-changes>', '<text:tracked-changes text:track-changes="false">')],
    [P.track, corpus('10-unknown.fodt')],
    [P.lists, corpus('04-lists.fodt')],
    [P.tabs, corpus('01-paragraphs.fodt')],
    [P.off, corpus('01-paragraphs.fodt')],
    [P.focus, corpus('01-paragraphs.fodt')],
    [P.twinA, corpus('01-paragraphs.fodt')],
  ];
  for (const [n, b, t] of seeds) {
    const r = await put(n, b, t);
    if (!r.ok) throw new Error('seed ' + n + ': ' + r.status);
  }
  await waitFor(async () => {
    const r = await api('page-dump', { cache: 'no-store' });
    const j = await r.json();
    return seeds.every(([n]) => (j.nodes || []).some((x) => x.path === n));
  }, 30000, 1000);

  // ------------------------------------------------------------ A: lazy loading
  if (on('A')) {
    step = 'A lazy loading';
    reqs = [];
    await page.goto(APP + '?name=' + encodeURIComponent(P.md), { waitUntil: 'networkidle2', timeout: 60000 });
    await wait((n) => document.getElementById('pname').value === n && document.getElementById('src').value.includes('plain markdown'), P.md);
    await sleep(1500);
    check('A: a cold boot on a markdown page never asks for writer.js', wjsReqs().length === 0, wjsReqs().join(' '));
    check('A: and the markdown page shows in the textarea',
      await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility !== 'hidden'));
    const appJs = await page.evaluate(async () => (await fetch('/apps/lattice/app/app.js')).text());
    const appBytes = Buffer.byteLength(appJs);
    check('A: app.js is within its budget', appBytes <= APP_JS_MAX, appBytes + ' > ' + APP_JS_MAX);
    check('A: app.js never names the bundled editor library', !/prosemirror/i.test(appJs));
    check('A: nor does the document load it', (await wjsLoads()).length === 0);
    await open(P.inline);
    await mounted();
    const first = await wjsLoads();
    check('A: the first fodt open asks for writer.js once', first.length === 1, first.join(' '));
    check('A: as ?h=, the hash app.js was built with', first.length === 1 && /writer\.js\?h=0v/.test(first[0]), first[0]);
    if (first[0]) {
      const cc = await page.evaluate(async (u) => (await fetch(u)).headers.get('cache-control'), first[0]);
      check('A: and the ship answers it immutable', /immutable/.test(cc || ''), cc);
    }
    await open(P.links);
    await mounted();
    await sleep(500);
    const second = await wjsLoads();
    check('A: a second fodt open asks for nothing more', second.length === 1, second.join(' '));
    const mark3 = reqs.length;
    await open(P.md);
    await wait(() => document.getElementById('src').value.includes('plain markdown'));
    check('A: back on markdown, the textarea shows again and the editor is gone',
      await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility !== 'hidden'
        && !document.querySelector('lat-writer:not([hidden]) .lw-doc')));
    check('A: still no writer.js request for markdown', wjsReqs(mark3).length === 0);
  }

  // ------------------------------------------------------------ B: the view
  if (on('B')) {
    step = 'B the view';
    await page.evaluate(() => localStorage.removeItem('latWriterDraft'));
    await open(P.inline);
    await mounted();
    const v = await page.evaluate(() => {
      const sheet = document.querySelector('lat-writer .lw-sheet');
      return {
        draft: !!document.querySelector('lat-writer .lw-draft'),
        width: sheet.getBoundingClientRect().width,
        scale: +sheet.dataset.scale,
        pad: parseFloat(getComputedStyle(sheet).paddingLeft),
        bold: !!document.querySelector('lat-writer .lw-doc strong'),
        css: [...document.querySelectorAll('lat-writer style')].map((s) => s.textContent).join('').length,
        srcHidden: getComputedStyle(document.getElementById('src')).visibility === 'hidden',
      };
    });
    check('B: the draft layout note shows on first open', v.draft);
    //  the pane may be narrower than the page: the sheet is then the page
    //  scaled down, width and margins alike
    check('B: the sheet has the page width (US Letter, 816 px at scale 1)', v.scale > 0 && v.scale <= 1
      && Math.abs(v.width - 816 * v.scale) < 2, JSON.stringify(v));
    check('B: and its margins (2 cm, 76 px at scale 1)', Math.abs(v.pad - 76 * v.scale) < 1.5, JSON.stringify(v));
    check('B: the document styles are rendered as CSS', v.css > 200 && v.bold, JSON.stringify(v));
    check('B: the textarea is hidden under the editor', v.srcHidden);
    await page.evaluate(() => [...document.querySelectorAll('lat-writer .lw-draft button')].forEach((b) => b.click()));
    await open(P.links);
    await mounted();
    check('B: the draft note does not come back once dismissed',
      await page.evaluate(() => !document.querySelector('lat-writer .lw-draft')));

    await open(P.marks);
    await mounted();
    const op = await page.evaluate(() => {
      const b = document.querySelector('lat-writer .fodt-op:not([data-el="text:sequence-decls"])');
      const i = document.querySelector('lat-writer .fodt-opi');
      return { block: b && b.getAttribute('contenteditable'), inl: i && i.getAttribute('contenteditable'),
        label: b && b.textContent.slice(0, 40), editable: document.querySelector('lat-writer .lw-doc').getAttribute('contenteditable') };
    });
    check('B: opaque blocks are read-only boxes', op.block === 'false', JSON.stringify(op));
    check('B: opaque inline nodes are read-only', op.inl === 'false', JSON.stringify(op));
    check('B: a document not recording changes is editable', op.editable === 'true', JSON.stringify(op));

    await open(P.track);
    await mounted();
    const tr = await page.evaluate(() => ({
      banner: (document.querySelector('lat-writer .lw-track') || {}).textContent || '',
      editable: document.querySelector('lat-writer .lw-doc').getAttribute('contenteditable'),
      bold: document.querySelector('lat-writer .lw-bar [data-lw="bold"]').disabled,
    }));
    check('B: a document recording tracked changes opens read-only', tr.editable === 'false', JSON.stringify(tr));
    check('B: with a banner saying why', /tracked changes/.test(tr.banner) && /read-only/.test(tr.banner), tr.banner);
    check('B: and the toolbar is off', tr.bold === true);
    const before = await srcVal();
    await page.click('lat-writer .lw-doc');
    await page.keyboard.type('NOPE');
    await sleep(700);
    check('B: typing there changes nothing', (await srcVal()) === before);

    //  the first key after focus lands in the first text, never over the
    //  hidden sequence-decls the document starts with
    await open(P.focus);
    await mounted();
    const fb = await srcVal();
    await page.evaluate(() => document.querySelector('lat-writer .lw-doc').focus());
    await page.keyboard.type('FOCUSED');
    const fa = await changed(fb);
    check('B: typing straight after focus keeps the hidden declarations',
      !!fa && fa.includes('<text:sequence-decls>') && fa.includes('FOCUSED'), fa && fa.slice(fa.indexOf('<office:text>'), fa.indexOf('<office:text>') + 160));
    //  saved before C, so the create below starts from a clean editor
    await waitFor(async () => { const d = await shipBody(P.focus); return d && d.body.includes('FOCUSED'); }, 20000, 500);
    await sleep(500);
  }

  // ------------------------------------------------------------ C: create and the toolbar
  if (on('C')) {
    step = 'C create';
    await page.evaluate(() => document.getElementById('newfile').click());
    await wait(() => !!document.getElementById('dlginput'));
    await page.evaluate((n) => {
      const i = document.getElementById('dlginput');
      i.value = n; i.dispatchEvent(new Event('input'));
      const k = document.getElementById('dlgkind');
      k.value = 'fodt'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlgok').click();
    }, P.made);
    await mounted();
    const blankOk = await waitFor(async () => { const d = await shipBody(P.made); return d && d.kind === 'fodt' && d.body.includes('<office:document') ? d : null; }, 20000, 500);
    check('C: a page created as fodt is LibreOffice\'s blank document on the ship', !!blankOk,
      JSON.stringify(blankOk && { kind: blankOk.kind, len: blankOk.body.length }));
    check('C: it opens in the editor', await page.evaluate(() => !!document.querySelector('lat-writer .lw-doc')));

    step = 'C type';
    await page.click('lat-writer .lw-doc p');
    await page.keyboard.type('Alpha beta gamma delta');
    const typed = await changed(blankOk ? blankOk.body : '', 4000);
    check('C: typing reaches #src within the idle', !!typed && typed.includes('Alpha beta gamma delta'));
    await sleep(800);
    const orig = await srcVal();
    const acts = [
      ['bold', 'beta', () => tool('bold'), (t) => /<text:span text:style-name="LT[0-9a-f]{8}">beta<\/text:span>/.test(t) && /fo:font-weight="bold"/.test(t)],
      ['italic', 'beta', () => tool('italic'), (t) => /<text:span text:style-name="LT[0-9a-f]{8}">beta</.test(t) && /fo:font-style="italic"/.test(t)],
      ['underline', 'beta', () => tool('underline'), (t) => /style:text-underline-style="solid"[^>]*>|style:text-underline-style="solid"/.test(t) && />beta</.test(t)],
      ['strike', 'beta', () => tool('strike'), (t) => /style:text-line-through-style="solid"/.test(t)],
      ['heading 2', 'beta', () => pick('block', '2'), (t) => /<text:h text:style-name="Heading_20_2" text:outline-level="2">Alpha/.test(t)],
      ['bullet list', 'beta', () => tool('bullets'), (t) => /<text:list text:style-name="List_20_1">\s*<text:list-item>\s*<text:p[^>]*>Alpha/.test(t)],
      ['numbered list', 'beta', () => tool('numbers'), (t) => /<text:list text:style-name="Numbering_20_123">/.test(t)],
      ['quote', 'beta', () => tool('quote'), (t) => /<text:p text:style-name="Quotations">Alpha/.test(t)],
      ['page break', 'beta', () => tool('pagebreak'), (t) => /<text:p text:style-name="LP[0-9a-f]{8}">Alpha/.test(t) && /fo:break-before="page"/.test(t)],
      ['paragraph style', 'beta', () => pick('pstyle', 'Standard'), (t) => /<text:p text:style-name="Standard">Alpha/.test(t)],
    ];
    for (const [what, word, act, ok] of acts) {
      step = 'C ' + what;
      await select(word);
      const did = await act();
      const after = await changed(orig, 4000);
      check(`C: ${what} changes the body as expected`, did && after && ok(after),
        !did ? 'the control was disabled' : after ? after.slice(after.indexOf('<office:text>'), after.indexOf('<office:text>') + 400) : 'no change');
      await sleep(650);       // its own undo step
      check(`C: Ctrl+Z puts the body back byte for byte (${what})`, await undoBack(orig));
      await sleep(650);
    }

    step = 'C link';
    await select('gamma');
    await tool('link');
    await wait(() => !!document.querySelector('lat-writer .lw-link input'));
    await page.evaluate(() => { const i = document.querySelector('lat-writer .lw-link input'); i.value = 'https://example.com/x?a=1&b=2'; i.dispatchEvent(new Event('input')); });
    await page.focus('lat-writer .lw-link input');
    await page.keyboard.press('Enter');
    const lk = await changed(orig, 4000);
    check('C: link adds a text:a with the target', !!lk && /<text:a xlink:type="simple" xlink:href="https:\/\/example\.com\/x\?a=1&amp;b=2">gamma<\/text:a>/.test(lk),
      lk && lk.slice(lk.indexOf('Alpha') - 60, lk.indexOf('Alpha') + 200));
    await sleep(650);
    check('C: Ctrl+Z removes it again', await undoBack(orig));

    step = 'C enter';
    await select('delta', true);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second para');
    const two = await changed(orig, 4000);
    check('C: Enter at the end starts a new paragraph in the next style',
      !!two && /<text:p text:style-name="Text_20_body">Second para<\/text:p>/.test(two), two && two.slice(two.indexOf('Alpha') - 40, two.indexOf('Alpha') + 160));
    await sleep(600);
    await undoBack(orig);

    step = 'C char style';
    await open(P.inline);
    await mounted();
    await sleep(400);
    const iorig = await srcVal();
    await select('Plain');
    const cs = await pick('cstyle', 'Emphasis');
    const csv = await changed(iorig, 4000);
    check('C: the character style picker applies a named style', cs && !!csv && /<text:span text:style-name="Emphasis">Plain<\/text:span>/.test(csv));
    await sleep(650);
    check('C: and Ctrl+Z takes it off', await undoBack(iorig));
  }

  // ------------------------------------------------------------ D: paste, links, pairs
  if (on('D')) {
    step = 'D paste';
    await open(P.inline);
    await mounted();
    await sleep(400);
    const iorig = await srcVal();
    await select('Plain', true);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<p onclick="window.__PWNED=1">Pasted <b>loud</b> words<script>window.__PWNED=2<\/script>'
        + '<img src="x" onerror="window.__PWNED=3"><a href="javascript:window.__PWNED=4">jslink</a></p>');
      dt.setData('text/plain', 'Pasted loud words jslink');
      document.querySelector('lat-writer .lw-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const pv = await changed(iorig, 4000);
    const pbody = pv ? pv.slice(pv.indexOf('<office:text>')) : '';
    check('D: pasted HTML brings its text', /Pasted/.test(pbody) && /loud/.test(pbody) && /jslink/.test(pbody), pbody.slice(0, 300));
    check('D: and no script, handler, image or javascript: link',
      !/script|onclick|onerror|PWNED|img|javascript:/i.test(pbody), pbody.slice(0, 300));
    check('D: nothing ran', await page.evaluate(() => window.__PWNED === undefined));
    await sleep(650);
    await undoBack(iorig);

    //  Google Docs: the whole paste in <b style="font-weight:normal">, and
    //  underline and strike in a span's style
    step = 'D paste gdocs';
    await select('Plain', true);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/html', '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">'
        + '<span style="font-weight:400;">Gplain</span> <span style="font-weight:700;">Gbold</span> '
        + '<span style="text-decoration:underline;">Gunder</span> <span style="text-decoration:line-through;">Gstruck</span></b>');
      dt.setData('text/plain', 'Gplain Gbold Gunder Gstruck');
      document.querySelector('lat-writer .lw-doc').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const gd = await page.evaluate(() => {
      const d = document.querySelector('lat-writer .lw-doc');
      const inn = (w, sel) => [...d.querySelectorAll(sel)].some((e) => e.textContent.includes(w));
      return { plainBold: inn('Gplain', 'strong'), bold: inn('Gbold', 'strong'), under: inn('Gunder', 'u'), struck: inn('Gstruck', 's') };
    });
    check('D: a Google Docs paste is not all bold, and keeps its bold, underline and strike',
      !gd.plainBold && gd.bold && gd.under && gd.struck, JSON.stringify(gd));
    await sleep(650);
    await undoBack(iorig);

    step = 'D links';
    await open(P.links);
    await mounted();
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    const url0 = page.url();
    const hasJs = await page.evaluate(() => {
      const a = [...document.querySelectorAll('lat-writer .lw-doc a[data-href]')].find((x) => x.getAttribute('data-href').startsWith('javascript:'));
      if (!a) return null;
      return { href: a.getAttribute('href'), clickable: !!a.href };
    });
    check('D: a javascript: link is shown with no href', hasJs && hasJs.href === null, JSON.stringify(hasJs));
    await page.click('lat-writer .lw-doc a[data-href^="javascript:"]');
    await page.keyboard.down('Control');
    await page.click('lat-writer .lw-doc a[data-href^="javascript:"]');
    await page.keyboard.up('Control');
    await sleep(400);
    const opened = await page.evaluate(() => window.__opened);
    check('D: clicking it, with or without Ctrl, follows nothing',
      page.url() === url0 && opened.length === 0 && await page.evaluate(() => window.__PWNED === undefined), JSON.stringify(opened));
    check('D: and Ctrl+click says it does not open from lattice', /does not open from lattice/.test(
      await page.evaluate(() => (document.querySelector('lat-writer .lw-say') || {}).textContent || '')));
    await page.keyboard.down('Control');
    await page.click('lat-writer .lw-doc a[data-href^="https://example.org"]');
    await page.keyboard.up('Control');
    await sleep(300);
    check('D: Ctrl+click on an http link opens it in a new tab',
      (await page.evaluate(() => window.__opened)).some((u) => u.startsWith('https://example.org')));
    await select('do not click', true);
    await tool('link');
    await wait(() => !!document.querySelector('lat-writer .lw-link'));
    const warn = await page.evaluate(() => { const w = document.querySelector('lat-writer .lw-link .lw-warn'); return w && !w.hidden ? w.textContent : ''; });
    check('D: the link form shows the raw target with a warning', /will not open/.test(warn) && /javascript:alert\(1\)/.test(warn), warn);
    await page.keyboard.press('Escape');
    const lorig = await srcVal();
    await select('example.org');
    await tool('link');
    await wait(() => !!document.querySelector('lat-writer .lw-link input'));
    await page.evaluate(() => { const i = document.querySelector('lat-writer .lw-link input'); i.value = 'javascript:alert(2)'; i.dispatchEvent(new Event('input')); });
    await page.focus('lat-writer .lw-link input');
    await page.keyboard.press('Enter');
    await sleep(600);
    const refused = await page.evaluate(() => { const w = document.querySelector('lat-writer .lw-link .lw-warn'); return w && !w.hidden ? w.textContent : ''; });
    check('D: the link form will not make a javascript: link', /will not make/.test(refused) && (await srcVal()) === lorig, refused);
    await page.keyboard.press('Escape');

    step = 'D pairs';
    await open(P.marks);
    await mounted();
    await sleep(400);
    const morig = await srcVal();
    await page.evaluate(() => {
      const p = [...document.querySelectorAll('lat-writer .lw-doc p')].find((x) => x.textContent.startsWith('A bookmark starts'));
      const r = document.createRange();
      r.setStart(p, 0);
      r.setEnd(p, p.childNodes.length);
      document.querySelector('lat-writer .lw-doc').focus();
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await sleep(150);
    await page.keyboard.press('Backspace');
    await sleep(700);
    const say = await page.evaluate(() => (document.querySelector('lat-writer .lw-say') || {}).textContent || '');
    check('D: deleting one half of a bookmark is refused', (await srcVal()) === morig
      && await page.evaluate(() => [...document.querySelectorAll('lat-writer .lw-doc p')].some((x) => x.textContent.startsWith('A bookmark starts'))));
    check('D: and the toolbar says why', /other end/.test(say), say);
  }

  // ------------------------------------------------------------ E: phone and IME
  if (on('E')) {
    step = 'E phone';
    const ph = await openPage(browser, env, { viewport: { width: 390, height: 800, isMobile: true, hasTouch: true } });
    await ph.goto(APP + '?name=' + encodeURIComponent(P.made), { waitUntil: 'networkidle2', timeout: 60000 });
    await ph.waitForFunction(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc'), { timeout: 60000 });
    const m = await ph.evaluate(() => {
      const sheet = document.querySelector('lat-writer .lw-sheet');
      const bar = document.querySelector('lat-writer .lw-bar');
      const b = bar.querySelector('[data-lw="redo"]');
      b.scrollIntoView({ inline: 'end' });
      const r = b.getBoundingClientRect();
      return { sheet: sheet.getBoundingClientRect().width, scale: +sheet.dataset.scale, barH: bar.getBoundingClientRect().height,
        scrolls: bar.scrollWidth > bar.clientWidth, redoIn: r.right <= innerWidth + 1 && r.left >= 0, big: r.height >= 28 };
    });
    check('E: at 390 px the sheet is scaled to fit', m.sheet <= 390 && m.scale < 1, JSON.stringify(m));
    check('E: the toolbar stays one scrollable row', m.barH < 50 && m.scrolls, JSON.stringify(m));
    check('E: its last control scrolls into reach, at a touchable size', m.redoIn && m.big, JSON.stringify(m));
    await ph.close();

    step = 'E IME';
    await open(P.inline);
    await mounted();
    await sleep(300);
    const iorig = await srcVal();
    await select('Plain', true);
    const cdp = await page.target().createCDPSession();
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await sleep(100);
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await sleep(100);
    await cdp.send('Input.insertText', { text: '日本' });
    const ime = await changed(iorig, 4000);
    check('E: IME composition commits the composed text', !!ime && ime.includes('Plain日本'), ime && ime.slice(ime.indexOf('Plain') - 20, ime.indexOf('Plain') + 40));
    await sleep(650);
    await undoBack(iorig);
  }

  // ------------------------------------------------------------ F: the shell
  if (on('F')) {
    step = 'F source';
    await open(P.inline);
    await mounted();
    const sb = await menuItem('source');
    check('F: the page menu has Source on a fodt page', !!sb);
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]').click());
    await sleep(300);
    const sv = await page.evaluate(() => ({
      vis: getComputedStyle(document.getElementById('src')).visibility,
      writer: !!document.querySelector('lat-writer:not([hidden]) .lw-doc'),
      xml: document.getElementById('src').value.includes('<office:document'),
    }));
    check('F: Source shows the XML in the textarea', sv.vis !== 'hidden' && !sv.writer && sv.xml, JSON.stringify(sv));
    step = 'F vim';
    await page.evaluate(() => { localStorage.edVim = '1'; window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    const v0 = await srcVal();
    await page.focus('#src');
    await page.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(0, 0); });
    await page.keyboard.type('q');
    await sleep(200);
    check('F: vim stays off on a fodt page (a key types)', (await srcVal()) === 'q' + v0);
    await page.keyboard.press('Backspace');
    await page.evaluate(() => { localStorage.removeItem('edVim'); window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    await sleep(2600);
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]') || document.getElementById('tmenu').click());
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]').click());
    await mounted();
    check('F: leaving Source shows the editor again', true);

    step = 'F kind';
    await page.evaluate(() => {
      document.getElementById('tmenu').click();
      document.querySelector('.tmenu [data-mi="kind"]').click();
      document.querySelector('.tmenu [data-kind="md"]').click();
    });
    await sleep(300);
    check('F: the kind picker refuses fodt to md', await page.evaluate(() => document.getElementById('pkind').value) === 'fodt'
      && /cannot change kind/.test(await status()), await status());
    await open(P.md);
    await wait(() => document.getElementById('src').value.includes('plain markdown'));
    await page.evaluate(() => {
      document.getElementById('tmenu').click();
      document.querySelector('.tmenu [data-mi="kind"]').click();
      document.querySelector('.tmenu [data-kind="fodt"]').click();
    });
    await sleep(300);
    check('F: the kind picker refuses md to fodt', await page.evaluate(() => document.getElementById('pkind').value) === 'md'
      && /cannot become a Writer document/.test(await status()), await status());
    const shipMd = await shipBody(P.md);
    check('F: and the md page is still md on the ship', shipMd && shipMd.kind === 'md', shipMd && shipMd.kind);

    //  a new page not saved yet: its kind is its text's
    step = 'F new page kind';
    //  a context of its own: no tabs to restore, so it boots on a new page
    const npCtx = await browser.createBrowserContext();
    const np = await openPage(npCtx, env, { viewport: { width: 1300, height: 900 } });
    await np.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
    await np.waitForFunction(() => document.getElementById('pname').value === '' && !!document.getElementById('src'), { timeout: 60000 });
    const npKind = async (k) => {
      await np.evaluate((v) => { const p = document.getElementById('pkind'); p.value = v; p.dispatchEvent(new Event('change')); }, k);
      await sleep(400);
      return np.evaluate(() => document.getElementById('pkind').value);
    };
    await np.evaluate(() => { const t = document.getElementById('src'); t.value = 'hello world'; t.dispatchEvent(new Event('input')); });
    check('F: a new page with text cannot become fodt', (await npKind('fodt')) === 'md');
    await np.evaluate(() => { document.getElementById('src').value = ''; });
    await npKind('fodt');
    const nb = await np.waitForFunction(() => document.querySelector('lat-writer:not([hidden]) .lw-doc')
      && document.getElementById('src').value.includes('<office:document'), { timeout: 30000 }).then(() => true, () => false);
    check('F: an empty new page made fodt starts as the blank document, in the editor', nb);
    check('F: and it cannot be made md again', (await npKind('md')) === 'fodt');
    await npCtx.close();
  }

  // ------------------------------------------------------------ G: tabs and splits
  if (on('G')) {
    step = 'G tab switch';
    await open(P.tabs);
    await mounted();
    await sleep(300);
    await select('The first paragraph', true);
    await page.keyboard.type(' TABSAFE');
    //  inside the 300 ms idle and the 2 s autosave: the park writes it
    await page.evaluate((n) => window.latTabs.openIn('page', n, { newTab: true }), P.md);
    await wait(() => document.getElementById('src').value.includes('plain markdown'));
    const landed = await waitFor(async () => { const d = await shipBody(P.tabs); return d && d.body.includes('TABSAFE'); }, 20000, 500);
    check('G: typing then a tab switch inside the debounce saves the edit', !!landed);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(1500);
    const d = await shipBody(P.tabs);
    check('G: and after a reload the ship has it', d && d.body.includes('The first paragraph TABSAFE'));
    const parsedOk = d && d.body.split('TABSAFE').length === 2;
    check('G: once', parsedOk);

    step = 'G split';
    await page.evaluate((n) => window.latTabs.openIn('page', n), P.tabs);
    await mounted();
    await page.evaluate(() => window.latSplits.split('r'));
    await sleep(1500);
    const gh = await waitFor(() => page.evaluate(() => {
      const f = [...document.querySelectorAll('.gghost:not([hidden]) .gdoc.gread .prev')][0];
      const s = f && f.getAttribute('srcdoc');
      return s && s.includes('TABSAFE') && s.includes('lw-doc') ? s.length : 0;
    }), 15000, 300);
    check('G: a parked fodt tab shows as the page, not its XML', !!gh);
    check('G: the live editor moved to the new group', await page.evaluate(() => !document.querySelector('lat-writer:not([hidden]) .lw-doc')
      || document.getElementById('pname').value !== ''));
  }

  // ------------------------------------------------------------ I: twins
  //  Two pages with the same body, as Duplicate makes: each gets its own
  //  editor, so Ctrl+Z in one never undoes what was typed in the other
  if (on('I')) {
    step = 'I twins';
    await open(P.twinA);
    await mounted();
    await sleep(300);
    await select('The first paragraph', true);
    await page.keyboard.type(' TWINA');
    const typed = await waitFor(async () => { const d = await shipBody(P.twinA); return d && d.body.includes('TWINA') ? d.body : null; }, 20000, 300);
    check('I: the edit in the first page saves', !!typed);
    const tb = await put(P.twinB, typed || '');
    check('I: a second page with the same body', tb.ok);
    await open(P.twinB);
    await wait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc')
      && document.getElementById('src').value.includes('TWINA'));
    await sleep(500);
    const before = await srcVal();
    await page.evaluate(() => document.querySelector('lat-writer .lw-doc').focus());
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await sleep(1500);
    check('I: Ctrl+Z in the second page has nothing of the first to undo', (await srcVal()) === before);
    await sleep(2500);
    const b = await shipBody(P.twinB);
    check('I: and the second page keeps its body on the ship', b && b.body.includes('TWINA'));
  }

  // ------------------------------------------------------------ H: offline and conflicts
  if (on('H')) {
    step = 'H offline edit';
    await page.goto(APP + '?name=' + encodeURIComponent(P.off), { waitUntil: 'networkidle2', timeout: 60000 });
    await mounted();
    await swControlled(page);
    await sleep(500);
    const base = await shipBody(P.off);
    shipDown = true;
    await select('The first paragraph', true);
    await page.keyboard.type(' OFFLINE');
    await wait(() => /waiting to sync/.test(document.getElementById('status').textContent || ''));
    check('H: an offline edit of a fodt page queues', true);
    //  another device edits the page meanwhile
    const other = base.body.replace('The last paragraph.', 'The last paragraph, CONCURRENT.');
    const cr = await api('page-save?type=fodt&name=' + encodeURIComponent(P.off), { method: 'POST', body: other });
    const cj = await cr.json();
    shipDown = false;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(() => /synced|conflict/.test(document.getElementById('status').textContent || ''));
    await sleep(2500);
    const after = await shipBody(P.off);
    check('H: back online, the queued save lands', after && after.body.includes('The first paragraph OFFLINE'), after && after.rev);
    check('H: as a fodt page still', after && after.kind === 'fodt');
    const keptName = 'conflicts/' + P.off.replace(/\//g, '-') + '-rev' + cj.rev;
    const kept = await shipBody(keptName);
    check('H: with its base rev, so the edit it replaced is kept as a conflict copy', !!kept && kept.body.includes('CONCURRENT'), keptName);
    check('H: and the copy is itself a fodt page', kept && kept.kind === 'fodt', kept && kept.kind);
    if (kept) await api('page-del?name=' + encodeURIComponent(keptName), { method: 'POST' });

    step = 'H offline open';
    const cached = await page.evaluate(async () => !!(await caches.match('/apps/lattice/app/writer.js')));
    check('H: the worker cached writer.js on first use', cached);
    const sw = await page.evaluate(async () => (await fetch('/apps/lattice/sw.js')).text());
    const shell = (sw.match(/var SHELL=\[[^\]]*\]/) || [''])[0];
    check('H: and it is not in the install precache list', shell.length > 0 && !shell.includes('writer.js'), shell.slice(0, 80));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const offOk = await waitFor(() => page.evaluate(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc')
      && document.querySelector('lat-writer .lw-doc').textContent.includes('OFFLINE')), 30000, 500);
    check('H: offline, the page opens in the editor from the worker\'s cache', !!offOk);
    await page.setOfflineMode(false);
  }
} catch (e) {
  check('suite crashed at ' + step + ': ' + e.message, false);
} finally {
  await browser.close().catch(() => {});
  for (const n of [...Object.values(P), RUN])
    await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' }).catch(() => {});
}
check.done();
