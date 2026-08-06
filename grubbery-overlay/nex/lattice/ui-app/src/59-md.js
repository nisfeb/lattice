  // ── local markdown, for the live preview only ────────────────────────────
  // The preview POSTs the whole document to the ship and shows what comes
  // back. That is the source-of-truth renderer, which is why it was built that
  // way, and it costs a pier round trip EVERY time you stop typing. Measured
  // against a real ship: 1.36s for an eight byte document and 3.0s for 106 KB.
  // The floor is the pier, not the rendering, so no server-side work fixes it.
  //
  // So: paint this immediately, then let the server's answer replace it when it
  // lands. That ordering is what makes a hand-written renderer acceptable here.
  // It does not have to be perfect or complete, because anything it gets wrong
  // is corrected within a second by the renderer that actually defines the
  // page. It only has to be fast and safe.
  //
  // SAFE MATTERS MORE THAN COMPLETE. The preview iframe is not sandboxed, so
  // its srcdoc runs on the app's own origin. Pages are not all hand-written
  // either: the clipper archives arbitrary web pages. So every character of
  // document text is escaped and NO raw HTML is passed through. A note that
  // contains a <script> tag renders as the text of a script tag here. The
  // server render may choose differently; that is its call to make, and it
  // arrives a moment later.
  const mdEsc = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Only http(s) and in-page anchors become links. A javascript: or data: href
  // in a clipped page must not become a live link on our origin.
  const mdHref = (u) => {
    const s = String(u).trim();
    return /^(https?:\/\/|urb:\/\/|mailto:|#|\/)/i.test(s) ? mdEsc(s) : '';
  };

  // Code-span placeholders. The token must be UNFORGEABLE by document text:
  // a page that can write the token literally could otherwise smuggle content
  // past the escaper. The trick is that the token contains '&', which mdEsc
  // turns into '&amp;'. A token typed into the document is mangled by the
  // escaper and can never match the restore regex; the only intact tokens are
  // the ones the extractor mints AFTER escaping. Extraction runs on the
  // ESCAPED string: mdEsc does not touch backticks, so code spans are still
  // findable there and their contents are already escaped.
  const CD_RE = /&CD(\d+);/g;
  const mdInline = (t) => {
    let s = mdEsc(t);
    // code first: its (already-escaped) contents must not be re-processed for
    // emphasis. The token is minted now, after the escape, so it survives.
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      code.push(c);
      return '&CD' + (code.length - 1) + ';';
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, u) => {
      const h = mdHref(u);
      return h ? '<img alt="' + alt + '" src="' + h + '">' : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, txt, u) => {
      const h = mdHref(u);
      return h ? '<a href="' + h + '">' + txt + '</a>' : m;
    });
    //  wikilinks, which lattice writes a lot of. The target is a page name, so
    //  it is URI-encoded into the query — a name carrying &, = or quotes must
    //  not smuggle extra params or break out of the href.
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, tgt, label) => '<a href="'
        + mdHref('/apps/lattice/app?name=' + encodeURIComponent(tgt.trim())) + '">'
        + (label || tgt) + '</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    // restore code spans. They were escaped when the whole string was, so no
    // re-escape here (that would double-escape). Only extractor-minted tokens
    // match; a forged one was mangled to '&amp;CD…;' by the escaper.
    s = s.replace(CD_RE, (_, i) => '<code>' + code[+i] + '</code>');
    return s;
  };

  //  block level. Deliberately a subset: headings, rules, fences, quotes,
  //  lists (including task lists), tables, paragraphs.
  function mdToHtml(input) {
    const lines = String(input == null ? '' : input).split('\n');
    const out = [];
    let i = 0;
    const listStack = [];
    const closeLists = (toDepth) => {
      while (listStack.length > toDepth) out.push(listStack.pop() === 'ol' ? '</ol>' : '</ul>');
    };
    while (i < lines.length) {
      const ln = lines[i];

      const fence = ln.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        closeLists(0);
        const close = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].trimStart().startsWith(close)) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1;                                   // the closing fence
        out.push('<pre><code>' + mdEsc(body.join('\n')) + '</code></pre>');
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) {
        closeLists(0); out.push('<hr>'); i += 1; continue;
      }

      const h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists(0);
        const n = h[1].length;
        out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>');
        i += 1;
        continue;
      }

      if (/^\s*>\s?/.test(ln)) {
        closeLists(0);
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + mdToHtml(q.join('\n')) + '</blockquote>');
        continue;
      }

      //  a table needs a delimiter row under the header
      if (ln.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        closeLists(0);
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cells(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(cells(lines[i]));
          i += 1;
        }
        out.push('<table><thead><tr>'
          + head.map((c) => '<th>' + mdInline(c) + '</th>').join('')
          + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      const li = ln.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
      if (li) {
        const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2) + 1;
        const want = li[2] ? 'ul' : 'ol';
        while (listStack.length > depth) closeLists(listStack.length - 1);
        while (listStack.length < depth) {
          out.push(want === 'ol' ? '<ol>' : '<ul>');
          listStack.push(want);
        }
        let body = li[4];
        const task = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          body = '<input type="checkbox" disabled'
            + (task[1] === ' ' ? '' : ' checked') + '> ' + mdInline(task[2]);
        } else body = mdInline(body);
        out.push('<li>' + body + '</li>');
        i += 1;
        continue;
      }

      if (!ln.trim()) { closeLists(0); i += 1; continue; }

      //  paragraph: consume until a blank line or a block starter
      const para = [];
      while (i < lines.length && lines[i].trim()
             && !/^\s*(#{1,6}\s|>|```|~~~|-{3,}\s*$)/.test(lines[i])
             && !/^(\s*)(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      if (para.length) {
        closeLists(0);
        out.push('<p>' + mdInline(para.join('\n')) + '</p>');
      } else i += 1;
    }
    closeLists(0);
    return out.join('\n');
  }

  // ── local gemtext, for the live preview only ────────────────────────────
  // Mirrors the ship's render-gmi (app.hoon) so the local paint matches the
  // authoritative one it corrects to: ```-fenced pre, #/##/### headings,
  // => links, > quotes, blank lines dropped, everything else a paragraph.
  // Same safety contract as the markdown above: EVERY line is escaped, links
  // only for urb:// and http(s) (a javascript: => target renders as text).
  const gmiToHtml = (input) => {
    const out = [];
    let pre = null;
    for (const ln of String(input == null ? '' : input).split('\n')) {
      if (pre !== null) {
        if (ln.trimEnd() === '```') { out.push('<pre>' + mdEsc(pre) + '</pre>'); pre = null; }
        else pre = pre === '' ? ln : pre + '\n' + ln;
        continue;
      }
      if (ln.trimEnd() === '```') { pre = ''; continue; }
      const h = ln.match(/^(#{1,3}) (.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + mdEsc(h[2]) + '</h' + h[1].length + '>'); continue; }
      if (ln.startsWith('=> ')) {
        const rest = ln.slice(3).replace(/^\s+/, '');
        const sp = rest.indexOf(' ');
        const raw = sp < 0 ? rest : rest.slice(0, sp);
        const desc = mdEsc((sp < 0 ? rest : rest.slice(sp + 1)).replace(/^\s+/, ''));
        if (raw.startsWith('urb://'))
          out.push('<p><a href="/apps/lattice?url=' + mdEsc(raw) + '">' + desc + '</a></p>');
        else if (/^https?:\/\//.test(raw))
          out.push('<p><a href="' + mdEsc(raw) + '" target="_blank" rel="noopener noreferrer">' + desc + '</a></p>');
        else out.push('<p>' + desc + '</p>');
        continue;
      }
      if (ln.startsWith('> ')) { out.push('<blockquote>' + mdEsc(ln.slice(2)) + '</blockquote>'); continue; }
      if (!ln.trim()) continue;
      out.push('<p>' + mdEsc(ln) + '</p>');
    }
    if (pre !== null) out.push('<pre>' + mdEsc(pre) + '</pre>');
    return out.join('\n');
  };
