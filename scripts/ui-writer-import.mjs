#!/usr/bin/env node
//  ui-writer-import.mjs: Writer pages as text to the shell, and .odt in and
//  out of the browser (plan, Tasks 11 and 12), against a fake ship.
//
//    I: the right pane's outline lists a corpus file's headings and a click
//       puts the caret on one; Outgoing lists its safe link targets and no
//       javascript:, macro or file: one; the omnibar finds a body word, not
//       style-name, and its snippet is text, not XML
//    J: an .odt uploaded through the file picker becomes a fodt page that
//       opens in the editor; an .odt with pictures says what it left out;
//       the page edited in the editor, exported with the toolbar's .odt
//       button, is a STORED zip with mimetype first that LibreOffice reads
//       with the edit in it; Print builds a script-free frame whose CSS
//       carries the document's @page size and margins
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-writer-import.mjs
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uiwrimp-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, '..', 'tests', 'writer', 'corpus');
const corpus = (f) => readFileSync(join(corpusDir, f), 'utf8');
const check = makeCheck();
const tmp = mkdtempSync(join(tmpdir(), 'uiwrimp-'));
const P = { heads: RUN + '/heads', links: RUN + '/links', up: RUN + '/up', pics: RUN + '/pics' };
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
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
const wait = (fn, ...a) => page.waitForFunction(fn, { timeout: 60000 }, ...a);
const mounted = () => wait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc'));
async function open(name) {
  await page.evaluate((n) => window.latTabs.openIn('page', n), name);
  await wait((n) => document.getElementById('pname').value === n, name);
}
const srcVal = () => page.evaluate(() => document.getElementById('src').value);

