#!/usr/bin/env node
//  ui-pdf.mjs: Export PDF, from the page menu and the files tree, for every
//  page kind (ui-src/lattice/78-pdf.js, ui-app/pdf.js).
//
//  In a browser, export prints from a frame of its own, so the suite reads
//  that frame's document (what the print dialog would get), checks it, then
//  prints it with page.pdf() in a page that runs no script, as the frame
//  does, and checks the PDF: page count, the page's text, and none of the
//  app's chrome. With pdfinfo and pdftotext (poppler) it reads the PDF
//  itself; with pdftoppm it writes page PNGs to look at.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/cookie.txt \
//           node scripts/ui-pdf.mjs
//  Env:   PDF_OUT  keep the PDFs and PNGs there (default: a temp dir, removed)
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, shipName, launchBrowser, openPage, makeCheck } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uipdf-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const keep = process.env.PDF_OUT;
const out = keep || mkdtempSync(join(tmpdir(), 'uipdf-'));
mkdirSync(out, { recursive: true });
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
const put = (name, body, type) => api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(name),
  { method: 'POST', body });
const has = (bin) => spawnSync(bin, ['-v']).error === undefined;
const POPPLER = has('pdfinfo') && has('pdftotext');
const PNG = has('pdftoppm');

const para = (i) => `Paragraph ${i} of the long page. ` + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6);
const MD = '# PDF test page\n\nSome **bold** text and `code`.\n\n'
  + '![the icon](/apps/lattice/icon.svg)\n\n'
  + '```\n' + 'a_very_long_line_of_code_that_has_to_wrap_on_the_printed_page '.repeat(6) + '\n```\n\n'
  + '| a | b |\n|---|---|\n| one | two |\n\n'
  + Array.from({ length: 40 }, (_, i) => para(i + 1)).join('\n\n') + '\n\nTHE-END-MD\n';
const KINDS = {
  md: { body: MD, text: ['PDF test page', 'THE-END-MD'], pages: 3 },
  gmi: { body: '# Gemini capsule\n\nA line of gemtext.\n=> https://example.com a link\n```\npreformatted\n```\n', text: ['Gemini capsule', 'preformatted'], pages: 1 },
  text: { body: 'plain text line one\n' + 'x '.repeat(300) + '\nTHE-END-TEXT\n', text: ['plain text line one', 'THE-END-TEXT'], pages: 1, title: true },
  html: {
    body: '<!doctype html><html><head><title>Html page</title><style>h1{color:#246}</style>'
      + '<script>document.title="PWNED";document.addEventListener("DOMContentLoaded",function(){document.body.append("SCRIPT-RAN")})</script></head>'
      + '<body><h1>An html page</h1><p onclick="x()">its own markup</p><img src="/apps/lattice/icon.svg" width="64"></body></html>',
    text: ['An html page', 'its own markup'], pages: 1,
  },
  tex: { body: '\\documentclass{article}\n\\begin{document}\nTeX body $x^2$\n\\end{document}\n', text: ['TeX body'], pages: 1, title: true },
  fodt: { body: readFileSync(join(here, '..', 'tests', 'writer', 'corpus', '06-quote-break.fodt'), 'utf8'), text: [], pages: 2 },
  js: { body: '// a script page\nconst answer = 42;\nfunction hello(n) { return "hi " + n; }\n', text: ['const answer = 42'], pages: 1, title: true },
  hoon: { body: '|=  n=@ud\n^-  @ud\n(add n 1)\n', text: ['(add n 1)'], pages: 1, title: true },
};
//  the app's own chrome, none of which may reach the PDF
const CHROME = ['tabhead', 'tmenu', 'treelist', 'lat-editor', 'lat-preview', 'statusbar', 'id="src"'];

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
const wait = (fn, ms, ...a) => page.waitForFunction(fn, { timeout: ms || 60000 }, ...a);

