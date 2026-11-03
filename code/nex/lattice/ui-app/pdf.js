/* pdf.js: Export PDF. Loaded on first use by the editor (ui-src/lattice/
 * 78-pdf.js) and the reader (app.hoon, +pdf-script), never at boot.
 *
 * LatPdf.save({ title, html, doc, writer }) lays a rendered page out for
 * print and hands it to the runtime:
 *   - the desktop app: export_pdf (desktop/src/pdf.rs) asks where to save,
 *     prints the document in a hidden window that runs no script and writes
 *     the PDF there;
 *   - a browser or a phone: a frame of its own, same origin so print() can be
 *     called, no allow-scripts so nothing in it runs, and the print dialog,
 *     where Save as PDF is one choice.
 * `html` is a fragment lattice rendered (md, gmi, text, tex, code), laid out
 * here with the title, or a whole document when `doc` is set (an html page,
 * a Writer document), which keeps its own look. Print is always light.
 * Answers { path } once saved, { cancelled } when the dialog was dismissed,
 * { printed } when the print dialog was opened.
 */
(function () {
  'use strict';
  if (window.LatPdf) return;

  //  margins where nothing says otherwise, in mm
  const MARGIN = 18;
  //  the page for lattice's own renders: light whatever the app's theme is,
  //  code that wraps instead of running off the page, images that fit, and
  //  headings kept with what follows them
  const BASE = '@page{margin:' + MARGIN + 'mm}'
    + ':root{color-scheme:light}'
    + 'html,body{background:#fff;color:#1a1a1a}'
    + 'body{margin:0;font:11pt/1.55 Georgia,"Times New Roman",serif}'
    + 'h1,h2,h3,h4,h5,h6{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.25;break-after:avoid;page-break-after:avoid}'
    + 'h1.lpt{font-size:20pt;margin:0 0 .8em}'
    + 'a{color:#1a5fb4}'
    + 'img,svg,video,canvas{max-width:100%;height:auto}'
    + 'img,figure,table,pre,blockquote,math[display=block]{break-inside:avoid;page-break-inside:avoid}'
    + 'pre,code,kbd,samp{font-family:ui-monospace,"DejaVu Sans Mono",Menlo,Consolas,monospace;font-size:9.5pt}'
    + 'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;border:1px solid #ddd;border-radius:4px;padding:.6em .8em}'
    + 'pre.text{font-family:inherit;font-size:inherit;background:none;border:0;padding:0}'
    + 'pre.code{break-inside:auto;page-break-inside:auto}'
    + ':not(pre)>code{background:#f1f1f1;padding:0 .2em;border-radius:3px}'
    + 'blockquote{margin:1em 0;padding:0 1em;border-left:3px solid #ccc;color:#444}'
    + 'table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #bbb;padding:.3em .5em;vertical-align:top}'
    + 'hr{border:0;border-top:1px solid #ccc}'
    //  Prism's tokens, on a light page
    + '.token.comment,.token.prolog,.token.doctype,.token.cdata{color:#6a737d}'
    + '.token.keyword,.token.atrule,.token.important,.token.selector{color:#a626a4}'
    + '.token.string,.token.char,.token.attr-value,.token.regex,.token.inserted{color:#50a14f}'
    + '.token.number,.token.boolean,.token.constant,.token.symbol{color:#986801}'
    + '.token.function,.token.class-name{color:#4078f2}'
    + '.token.tag,.token.property,.token.deleted{color:#e45649}'
    + '.token.operator,.token.punctuation{color:#383a42}';
  //  what an html page or a Writer document keeps of the above: light,
  //  and nothing wider than the page
  const FIX = ':root{color-scheme:light}img,svg,video{max-width:100%;height:auto}'
    + 'pre{white-space:pre-wrap;overflow-wrap:anywhere}';

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const style = (d, css) => { const s = d.createElement('style'); s.textContent = css; return s; };

  //  The document, parsed inertly: DOMParser runs no script and loads
  //  nothing, so a page's own markup is safe to work on here.
  function compose(o) {
    const P = new DOMParser();
    if (!o.doc) {
      const d = P.parseFromString('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', 'text/html');
      d.head.append(style(d, BASE));
      d.body.innerHTML = o.html;
      //  the title, unless the page opens with its own heading
      const first = d.body.firstElementChild;
      if (!first || first.tagName !== 'H1') {
        const h = d.createElement('h1');
        h.className = 'lpt';
        h.textContent = o.title;
        d.body.prepend(h);
      }
      return d;
    }
    const d = P.parseFromString(String(o.html), 'text/html');
    //  first, so the document's own @page and rules win over it
    d.head.prepend(style(d, (o.writer ? '' : '@page{margin:' + MARGIN + 'mm}') + FIX));
    return d;
  }

  const same = (u) => u.origin === location.origin;
  const dataUrl = (blob) => new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = no;
    r.readAsDataURL(blob);
  });
  //  Self-contained: the ship's images and stylesheets go in as data, since
  //  neither the desktop's print window nor a print frame carries the
  //  session, and every other link is made absolute. Scripts go: nothing
  //  here would run them, and a PDF has no use for them.
  async function inline(d) {
    const base = location.href;
    const abs = (v) => { try { return new URL(v, base); } catch { return null; } };
    d.querySelectorAll('script,base,meta[http-equiv]').forEach((e) => e.remove());
    for (const e of d.querySelectorAll('*')) {
      for (const a of [...e.attributes]) if (/^on/i.test(a.name)) e.removeAttribute(a.name);
    }
    for (const a of d.querySelectorAll('a[href]')) {
      const u = abs(a.getAttribute('href'));
      if (u && !a.getAttribute('href').startsWith('#')) a.setAttribute('href', u.href);
    }
    const jobs = [];
    for (const img of d.querySelectorAll('img[src]')) {
      img.removeAttribute('srcset');
      img.removeAttribute('loading');
      const u = abs(img.getAttribute('src'));
      if (!u || u.protocol === 'data:') continue;
      img.setAttribute('src', u.href);
      if (!same(u)) continue;
      jobs.push(fetch(u.href, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => (b ? dataUrl(b) : null))
        .then((v) => { if (v) img.setAttribute('src', v); })
        .catch(() => {}));
    }
    for (const l of d.querySelectorAll('link[rel~=stylesheet][href]')) {
      const u = abs(l.getAttribute('href'));
      if (!u) { l.remove(); continue; }
      if (!same(u)) { l.setAttribute('href', u.href); continue; }
      jobs.push(fetch(u.href, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((t) => { l.replaceWith(style(d, t)); })
        .catch(() => l.remove()));
    }
    await Promise.all(jobs);
  }

  //  a CSS length in mm, or null
  const MMPER = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 };
  const mm = (v) => {
    const m = /^(-?[\d.]+)(mm|cm|in|pt|pc|px)?$/.exec(String(v).trim());
    return m ? +m[1] * MMPER[m[2] || 'px'] : null;
  };
  const PAPER = { a4: [210, 297], a5: [148, 210], a3: [297, 420], letter: [215.9, 279.4], legal: [215.9, 355.6] };
  //  The page the desktop prints on, in mm. WebKitGTK takes the size and
  //  the margins from the print job, not from @page, so a Writer
  //  document's own page (print.js in writer.js writes it as the first
  //  @page) is read back here. Size null: the system's default paper.
  function pageOf(d, writer) {
    const out = { width: null, height: null, top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN };
    if (!writer) return out;
    const css = [...d.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    const at = /@page\s*\{([^}]*)\}/.exec(css);
    if (!at) return out;
    const prop = (n) => { const m = new RegExp('(?:^|;)\\s*' + n + '\\s*:([^;]+)').exec(at[1]); return m ? m[1].trim() : null; };
    const size = prop('size');
    if (size) {
      const p = size.toLowerCase().split(/\s+/);
      const named = PAPER[p[0]];
      const wh = named ? (p[1] === 'landscape' ? [named[1], named[0]] : named) : [mm(p[0]), mm(p[1])];
      if (wh[0] > 0 && wh[1] > 0) { out.width = wh[0]; out.height = wh[1]; }
    }
    const mg = prop('margin');
    if (mg) {
      const v = mg.split(/\s+/).map(mm);
      if (v.every((x) => x !== null && x >= 0)) {
        const [t, r = t, b = t, l = r] = v;
        Object.assign(out, { top: t, right: r, bottom: b, left: l });
      }
    }
    return out;
  }

  //  a filename from the title: no path separators, no control characters
  const fileName = (t) => (String(t).replace(/[\u0000-\u001f/\\:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'page') + '.pdf';

  //  the browser path, as the Writer's print button does it (print.js)
  function framePrint(html) {
    for (const f of document.querySelectorAll('iframe[data-lat-pdf]')) f.remove();
    const f = document.createElement('iframe');
    f.setAttribute('data-lat-pdf', '');
    f.setAttribute('sandbox', 'allow-same-origin allow-modals');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('tabindex', '-1');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    return new Promise((ok) => {
      f.onload = () => {
        const w = f.contentWindow;
        const go = () => { try { w.focus(); w.print(); } catch {} ok({ printed: true }); };
        //  fonts first, or the first page prints in the fallback face
        (w.document.fonts && w.document.fonts.ready ? w.document.fonts.ready : Promise.resolve()).then(go, go);
      };
      f.srcdoc = html;
      document.body.append(f);
    });
  }

  async function save(o) {
    const d = compose(o);
    let t = d.querySelector('title');
    if (!t) { t = d.createElement('title'); d.head.prepend(t); }
    if (!t.textContent.trim()) t.textContent = o.title;
    await inline(d);
    const rust = window.__TAURI__ && window.__TAURI__.core;
    if (rust) {
      const page = pageOf(d, o.writer);
      //  the job carries the margins (pageOf), so @page must not add its own
      //  on an engine that does read it
      d.head.append(style(d, '@page{margin:0}'));
      const html = '<!doctype html>' + d.documentElement.outerHTML;
      try {
        const path = await rust.invoke('export_pdf', { html, name: fileName(o.title), page });
        return path ? { path } : { cancelled: true };
      } catch (e) {
        //  an app from before export_pdf: the print dialog still works
        if (!/not allowed|not found|unknown command/i.test(String(e))) throw e;
        d.head.lastChild.remove();
      }
    }
    return framePrint('<!doctype html>' + d.documentElement.outerHTML);
  }

  window.LatPdf = Object.freeze({ save, pageOf, compose, fileName });
})();
