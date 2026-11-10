#!/usr/bin/env node
//  ui-sheet.mjs: spreadsheet pages (fods) in the editor shell, in a
//  browser against a fake ship. The grid on its own is ui-sheet-grid.mjs,
//  which needs no ship. This is everything around it.
//
//    lazy loading: a cold boot and a markdown open never ask for sheet.js,
//      the first fods open asks once (as ?h=, answered immutable), a second
//      one not at all, and a Writer page never asks for it
//    the grid mounts over the editor and shows the page
//    an edit reaches the ship: the typed value and the recomputed formula
//      are in the saved body, and the ship's own render shows them
//    the ship renders a table with nothing of the file's own markup
//    create from the dialog starts from LibreOffice's blank spreadsheet
//    Source in the page menu shows the XML, the kind picker refuses to
//      switch to or from fods, vim stays off
//    a Writer page and a spreadsheet side by side in tabs each keep their
//      own editor, and a tab switch inside the debounce saves
//    search finds a cell's text, and the outline lists the sheets
//    a spreadsheet opened once opens offline, sheet.js from the worker
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-sheet.mjs
//  ONLY=A,C runs just those sections after the setup.
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uisheet-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const corpus = (f) => readFileSync(join(here, '..', 'tests', 'sheet', 'corpus', f), 'utf8');
const writerDoc = readFileSync(join(here, '..', 'tests', 'writer', 'corpus', '01-paragraphs.fodt'), 'utf8');
const check = makeCheck();
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);

const P = {
  md: RUN + '/notes', calc: RUN + '/calc', sheets: RUN + '/sheets', i18n: RUN + '/i18n',
  made: RUN + '/made', tabs: RUN + '/tabs', doc: RUN + '/writer', off: RUN + '/off',
};
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
const put = (name, body, type = 'fods') => api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(name),
  { method: 'POST', body });
const shipBody = async (name, render) => {
  const r = await api('page-source?name=' + encodeURIComponent(name) + (render ? '&render=1' : ''));
  return r.ok ? r.json() : null;
};

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1300, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
let reqs = [];
page.on('request', (r) => { if (r.url().includes('/apps/lattice')) reqs.push(r.url()); });
const sjsReqs = (from = 0) => reqs.slice(from).filter((u) => /\/app\/sheet\.js/.test(u));
//  the sheet.js loads this document made, by resource timing: a request
//  the service worker answers does not always reach the request event
const sjsLoads = () => page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => e.initiatorType === 'script' && /\/app\/sheet\.js/.test(e.name)).map((e) => e.name));
const wait = (fn, ...a) => page.waitForFunction(fn, { timeout: 60000 }, ...a);