//  what export put in the print frame, once it has called print()
async function exported(start) {
  await wait(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    return f && f.contentDocument && f.contentDocument.readyState === 'complete'
      && /PDF ready to print|PDF:/.test(document.getElementById('status').textContent);
  }, 120000);
  return page.evaluate(() => {
    const f = document.querySelector('iframe[data-lat-pdf]');
    return { html: f.srcdoc, sandbox: f.getAttribute('sandbox'), status: document.getElementById('status').textContent };
  }).finally(start);
}
async function viaMenu(name) {
  //  asked again until it takes: an open before boot has settled is dropped
  await page.waitForFunction((n) => {
    if (document.getElementById('pname').value === n) return true;
    const t = Date.now();
    if (!(t - (window.__pdfAsk || 0) < 3000)) { window.__pdfAsk = t; window.latTabs.openIn('page', n); }
    return false;
  }, { timeout: 60000, polling: 250 }, name).catch(async (e) => {
    throw new Error('opening ' + name + ': ' + JSON.stringify(await page.evaluate(() =>
      [document.getElementById('pname').value, document.getElementById('status').textContent])));
  });
  await page.evaluate(() => { const f = document.querySelector('iframe[data-lat-pdf]'); if (f) f.remove(); });
  await page.click('#tmenu');
  await page.waitForSelector('.tmenu [data-mi="pdf"]', { visible: true, timeout: 5000 });
  await page.click('.tmenu [data-mi="pdf"]');
  return exported(() => {});
}
async function viaTree(name) {
  await page.evaluate(() => { const f = document.querySelector('iframe[data-lat-pdf]'); if (f) f.remove(); });
  const at = await page.evaluate((k) => {
    const r = [...document.querySelectorAll('#treelist [role=treeitem]')].find((x) => x.dataset.tk === k);
    if (!r) return null;
    r.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  }, 'p:' + name);
  if (!at) return null;
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForSelector('.treemenu [data-mi="pdf"]', { visible: true, timeout: 5000 });
  await page.click('.treemenu [data-mi="pdf"]');
  return exported(() => {});
}

//  print the frame's document as the frame would: no script
async function toPdf(kind, html) {
  const p = await browser.newPage();
  await p.setJavaScriptEnabled(false);
  //  no base needed: export made every link absolute and the images data
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await p.setContent(html, { waitUntil: 'load', timeout: 60000 });
  await p.emulateMediaType('print');
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const file = join(out, kind + '.pdf');
  writeFileSync(file, await p.pdf({ preferCSSPageSize: true, printBackground: true }));
  await p.close();
  return { file, bg };
}
const pdfPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;

