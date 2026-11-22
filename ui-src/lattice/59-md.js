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
  // SAFE MATTERS MORE THAN COMPLETE. The preview iframe is sandboxed now,
  // but this render also feeds the outline and the PDF export, and a
  // sandbox is a second wall, not the first. Pages are not all hand-written
  // either: the clipper archives arbitrary web pages. So every character of
  // document text is escaped and NO raw HTML is passed through. A note that
  // contains a <script> tag renders as the text of a script tag here. The
  // server render may choose differently; that is its call to make, and it
  // arrives a moment later.
  const mdEsc = (t) => String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Undo mdEsc. Inline rendering escapes the WHOLE line first, so by the time
  // a URL is captured out of it the entities are already in: a link whose
  // query holds & arrived here as &amp;, and escaping again produced
  // &amp;amp;, which the browser hands back to the server as a literal
  // "&amp;". Wikilinks were worse than cosmetic — [[a&b]] encoded to
  // name=a%26amp%3Bb and opened a page that does not exist.
  //
  // Reverses mdEsc's order: & LAST, or "&amp;lt;" would decode twice.
  const mdUnesc = (t) => String(t)
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  // Only http(s) and in-page anchors become links. A javascript: or data: href
  // in a clipped page must not become a live link on our origin.
  const mdHref = (u) => {
    // decode, THEN test the scheme: "javascript&#58;" must not sneak past a
    // check run against still-escaped text, and then re-escape for the attr.
    const s = mdUnesc(u).trim();
    //  A browser reads a backslash in a path as a slash, so /\host is
    //  //host: another site, not a path on this ship.
    if (/^\/\\/.test(s)) return '';
    return /^(https?:\/\/|urb:\/\/|mailto:|#|\/)/i.test(s) ? mdEsc(s) : '';
  };
  // An image from another host (http(s) or //host) shows that host your
  // IP address, so it is drawn only on a page whose outside content you let
  // load (the reader's "Load outside content for this page"): mdOutside,
  // set by the preview for the page it paints. Otherwise it is a
  // placeholder, and mdBlocked tells the preview to offer the button.
  let mdOutside = false, mdBlocked = false;
  const OUTSIDE = 'latOutside';
  const outsideOn = (name) => {
    try { return !!name && JSON.parse(localStorage[OUTSIDE] || '[]').includes(name); } catch { return false; }
  };
  const outsideAllow = (name) => {
    try {
      const l = JSON.parse(localStorage[OUTSIDE] || '[]').filter((n) => n !== name);
      localStorage[OUTSIDE] = JSON.stringify([name, ...l].slice(0, 500));
    } catch {}
  };
  //  Either slash may be written as a backslash: the browser reads both.
  const remoteUrl = (u) => /^(https?:)?[\/\\]{2}/i.test(mdUnesc(u).trim());
  //  An image on this host whose address carries a query is a request to
  //  a route, and the browser loads an <img> as the page is drawn, with
  //  the reader's session: /apps/lattice/clip?url=.. made the ship fetch
  //  that url and file a page. Such an image is drawn as a link. Only the
  //  bare ?data of a file's raw view still draws, and allowing outside
  //  content does not lift it. The ship's +route-url and +safe-img
  //  (code/lib/lattice-md.hoon).
  const routeUrl = (u) => {
    const s = mdUnesc(u), q = s.indexOf('?');
    return q >= 0 && s.slice(q + 1) !== 'data';
  };

  // The test for a wikilink to a page not written yet (ghostTest,
  // 60-preview.js). Only the live preview sets it, around its own paint:
  // the PDF, the Skills pane and a parked split's Read mark nothing.
  let mdGhosts = null;

  // Code-span placeholders. The token must be UNFORGEABLE by document text:
  // a page that can write the token literally could otherwise smuggle content
  // past the escaper. The trick is that the token contains '&', which mdEsc
  // turns into '&amp;'. A token typed into the document is mangled by the
  // escaper and can never match the restore regex; the only intact tokens are
  // the ones the extractor mints AFTER escaping. Extraction runs on the
  // ESCAPED string: mdEsc does not touch backticks, so code spans are still
  // findable there and their contents are already escaped.
  const CD_RE = /&CD(\d+);/g;
  // Every unmatched "[" used to cost a scan of the rest of the paragraph,
  // and "[a](" that scan twice over, so a few KB of them held the tab for
  // a minute. Two rules bound it. A scan for a closing bracket stops at
  // the next opener of its own kind, so the scans of a paragraph do not
  // overlap and together cost one pass. And it gives up where the ship
  // does: +scan-cap and +link-scan-cap in code/lib/lattice-md.hoon. No
  // real link text is near either length. An address can be: signed
  // download links run to a few KB, so the paren bound is well past them.
  const SCAN = 2048, LSCAN = 4096;
  //  (url "title"): the paren must close within LSCAN, looked for once, so
  //  the two runs after it never walk further than that. The look stops at
  //  a "](" as well, so the looks of a run of "[a](" do not overlap.
  //  and the address never holds "](", the next link's opener (the ship's
  //  +find-stop)
  const PAREN = '\\((?=(?:[^)\\]]|\\](?!\\())' + '{0,' + LSCAN + '}\\))((?:[^)\\s\\]]|\\](?!\\())+)(?:\\s[^)]*)?\\)';
  //  an image's alt stops at the next "![", a link's text at the next "["
  const IMG_RE = new RegExp('!\\[((?:[^\\]!]|!(?!\\[)){0,' + SCAN + '})\\]' + PAREN, 'g');
  const LINK_RE = new RegExp('\\[([^\\]\\[]{1,' + SCAN + '})\\]' + PAREN, 'g');
  //  a wikilink's target and label stop at the next "[["
  const WIKI_RE = /\[\[((?:[^\]|[]|\[(?!\[))+)(?:\|((?:[^\][]|\[(?!\[))+))?\]\]/g;
  const NW = '[^\\w\\u0080-\\uffff]';
  const UBOLD_RE = new RegExp('(^|' + NW + ')__((?:[^_]|_(?!_))+)__(?=' + NW + '|$)', 'g');
  const UEM_RE = new RegExp('(^|' + NW + ')_([^_]+)_(?=' + NW + '|$)', 'g');
  const mdInline = (t) => {
    let s = mdEsc(t);
    // code first: its (already-escaped) contents must not be re-processed for
    // emphasis. The token is minted now, after the escape, so it survives.
    const code = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      code.push(c);
      return '&CD' + (code.length - 1) + ';';
    });
    //  the tags made here are tokens too, minted the same way: the passes
    //  after this one see only text. A link's text could otherwise start
    //  inside an image's alt and take its quotes, and a wikilink inside a
    //  URL rewrote the href: either put the URL in attribute position, as
    //  ![a[b](http://y) c](http://x/src/onerror=...//) did.
    const tags = [];
    const tag = (html) => { tags.push(html); return '&TG' + (tags.length - 1) + ';'; };
    s = s.replace(IMG_RE, (m, alt, u) => {
      if (remoteUrl(u) && !mdOutside) {
        mdBlocked = true;
        return tag('<span class="ximg">[image from another site' + (alt ? ': ' + alt : '') + ']</span>');
      }
      const h = mdHref(u);
      if (h && !remoteUrl(u) && routeUrl(u)) return tag('<a href="' + h + '">') + (alt || h) + '</a>';
      return h ? tag('<img alt="' + alt + '" src="' + h + '">') : m;
    });
    s = s.replace(LINK_RE, (m, txt, u) => {
      const h = mdHref(u);
      return h ? tag('<a href="' + h + '">') + txt + '</a>' : m;
    });
    //  wikilinks, which lattice writes a lot of. The target is a page name, so
    //  it is URI-encoded into the query — a name carrying &, = or quotes must
    //  not smuggle extra params or break out of the href.
    //  a bare [[a/b/c]] shows just the last segment ("c"), the filename people
    //  expect, not the whole path. An explicit [[a/b/c|label]] still wins. The
    //  href/target is unchanged, so navigation and backlinks are unaffected.
    //  A page not written yet is marked after the href, which outLinks
    //  (76-outline.js) reads first.
    s = s.replace(WIKI_RE, (_, tgt, label) => {
      const t = mdUnesc(tgt).trim();
      return tag('<a href="' + mdHref('/apps/lattice/app?name=' + encodeURIComponent(t)) + '"'
        + (mdGhosts && mdGhosts(t) ? ' class="ghost" title="' + mdEsc(t + ' does not exist yet') + '"' : '') + '>')
        + (label || tgt.trim().replace(/\/+$/, '').split('/').pop() || tgt) + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    //  underscores open and close only at a word's edge, and a character
    //  past ASCII is a word character, as on the ship: é_a_é is text
    s = s.replace(UBOLD_RE, '$1<strong>$2</strong>');
    s = s.replace(UEM_RE, '$1<em>$2</em>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    //  two or more spaces before a line end are a hard break, as on the
    //  ship. Code spans are still tokens here, so theirs are left alone.
    //  Line by line, with no pattern that walks a run of spaces from each
    //  of its positions.
    if (s.includes('  \n')) s = s.split('\n').map((l, i, a) => {
      if (i === a.length - 1 || !l.endsWith('  ')) return l;
      let e = l.length;
      while (l[e - 1] === ' ') e--;
      return l.slice(0, e) + '<br>';
    }).join('\n');
    // restore code spans. They were escaped when the whole string was, so no
    // re-escape here (that would double-escape). Only extractor-minted tokens
    // match; a forged one was mangled to '&amp;CD…;' by the escaper.
    s = s.replace(/&TG(\d+);/g, (_, i) => tags[+i]);
    s = s.replace(CD_RE, (_, i) => '<code>' + code[+i] + '</code>');
    return s;
  };

  //  block level. Deliberately a subset: headings, rules, fences, quotes,
  //  lists (including task lists), tables, paragraphs.
  //  tasks: live boxes, each with data-line, its source line (base: where
  //  this input starts, for a blockquote). Lines, not a count of boxes.
  //  A line's leading quote marks, held to 32 (the ship's +cap-quote-depth).
  //  Each level is one more pass over the quoted text and one more call
  //  deep, so a line of thousands of ">" overflowed the stack. Marks may
  //  have blanks between them. A line at or under the cap is not touched.
  //  Only a line read as a quote is capped, so a fence's lines are kept
  //  as they are.
  const QDEPTH = 32;
  const capQuote = (l) => {
    let n = 0, p = 0;
    for (;;) {
      let q = p;
      while (l[q] === ' ' || l[q] === '\t') q++;
      if (l[q] !== '>') break;
      p = q + 1; n++;
    }
    return n > QDEPTH ? '>'.repeat(QDEPTH) + l.slice(p) : l;
  };
  //  a table's delimiter row: only blanks, colons, pipes and dashes, with a
  //  pipe somewhere after the first character
  const tableSep = (l) => l.indexOf('|', 1) > 0 && /^[\s:|-]+$/.test(l);
  function mdToHtml(input, tasks, base = 0) {
    //  CRLF: `.` stops at \r, so "(.*)$" failed on every line
    const lines = String(input == null ? '' : input).split('\n').map((l) => l.replace(/\r$/, ''));
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
          q.push(capQuote(lines[i]).replace(/^\s*>\s?/, ''));
          i += 1;
        }
        out.push('<blockquote>' + mdToHtml(q.join('\n'), tasks, base + i - q.length) + '</blockquote>');
        continue;
      }

      //  a table needs a delimiter row under the header
      if (ln.includes('|') && i + 1 < lines.length && tableSep(lines[i + 1])) {
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
          body = '<input type="checkbox"' + (tasks ? ' data-line="' + (base + i) + '" data-h="' + lineHash(ln) + '"' : ' disabled')
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

  //  a task line's content hash, as painted and as found again at click
  //  time (taskFlip, 60-preview.js): the line with its quote marks and a
  //  CR taken off, through FNV-1a. A box drawn from text that has changed
  //  since (an edit, a refresh from the ship) no longer matches its line.
  const lineHash = (ln) => {
    let t = String(ln).replace(/\r$/, '');
    while (/^\s*>\s?/.test(t)) t = t.replace(/^\s*>\s?/, '');
    let h = 0x811c9dc5;
    for (let k = 0; k < t.length; k++) h = Math.imul(h ^ t.charCodeAt(k), 16777619) >>> 0;
    return h.toString(36);
  };
  const lineAt = (text, n) => String(text).split('\n')[n];
  //  a box click's edit: the offset of the char in the brackets on `line`,
  //  or null if that line is no task in the clicked-from state (stale)
  const TASK_RE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\](?=\s)/;
  const TASK_ANY = new RegExp(TASK_RE.source, 'm');
  const hasTask = (text) => typeof text === 'string' && TASK_ANY.test(text);
  function taskToggle(text, line, on) {
    let at = 0;
    for (let n = 0; n < line; n++) {
      at = text.indexOf('\n', at) + 1;
      if (!at) return null;
    }
    const end = text.indexOf('\n', at);
    const m = TASK_RE.exec(text.slice(at, end < 0 ? text.length : end));
    if (!m || (m[2] !== ' ') === !!on) return null;
    return { at: at + m[1].length, ch: on ? 'x' : ' ' };
  }

  // ── local gemtext, for the live preview only ────────────────────────────
  // Mirrors the ship's render-gmi (app.hoon) so the local paint matches the
  // authoritative one it corrects to: ```-fenced pre, #/##/### headings,
  // => links, > quotes, blank lines dropped, everything else a paragraph.
  // Same safety contract as the markdown above: EVERY line is escaped, links
  // only for urb:// and http(s) (a javascript: => target renders as text).
  const GMI_H = /^(#{1,3}) *(.*)$/;
  const gmiToHtml = (input) => {
    const out = [];
    let pre = null, list = false;
    for (const raw of String(input == null ? '' : input).split('\n')) {
      //  a CRLF document's CR is not content (the ship's +strip-cr)
      const ln = raw.replace(/\r$/, '');
      //  A fence is any line that starts with ```: the text after an
      //  opening one names a language. Matching the whole line left
      //  ```hoon as a paragraph, and the closing fence then opened a block
      //  over the rest of the document.
      if (pre !== null) {
        if (ln.startsWith('```')) { out.push('<pre>' + mdEsc(pre.join('\n')) + '</pre>'); pre = null; }
        else pre.push(ln);
        continue;
      }
      //  any line that is not a bullet closes an open list
      if (list && !ln.startsWith('* ')) { list = false; out.push('</ul>'); }
      if (ln.startsWith('```')) { pre = []; continue; }
      //  blanks after the hashes are optional, so #Heading is one
      const h = ln.match(GMI_H);
      if (h) { out.push('<h' + h[1].length + '>' + mdEsc(h[2]) + '</h' + h[1].length + '>'); continue; }
      //  a run of "* " lines is one list
      if (ln.startsWith('* ')) {
        if (!list) { list = true; out.push('<ul>'); }
        out.push('<li>' + mdEsc(ln.slice(2).replace(/^ +/, '')) + '</li>');
        continue;
      }
      //  a link line: "=>", optional blanks, the address up to the next
      //  space or tab, then the label. With no label it shows its address,
      //  and an arrow with nothing after it is a paragraph.
      const lk = ln.startsWith('=>') && ln.slice(2).replace(/^[ \t]+/, '');
      if (lk) {
        const sp = lk.search(/[ \t]/);
        const raw = sp < 0 ? lk : lk.slice(0, sp);
        const desc = mdEsc((sp < 0 ? '' : lk.slice(sp).replace(/^[ \t]+/, '')) || raw);
        if (raw.startsWith('urb://'))
          out.push('<p><a href="/apps/lattice?url=' + mdEsc(encodeURIComponent(raw)) + '">' + desc + '</a></p>');
        else if (/^https?:\/\//.test(raw))
          out.push('<p><a href="' + mdEsc(raw) + '" target="_blank" rel="noopener noreferrer">' + desc + '</a></p>');
        else out.push('<p>' + desc + '</p>');
        continue;
      }
      if (ln.startsWith('> ')) { out.push('<blockquote>' + mdEsc(ln.slice(2)) + '</blockquote>'); continue; }
      if (!ln.trim()) continue;
      out.push('<p>' + mdEsc(ln) + '</p>');
    }
    if (list) out.push('</ul>');
    if (pre !== null) out.push('<pre>' + mdEsc(pre.join('\n')) + '</pre>');
    return out.join('\n');
  };
