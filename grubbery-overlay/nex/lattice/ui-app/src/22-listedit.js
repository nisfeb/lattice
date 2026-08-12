  // ── smart list continuation ──────────────────────────────────────────────
  // Pure on purpose. It takes the text and the selection and returns the edit
  // to apply, touching no DOM, so the fiddly parts (nesting, mixed markers,
  // renumbering) are unit tested by scripts/ui-listedit.mjs in milliseconds
  // with no browser and no ship. The editor's keydown handler is the only
  // place that knows about textareas.
  //
  // Returns null when Enter should do its ordinary thing. Otherwise
  // {from, to, text, caret}: replace [from, to) with text, then put the caret
  // at `caret`.
  const listEnter = (value, selStart, selEnd, flavor) => {
    const TAB = 4;
    const width = (s) => s.replace(/\t/g, ' '.repeat(TAB)).length;
    // indent, then either a bullet or a number+delimiter, then the gap, then
    // an optional task box. Kept in one place: every scan below reuses it.
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
    const parse = (ln) => {
      const m = ln.match(ITEM);
      if (!m) return null;
      return {
        len: m[0].length, indent: m[1], bullet: m[2] || '',
        num: m[3] ? parseInt(m[3], 10) : null, delim: m[4] || '',
        gap: m[5], task: m[6] || '', w: width(m[1]),
      };
    };
    // A fenced block is literal text: a "- " in a shell snippet is not a list.
    // In gemtext ``` toggles a preformatted block, which is the same rule.
    const before = value.slice(0, selStart);
    const fences = before.match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    // Gemtext is not markdown with fewer features, it is a different grammar.
    // Its ONLY list form is "* " at the very start of a line: no ordered
    // lists, no nesting, and leading whitespace makes a line ordinary text.
    // Continuing markdown markers here would write "- " and "2." that gemtext
    // renders as literal characters, so it gets its own small rule set.
    if (flavor === 'gmi') {
      const gLineStart = before.lastIndexOf('\n') + 1;
      let gLineEnd = value.indexOf('\n', selEnd);
      if (gLineEnd === -1) gLineEnd = value.length;
      const g = value.slice(gLineStart, gLineEnd).match(/^\* +/);
      if (!g) return null;
      if (selStart < gLineStart + g[0].length) return null;   // caret in the marker
      if (!value.slice(gLineStart, gLineEnd).slice(g[0].length).trim()) {
        return { from: gLineStart, to: gLineEnd, text: '', caret: gLineStart };
      }
      const gText = '\n' + g[0];
      return { from: selStart, to: selEnd, text: gText, caret: selStart + gText.length };
    }

    const lineStart = before.lastIndexOf('\n') + 1;
    let lineEnd = value.indexOf('\n', selEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const cur = parse(value.slice(lineStart, lineEnd));
    if (!cur) return null;
    // Caret inside the marker itself, including at the very start of the line.
    // Enter there pushes the item down and leaves it intact, which is what
    // every editor does. Continuing would emit a second marker ("- - one") or
    // split the marker in half ("1" / "2. . one").
    if (selStart < lineStart + cur.len) return null;

    const lines = value.split('\n');
    // index of the line the caret sits on, by counting newlines before it
    const curIdx = before.split('\n').length - 1;

    // How far this list block reaches. A blank line does not end it (loose
    // lists have them), nor does a deeper-indented continuation. A line at or
    // left of our indent that is not an item does.
    let lastIdx = curIdx;
    for (let i = curIdx + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) continue;                 // blank: might be a loose list
      const p = parse(ln);
      const lead = width(ln.match(/^[ \t]*/)[0]);
      if (!p && lead <= cur.w) break;           // ordinary paragraph, list over
      if (p && p.w < cur.w) break;              // stepped out to a parent level
      lastIdx = i;
    }

    // ── an item with nothing in it: Enter leaves the list ─────────────────
    const content = value.slice(lineStart, lineEnd).slice(cur.len);
    if (!content.trim()) {
      // Nested, so step out one level instead of dropping the list entirely.
      // The parent's own marker decides what we become, which is what makes a
      // mixed list (numbers outside, dashes inside) walk back up correctly.
      for (let i = curIdx - 1; i >= 0 && cur.w > 0; i--) {
        const p = parse(lines[i]);
        if (!p || p.w >= cur.w) continue;
        const marker = p.bullet
          ? p.bullet + ' '
          : String((p.num || 0) + 1) + p.delim + ' ';
        const text = p.indent + marker + (p.task ? '[ ] ' : '');
        return { from: lineStart, to: lineEnd, text, caret: lineStart + text.length };
      }
      // top level: clear the marker and end the list
      return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
    }

    // ── continue the list ─────────────────────────────────────────────────
    if (cur.bullet) {
      // Unordered needs no bookkeeping: same bullet, same indent. A task item
      // continues as an UNCHECKED box, never inheriting the tick.
      const text = '\n' + cur.indent + cur.bullet + cur.gap + (cur.task ? '[ ] ' : '');
      return { from: selStart, to: selEnd, text, caret: selStart + text.length };
    }

    // Ordered. Collect this level's siblings inside the block so we can tell
    // sequential numbering from the "all 1." style, which is valid markdown
    // and must not be silently rewritten into 1, 2, 3.
    const sibs = [];
    for (let i = curIdx; i >= 0; i--) {
      const p = parse(lines[i]);
      if (!p) { if (lines[i].trim() && width(lines[i].match(/^[ \t]*/)[0]) <= cur.w) break; continue; }
      if (p.w < cur.w) break;
      if (p.w === cur.w) { if (!p.num) break; sibs.unshift(p.num); }
    }
    for (let i = curIdx + 1; i <= lastIdx; i++) {
      const p = parse(lines[i]);
      if (!p) continue;
      if (p.w === cur.w) { if (!p.num) break; sibs.push(p.num); }
    }
    const lazy = sibs.length > 1 && sibs.every((n) => n === sibs[0]);
    const nextNum = lazy ? cur.num : cur.num + 1;
    const marker = cur.indent + nextNum + cur.delim + cur.gap + (cur.task ? '[ ] ' : '');

    // Everything from the caret to the end of the block gets rewritten in one
    // edit: the text after the caret becomes the new item's content, and the
    // items below it shift up by one. One replacement means one undo step.
    // The replaced region must cover the whole selection AND the rest of the
    // block. A selection reaching past the last item would otherwise be
    // clamped to the block, leaving the part below it alive: the user's
    // selection came back after being typed over.
    const blockEnd = Math.max(selEnd, lines.slice(0, lastIdx + 1).join('\n').length);
    const tail = value.slice(selEnd, blockEnd).split('\n');
    if (!lazy) {
      let n = nextNum;
      for (let i = 1; i < tail.length; i++) {
        const p = parse(tail[i]);
        if (!p) continue;
        if (p.w < cur.w) break;
        if (p.w > cur.w) continue;              // a sub-list numbers itself
        if (!p.num) break;                      // marker changed, new list
        n += 1;
        tail[i] = p.indent + n + p.delim + p.gap + p.task + tail[i].slice(p.len);
      }
    }
    const text = '\n' + marker + tail.join('\n');
    return { from: selStart, to: blockEnd, text, caret: selStart + 1 + marker.length };
  };

  // ── indent / outdent a list item ─────────────────────────────────────────
  // Tab on a list line moves it a level deeper; Shift-Tab a level out. Same
  // contract as listEnter: pure, returns {from, to, text, caret} or null for
  // "not a list edit — let Tab do its ordinary thing". A selection spanning
  // several lines moves every LIST line in it together, which is what makes
  // reshaping a pasted outline a two-keystroke job.
  //
  // One level is TWO SPACES, because that is what the local renderer counts
  // (59-md.js: depth = floor(indent/2) + 1). A tab character is one level of
  // its own on the way out.
  const listTab = (value, selStart, selEnd, flavor, dir) => {
    // gemtext has no nesting: "* " at column zero is the whole grammar, and
    // an indented line is ordinary text. Tab must stay a plain tab there.
    if (flavor === 'gmi') return null;
    const ITEM = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)/;
    const lineStart = value.slice(0, selStart).lastIndexOf('\n') + 1;
    // fenced code is literal text (the same rule listEnter applies): a Tab
    // inside a fence is indentation for CODE, not for a list that is not one.
    // Parity is counted up to LINE start, not caret: this is a line
    // operation, so the question is whether the line begins inside a fence —
    // and a caret-relative count changed its answer between an indent and
    // the outdent that undoes it when the line itself opens with a fence
    // marker (found by the round-trip property, seed 1105911052).
    const fences = value.slice(0, lineStart).match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

    let spanEnd = value.indexOf('\n', Math.max(selEnd, selStart));
    if (spanEnd === -1) spanEnd = value.length;
    const span = value.slice(lineStart, spanEnd).split('\n');

    // only item lines move; a selection that contains none is not a list edit
    if (!span.some((ln) => ITEM.test(ln))) return null;

    let firstDelta = 0;   // how the FIRST line's start moved, for the caret
    const out = span.map((ln, i) => {
      if (!ITEM.test(ln)) return ln;
      if (dir > 0) {
        if (i === 0) firstDelta = 2;
        return '  ' + ln;
      }
      // outdent: one tab is one level; otherwise up to two spaces
      const cut = ln.startsWith('\t') ? 1 : Math.min(2, (ln.match(/^ */) || [''])[0].length);
      if (i === 0) firstDelta = -cut;
      return ln.slice(cut);
    });
    const text = out.join('\n');
    if (text === value.slice(lineStart, spanEnd)) return null;   // nothing to take out

    if (selStart === selEnd) {
      // keep the caret on the same character it was on, clamped to its line
      const caret = Math.max(lineStart, selStart + firstDelta);
      return { from: lineStart, to: spanEnd, text, caret };
    }
    // a multi-line selection stays a selection over the moved lines
    return { from: lineStart, to: spanEnd, text, caret: lineStart, caretEnd: lineStart + text.length };
  };
