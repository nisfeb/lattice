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
  const listEnter = (value, selStart, selEnd) => {
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
    const before = value.slice(0, selStart);
    const fences = before.match(/^[ \t]*(?:```|~~~)/gm);
    if (fences && fences.length % 2 === 1) return null;

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