const srcVal = () => page.evaluate(() => document.getElementById('src').value);
const mounted = () => wait(() => !!document.querySelector('lat-sheet:not([hidden]) .ls-scroll .ls-c'));
async function open(name) {
  await page.evaluate((n) => window.latTabs.openIn('page', n), name);
  await wait((n) => document.getElementById('pname').value === n, name);
}
const shown = (r, c) => page.$eval(`lat-sheet:not([hidden]) .ls-c[data-r="${r}"][data-c="${c}"]`, (e) => e.textContent).catch(() => null);
async function clickCell(r, c) {
  const h = await page.$(`lat-sheet:not([hidden]) .ls-c[data-r="${r}"][data-c="${c}"]`);
  const b = await h.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
async function type(r, c, text) {
  await clickCell(r, c);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

let step = 'setup';
try {
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  const seeds = [
    [P.md, '# notes\n\nplain markdown', 'md'],
    [P.calc, corpus('02-formulas.fods')],
    [P.sheets, corpus('05-sheets.fods')],
    [P.i18n, corpus('09-i18n.fods')],
    [P.tabs, corpus('06-formats.fods')],
    [P.off, corpus('01-values.fods')],
    [P.doc, writerDoc, 'fodt'],
  ];
  for (const [n, b, t] of seeds) {
    const r = await put(n, b, t);
    if (!r.ok) throw new Error('seed ' + n + ': ' + r.status + ' ' + (await r.text()).slice(0, 120));
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
    check('A: a cold boot on a markdown page never asks for sheet.js', sjsReqs().length === 0, sjsReqs().join(' '));
    check('A: nor does the document load it', (await sjsLoads()).length === 0);
    await open(P.doc);
    await wait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc'));
    check('A: a Writer page mounts its own editor and never asks for sheet.js', (await sjsLoads()).length === 0);
    await open(P.calc);
    await mounted();
    const first = await sjsLoads();
    check('A: the first fods open asks for sheet.js once', first.length === 1, first.join(' '));
    check('A: as ?h=, the hash app.js was built with', first.length === 1 && /sheet\.js\?h=0v/.test(first[0]), first[0]);
    if (first[0]) {
      const cc = await page.evaluate(async (u) => (await fetch(u)).headers.get('cache-control'), first[0]);
      check('A: and the ship answers it immutable', /immutable/.test(cc || ''), cc);
    }
    check('A: the Writer editor is out of the way', await page.evaluate(() => !document.querySelector('lat-writer:not([hidden])')));
    await open(P.sheets);
    await mounted();
    await sleep(500);
    check('A: a second fods open asks for nothing more', (await sjsLoads()).length === 1);
    const mark = reqs.length;
    await open(P.md);
    await wait(() => document.getElementById('src').value.includes('plain markdown'));
    check('A: back on markdown, the textarea shows again and the grid is gone',
      await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility !== 'hidden'
        && !document.querySelector('lat-sheet:not([hidden]) .ls-scroll')));
    check('A: still no sheet.js request for markdown', sjsReqs(mark).length === 0);
  }

  // ------------------------------------------------------------ B: edit and save
  if (on('B')) {
    step = 'B view';
    await open(P.calc);
    await mounted();
    check('B: the grid shows the page', (await shown(0, 0)) === 'a' && (await shown(1, 3)) === '5');
    check('B: the textarea is hidden under it', await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility === 'hidden'));
    step = 'B type';
    const before = await srcVal();
    await type(1, 0, '20');
    const after = await waitFor(async () => { const v = await srcVal(); return v !== before ? v : null; }, 5000, 50);
    check('B: a typed value reaches the page buffer', !!after && after.includes('office:value="20"'));
    check('B: with the formula that reads it recomputed', !!after && /table:formula="of:=\[\.A2\]\+\[\.B2\]" office:value-type="float" office:value="23"/.test(after));
    check('B: and a small diff: the line count is unchanged', !!after && after.split('\n').length === before.split('\n').length);
    step = 'B save';
    const saved = await waitFor(async () => { const d = await shipBody(P.calc); return d && d.body.includes('office:value="23"') ? d : null; }, 30000, 500);
    check('B: autosave puts it on the ship, still a fods page', !!saved && saved.kind === 'fods', saved && saved.kind);
    step = 'B render';
    const rend = await shipBody(P.calc, true);
    const full = (rend && rend.html) || '';
    const html = full.slice(Math.max(full.indexOf('<div class="fods">'), 0));
    check("B: the ship's render is a table with the new values", /^<div class="fods"><h3>Calc<\/h3><table>/.test(html) && />20</.test(html) && />23</.test(html), html.slice(0, 160));
    check('B: and carries no formula and no ODF', !/of:=|table:formula|office:/.test(html));
    step = 'B formula';
    await type(3, 5, '=SUM(A2:A5)&" total"');
    check('B: a typed formula is computed in the grid', (await shown(3, 5)) === '37 total', String(await shown(3, 5)));
    const saved2 = await waitFor(async () => { const d = await shipBody(P.calc); return d && d.body.includes('37 total') ? d : null; }, 30000, 500);
    check('B: and saved with its stored spelling', !!saved2 && saved2.body.includes('table:formula="of:=SUM([.A2:.A5])&amp;&quot; total&quot;"'));
    step = 'B reload';
    await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
    await mounted();
    check('B: after a reload the page opens in the grid with the edit', (await shown(1, 0)) === '20' && (await shown(1, 3)) === '23');
  }

  // ------------------------------------------------------------ R: the ship's render
  if (on('R')) {
    step = 'R hostile';
    const hostile = corpus('09-i18n.fods').replace('table:name="Texte"', 'table:name="&lt;img src=x onerror=alert(1)&gt;"')
      .replace('<text:p>emoji</text:p>', '<text:p>&lt;script&gt;alert(2)&lt;/script&gt;</text:p>');
    const r = await put(RUN + '/hostile', hostile);
    check('R: a hostile spreadsheet saves', r.ok, String(r.status));
    P.hostile = RUN + '/hostile';
    const d = await shipBody(P.hostile, true);
    //  the sheet itself: the document around it has its own chrome
    //  (the renderer nests no div, so it ends at the first </div>)
    const frag = (h) => { const i = h.indexOf('<div class="fods">'); const j = h.indexOf('</div>', i); return i < 0 || j < 0 ? '' : h.slice(i, j); };
    const html = frag((d && d.html) || '');
    check('R: its sheet name and cell come out as text', html.includes('&lt;img') && html.includes('&lt;script&gt;') && !/<img|<script/i.test(html), html.slice(0, 200));
    const pv = await api('page-preview?type=fods', { method: 'POST', body: hostile });
    const pt = await pv.text();
    const pf = frag(pt);
    check('R: page-preview is as safe', pv.ok && pf.includes('&lt;script&gt;') && !/<img|<script/i.test(pf), pf.slice(0, 160));
    step = 'R search';
    const s = await api('page-search?q=snow');
    const sj = s.ok ? JSON.stringify(await s.json()) : '';
    check("R: the ship's search finds a cell's text", sj.includes(P.i18n), sj.slice(0, 200));
    const noXml = await api('page-search?q=' + encodeURIComponent('calcext'));
    const nj = noXml.ok ? JSON.stringify(await noXml.json()) : '';
    check('R: and does not match the XML around it', !nj.includes(RUN), nj.slice(0, 200));
  }

  // ------------------------------------------------------------ C: create
  if (on('C')) {
    step = 'C create';
    await page.evaluate(() => document.getElementById('newfile').click());
    await wait(() => !!document.getElementById('dlginput'));
    const hasKind = await page.evaluate(() => [...document.getElementById('dlgkind').options].some((o) => o.value === 'fods'));
    check('C: the new-page dialog offers the spreadsheet kind', hasKind);
    await page.evaluate((n) => {
      const i = document.getElementById('dlginput');
      i.value = n; i.dispatchEvent(new Event('input'));
      const k = document.getElementById('dlgkind');
      k.value = 'fods'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlgok').click();
    }, P.made);
    await mounted();
    const blankOk = await waitFor(async () => { const d = await shipBody(P.made); return d && d.kind === 'fods' && d.body.includes('<office:spreadsheet') ? d : null; }, 20000, 500);
    check("C: a page created as fods is LibreOffice's blank spreadsheet on the ship", !!blankOk, JSON.stringify(blankOk && { kind: blankOk.kind, len: blankOk.body.length }));
    await type(0, 0, '12');
    await type(1, 0, '30');
    await type(2, 0, '=A1+A2');
    check('C: it takes values and a formula', (await shown(2, 0)) === '42');
    const savedNew = await waitFor(async () => { const d = await shipBody(P.made); return d && d.body.includes('office:value="42"') ? d : null; }, 30000, 500);
    check('C: and saves them', !!savedNew);
  }

  // ------------------------------------------------------------ F: the shell
  if (on('F')) {
    step = 'F source';
    await open(P.sheets);
    await mounted();
    const has = await page.evaluate(() => { document.getElementById('tmenu').click(); return !!document.querySelector('.tmenu [data-mi="source"]'); });
    check('F: the page menu has Source on a fods page', has);
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]').click());
    await sleep(300);
    const sv = await page.evaluate(() => ({
      vis: getComputedStyle(document.getElementById('src')).visibility,
      grid: !!document.querySelector('lat-sheet:not([hidden]) .ls-scroll'),
      xml: document.getElementById('src').value.includes('<office:spreadsheet'),
    }));
    check('F: Source shows the XML in the textarea', sv.vis !== 'hidden' && !sv.grid && sv.xml, JSON.stringify(sv));
    await page.evaluate(() => { localStorage.edVim = '1'; window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    const v0 = await srcVal();
    await page.focus('#src');
    await page.evaluate(() => document.getElementById('src').setSelectionRange(0, 0));
    await page.keyboard.type('q');
    await sleep(200);
    check('F: vim stays off on a fods page (a key types)', (await srcVal()) === 'q' + v0);
    await page.keyboard.press('Backspace');
    await page.evaluate(() => { localStorage.removeItem('edVim'); window.dispatchEvent(new StorageEvent('storage', { key: 'edVim' })); });
    await sleep(2600);
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]') || document.getElementById('tmenu').click());
    await page.evaluate(() => document.querySelector('.tmenu [data-mi="source"]').click());
    await mounted();
    check('F: leaving Source shows the grid again', true);
    step = 'F kind';
    await page.evaluate(() => {
      document.getElementById('tmenu').click();
      document.querySelector('.tmenu [data-mi="kind"]').click();
      document.querySelector('.tmenu [data-kind="md"]').click();
    });
    await sleep(300);
    check('F: the kind picker refuses fods to md', await page.evaluate(() => document.getElementById('pkind').value) === 'fods');
    await page.evaluate(() => {
      if (!document.querySelector('.tmenu [data-kind]')) { document.getElementById('tmenu').click(); document.querySelector('.tmenu [data-mi="kind"]').click(); }
      document.querySelector('.tmenu [data-kind="fodt"]').click();
    });
    await sleep(300);
    check('F: and fods to fodt', await page.evaluate(() => document.getElementById('pkind').value) === 'fods');
    await page.keyboard.press('Escape');
    step = 'F outline';
    const out = await page.evaluate(() => window.LatSheet.extract.outline(document.getElementById('src').value).map((o) => o.text).join('|'));
    check.eq('F: the outline is the sheets', out, "Data|My Sheet|It's");
  }

  // ------------------------------------------------------------ G: tabs
  if (on('G')) {
    step = 'G tabs';
    await open(P.tabs);
    await mounted();
    await clickCell(2, 0);
    await page.keyboard.type('77');
    await page.keyboard.press('Enter');
    //  away at once, inside the 300 ms write and the autosave debounce
    await open(P.doc);
    await wait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc'));
    check('G: a Writer page in front shows the Writer editor, not the grid',
      await page.evaluate(() => !document.querySelector('lat-sheet:not([hidden])')));
    const saved = await waitFor(async () => { const d = await shipBody(P.tabs); return d && d.body.includes('office:value="77"') ? d : null; }, 30000, 500);
    check('G: the edit made just before the switch was saved', !!saved);
    const doc = await shipBody(P.doc);
    check('G: and the Writer page is untouched', !!doc && doc.kind === 'fodt' && doc.body === writerDoc);
    await open(P.tabs);
    await mounted();
    check('G: back on the spreadsheet, the grid has the edit', (await shown(2, 0)) === '77' && (await shown(2, 2)) === '79', `${await shown(2, 0)} ${await shown(2, 2)}`);
  }

  // ------------------------------------------------------------ H: offline
  if (on('H')) {
    step = 'H offline';
    await open(P.off);
    await mounted();
    await sleep(1500);
    const cached = await page.evaluate(async () => !!(await caches.match('/apps/lattice/app/sheet.js')));
    check('H: the worker cached sheet.js on first use', cached);
    const sw = await page.evaluate(async () => (await fetch('/apps/lattice/sw.js')).text());
    const shell = (sw.match(/var SHELL=\[[^\]]*\]/) || [''])[0];
    check('H: and it is not in the install precache list', shell.length > 0 && !shell.includes('sheet.js'), shell.slice(0, 80));
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const offOk = await waitFor(() => page.evaluate(() => !!document.querySelector('lat-sheet:not([hidden]) .ls-c')
      && [...document.querySelectorAll('lat-sheet .ls-c')].some((e) => e.textContent === 'hello world')), 30000, 500);
    check("H: offline, the page opens in the grid from the worker's cache", !!offOk);
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