let step = 'setup';
try {
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    localStorage.latWriterDraft = '1';
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  for (const [n, b] of [[P.heads, corpus('02-headings.fodt')], [P.links, corpus('05-links.fodt')]]) {
    const r = await put(n, b);
    if (!r.ok) throw new Error('seed ' + n + ': ' + r.status);
  }
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !!window.latTabs && !!window.latShell);

  // ------------------------------------------------------------ I
  step = 'I search';
  //  the omnibar first, on a cold page: writer.js is not loaded, so this is
  //  app.js's own extractor
  await page.evaluate(() => window.latShell.paneTab('l', 'search'));
  const search = async (q) => {
    await page.evaluate((v) => { const i = document.getElementById('qinput'); i.value = v; i.dispatchEvent(new Event('input')); }, q);
    await sleep(400);
    return waitFor(() => page.evaluate((run) => {
      const rows = [...document.querySelectorAll('#qlist li a')].filter((a) => a.querySelector('.qname').textContent.startsWith(run));
      const empty = document.getElementById('qlist').className === 'aclempty' && /nothing matches/.test(document.getElementById('qlist').textContent);
      return rows.length || empty ? rows.map((a) => ({ name: a.querySelector('.qname').textContent, snip: (a.querySelector('.qprev') || {}).textContent || '' })) : null;
    }, RUN), 30000, 300);
  };
  const loaded = await page.evaluate(() => !!window.LatWriter);
  const heading = /<text:h[^>]*>([^<]{4,})</.exec(corpus('02-headings.fodt'))[1].trim();
  const word = heading.split(/\s+/).find((w) => w.length >= 4) || heading;
  let hits = await search(word);
  check('I: before writer.js loads, the omnibar finds a Writer page by a body word', !loaded && (hits || []).some((h) => h.name === P.heads), JSON.stringify(hits));
  const snip = ((hits || []).find((h) => h.name === P.heads) || {}).snip || '';
  check('I: and its snippet is text, not XML', snip.includes(word) && !/[<>]|style-name|text:/.test(snip), snip);
  hits = await search('style-name');
  check('I: style-name does not find a Writer page', !(hits || []).some((h) => h.name === P.heads || h.name === P.links), JSON.stringify(hits));
  hits = await search('office:');
  check('I: nor does office:', !(hits || []).some((h) => h.name === P.heads || h.name === P.links), JSON.stringify(hits));

  step = 'I outline';
  await page.evaluate(() => window.latShell.paneTab('r', 'outline'));
  await open(P.heads);
  await mounted();
  const want = await page.evaluate((t) => window.LatWriter.extract.outline(t).map((h) => h.text), corpus('02-headings.fodt'));
  const rows = await waitFor(() => page.evaluate(() => {
    const r = [...document.querySelectorAll('#ollist a.olrow')].map((a) => a.textContent);
    return r.length ? r : null;
  }), 15000, 200);
  check('I: the outline lists the corpus file\'s headings', rows && want.length >= 6 && JSON.stringify(rows) === JSON.stringify(want.map((t) => t || '(untitled)')),
    JSON.stringify(rows) + ' vs ' + JSON.stringify(want));
  const last = want.length - 1;
  await page.evaluate((i) => document.querySelectorAll('#ollist a.olrow')[i].click(), last);
  await sleep(300);
  const at = await page.evaluate(() => {
    const s = getSelection();
    const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    const h = n && n.closest('h1,h2,h3,h4,h5,h6');
    return h ? h.textContent : null;
  });
  check('I: a click puts the caret in that heading', at === want[last], at + ' vs ' + want[last]);
  const before = await srcVal();
  await sleep(500);
  check('I: and changes nothing', (await srcVal()) === before);

  step = 'I outgoing';
  await page.evaluate(() => window.latShell.paneTab('r', 'out'));
  await open(P.links);
  await mounted();
  const outs = await waitFor(() => page.evaluate(() => {
    const r = [...document.querySelectorAll('#outlist a.olrow')].map((a) => ({ t: a.textContent, href: a.getAttribute('href') || '' }));
    return r.length ? r : null;
  }), 15000, 200);
  const ts = (outs || []).map((o) => o.t);
  check('I: Outgoing lists the http and mailto targets', ts.some((t) => /^https?:/.test(t)) && ts.some((t) => /^mailto:/.test(t)), JSON.stringify(ts));
  check('I: and no javascript:, macro, file: or in-page target', !(outs || []).some((o) => /^\s*(javascript|vnd\.sun\.star\.script|macro|file|data):|^#/i.test(o.t)
    || /^\s*(javascript|vnd|macro|file|data):/i.test(o.href)), JSON.stringify(outs));
  check('I: each target once', new Set(ts).size === ts.length);

  // ------------------------------------------------------------ J
  step = 'J upload';
  const odtPath = join(tmp, 'up.odt');
  writeFileSync(odtPath, readFileSync(join(corpusDir, '01-paragraphs.odt')));
  const picsPath = join(tmp, 'pics.odt');
  writeFileSync(picsPath, readFileSync(join(corpusDir, '01-paragraphs.odt')));
  execFileSync('python3', ['-I', '-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'a')
z.writestr('Pictures/cat.png', b'fake')
z.close()`, picsPath]);
  const input = await page.$('#fpick');
  //  the uploader files into the folder of the page in front, RUN
  await input.uploadFile(odtPath, picsPath);
  const upDone = await waitFor(() => page.evaluate(() => /uploaded|done/.test(document.getElementById('upmsg').textContent)
    ? { msg: document.getElementById('upmsg').textContent, err: document.getElementById('uperr').textContent } : null), 60000, 300);
  check('J: two .odt files upload', upDone && /uploaded 2 files/.test(upDone.msg), JSON.stringify(upDone));
  check('J: the one with pictures says what it left out', upDone && /pics: left out 1 picture \(cat\.png\)/.test(upDone.err), upDone && upDone.err);
  check('J: the other has no note', upDone && !/\/up: /.test(upDone.err), upDone && upDone.err);
  const sb = await waitFor(() => shipBody(P.up), 20000, 500);
  const dump = sb ? null : await (await api('page-dump', { cache: 'no-store' })).json();
  check('J: it is a fodt page on the ship', sb && sb.kind === 'fodt' && /<office:document[\s>]/.test(sb.body || ''),
    sb ? JSON.stringify(sb).slice(0, 200) : JSON.stringify(dump.nodes.filter((x) => /up|pics/.test(x.path)).map((x) => x.path + ':' + x.kind)));

  step = 'J edit and export';
  await open(P.up);
  await mounted();
  const ok = await page.evaluate(() => {
    const doc = document.querySelector('lat-writer .lw-doc');
    const walk = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.data.indexOf('The last paragraph.');
      if (i < 0) continue;
      doc.focus();
      const r = document.createRange();
      r.setStart(n, i + 19); r.collapse(true);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      return true;
    }
    return false;
  });
  check('J: the imported page opens in the editor with its text', ok);
  await sleep(150);
  await page.keyboard.type(' Exported from lattice.');
  await waitFor(async () => (await srcVal()).includes('Exported from lattice.'), 5000, 100);
  //  catch the download in the page
  await page.evaluate(() => {
    window.__dl = null;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        const name = this.download;
        fetch(this.href).then((r) => r.arrayBuffer()).then((b) => {
          let s = '';
          const u = new Uint8Array(b);
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
          window.__dl = { name, b64: btoa(s) };
        });
        return;
      }
      return click.call(this);
    };
  });
  const clicked = await page.evaluate(() => { const b = document.querySelector('lat-writer .lw-bar [data-lw="odt"]'); if (!b) return false; b.click(); return true; });
  check('J: the toolbar has Export .odt', clicked);
  const dl = await waitFor(() => page.evaluate(() => window.__dl), 15000, 200);
  check('J: it downloads <page>.odt', dl && dl.name === 'up.odt', dl && dl.name);
  if (dl) {
    const z = Buffer.from(dl.b64, 'base64');
    check('J: the export is a zip whose first entry is a STORED mimetype',
      z.readUInt32LE(0) === 0x04034b50 && z.readUInt16LE(8) === 0 && z.toString('latin1', 30, 38) === 'mimetype'
      && z.toString('latin1', 38, 77) === 'application/vnd.oasis.opendocument.text');
    const soffice = ['soffice', 'libreoffice'].find((c) => spawnSync('which', [c]).status === 0);
    if (!soffice) console.log('  skip - LibreOffice reads the export: soffice is not on PATH');
    else {
      writeFileSync(join(tmp, 'up.odt'), z);
      execFileSync(soffice, [`-env:UserInstallation=file://${join(tmp, 'profile')}`, '--headless', '--norestore',
        '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', join(tmp, 'txt'), join(tmp, 'up.odt')], { stdio: 'ignore', timeout: 300000 });
      let txt = '';
      try { txt = readFileSync(join(tmp, 'txt', 'up.txt'), 'utf8'); } catch {}
      check('J: LibreOffice reads the exported .odt, with the edit', txt.includes('The last paragraph. Exported from lattice.'), txt.slice(0, 200));
    }
  }

  step = 'J print';
  await page.evaluate(() => { document.querySelector('lat-writer .lw-bar [data-lw="print"]').click(); });
  const pf = await waitFor(() => page.evaluate(() => {
    const f = document.querySelector('iframe[data-lw-print]');
    return f ? { sandbox: f.getAttribute('sandbox'), doc: f.srcdoc } : null;
  }), 10000, 100);
  check('J: Print builds a frame of its own', !!pf);
  check('J: which runs no script', pf && !/allow-scripts/.test(pf.sandbox) && !/<script/i.test(pf.doc), pf && pf.sandbox);
  const lay = /<style:page-layout-properties[^>]*fo:page-width="([^"]+)"[^>]*fo:page-height="([^"]+)"/.exec(corpus('01-paragraphs.fodt'));
  check('J: with the document\'s @page size and margins', pf && lay && pf.doc.includes('@page{size:' + lay[1] + ' ' + lay[2] + ';margin:'), pf && (pf.doc.match(/@page\{[^}]*\}/) || [''])[0]);
  check('J: and the edit in it', pf && pf.doc.includes('Exported from lattice.'));
} catch (e) {
  check('suite crashed at ' + step + ': ' + e.message, false);
} finally {
  await browser.close().catch(() => {});
  for (const n of [...Object.values(P), RUN])
    await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' }).catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
check.done();