try {
  await page.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  for (const [k, v] of Object.entries(KINDS)) {
    const r = await put(RUN + '/' + k, v.body, k);
    if (!r.ok) throw new Error('seed ' + k + ': ' + r.status);
  }
  //  the app dark, so a light PDF is the export's doing
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await wait(() => !!window.latTabs && !!window.latShell, 90000);
  check('pdf.js is not loaded at boot', !(await page.evaluate(() => !!window.LatPdf)));

  for (const [k, v] of Object.entries(KINDS)) {
    const name = RUN + '/' + k;
    const r = await viaMenu(name);
    check(k + ': Export PDF in the page menu prints a frame that runs no script',
      r.sandbox === 'allow-same-origin allow-modals', r.sandbox + ' / ' + r.status);
    const dom = await page.evaluate((h) => {
      const d = new DOMParser().parseFromString(h, 'text/html');
      return { text: d.body.textContent, title: d.title, scripts: d.querySelectorAll('script').length,
        handlers: [...d.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /^on/i.test(a.name))),
        imgs: [...d.querySelectorAll('img')].map((i) => i.getAttribute('src').slice(0, 30)),
        h1: (d.querySelector('h1') || {}).textContent || '' };
    }, r.html);
    check(k + ': the document has the page\'s text', v.text.every((t) => dom.text.includes(t)), dom.text.slice(0, 200));
    check(k + ': and a title', !!dom.title && dom.title !== 'PWNED', dom.title);
    if (v.title) check(k + ': the title heads the page', dom.h1 === k, dom.h1);
    check(k + ': no script and no handler in it', dom.scripts === 0 && !dom.handlers);
    check(k + ': none of the app\'s chrome', !CHROME.some((c) => r.html.includes(c)),
      CHROME.filter((c) => r.html.includes(c)).join(' '));
    if (dom.imgs.length) check(k + ': the ship\'s images go in as data', dom.imgs.every((s) => s.startsWith('data:')), dom.imgs.join(' '));
    const { file, bg } = await toPdf(k, r.html);
    if (k !== 'html') check(k + ': printed light on a dark system', bg === 'rgb(255, 255, 255)' || bg === 'rgba(0, 0, 0, 0)', bg);
    const buf = readFileSync(file);
    const n = POPPLER ? +(/Pages:\s+(\d+)/.exec(spawnSync('pdfinfo', [file]).stdout.toString()) || [])[1] : pdfPages(buf);
    check(k + ': the PDF has ' + v.pages + (v.pages > 1 ? '+' : '') + ' page(s)', v.pages > 1 ? n >= v.pages : n === v.pages, 'pages ' + n);
    if (POPPLER) {
      const txt = spawnSync('pdftotext', ['-layout', file, '-']).stdout.toString();
      check(k + ': its text is in the PDF', v.text.every((t) => txt.replace(/\s+/g, ' ').includes(t)), txt.slice(0, 160));
      check(k + ': and no app chrome text', !/Page menu|Edit or Read|No preview for this file/.test(txt));
      check(k + ': nor anything a page script wrote', !txt.includes('SCRIPT-RAN'));
      if (k === 'md') {
        //  the long code line wrapped: no line in the PDF is wider than the page
        const widest = Math.max(...txt.split('\n').map((l) => l.length));
        check('md: code wraps instead of running off the page', txt.includes('a_very_long_line') && widest < 140, 'widest ' + widest);
      }
      if (k === 'fodt') {
        const sz = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(spawnSync('pdfinfo', [file]).stdout.toString());
        check('fodt: the PDF is on the document\'s own paper (Letter)', sz && Math.round(+sz[1]) === 612 && Math.round(+sz[2]) === 792, sz && sz[0]);
      }
    }
    if (PNG) spawnSync('pdftoppm', ['-r', '50', '-png', '-l', '2', file, join(out, k)]);
  }

  const t = await viaTree(RUN + '/gmi');
  check('Export PDF in the files tree\'s menu exports that page', !!t && t.html.includes('Gemini capsule'), t && t.status);
  check('pdf.js loaded once used', await page.evaluate(() => !!window.LatPdf));
  //  the Writer document's own page, which the desktop passes to its print job
  const pg = await page.evaluate((h) => window.LatPdf.pageOf(new DOMParser().parseFromString(h, 'text/html'), true),
    (await viaMenu(RUN + '/fodt')).html);
  check('fodt: the desktop prints on the document\'s paper and margins', Math.abs(pg.width - 215.9) < 0.1
    && Math.abs(pg.height - 279.4) < 0.1 && Math.abs(pg.top - 20) < 0.1 && Math.abs(pg.left - 20) < 0.1, JSON.stringify(pg));

  //  the reader: its menu's export pdf, on a page and on an html page
  const ship = await shipName(env);
  for (const k of ['md', 'html']) await api('page-share?mode=urbit&name=' + encodeURIComponent(RUN + '/' + k), { method: 'POST' });
  for (const k of ['md', 'html']) {
    await page.goto(env.base + '/apps/lattice?url=' + encodeURIComponent('urb://' + ship + '/' + RUN + '/' + k),
      { waitUntil: 'load', timeout: 120000 });
    await page.click('#ham');
    const shown = await page.waitForSelector('#hampdf', { visible: true, timeout: 10000 }).then(() => true, () => false);
    check('reader ' + k + ': the menu offers export pdf', shown);
    if (!shown) continue;
    await page.click('#hampdf');
    await page.waitForFunction(() => {
      const f = document.querySelector('iframe[data-lat-pdf]');
      return f && f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.body
        && f.contentDocument.body.textContent.trim();
    }, { timeout: 120000 });
    const html = await page.evaluate(() => document.querySelector('iframe[data-lat-pdf]').srcdoc);
    check('reader ' + k + ': it exports the page', KINDS[k].text.every((t) => html.includes(t)));
    check('reader ' + k + ': and not the reader\'s bar', !/hammenu|omnirow|name="url"/.test(html));
    const { file } = await toPdf('reader-' + k, html);
    if (PNG) spawnSync('pdftoppm', ['-r', '50', '-png', '-l', '1', file, join(out, 'reader-' + k)]);
  }
} catch (e) {
  check('suite ran to the end', false, e.stack || String(e));
} finally {
  await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' }).catch(() => {});
  await browser.close();
  if (keep) console.log('  PDFs and PNGs in ' + out);
  else rmSync(out, { recursive: true, force: true });
}
check.done();
