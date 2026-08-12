#!/usr/bin/env node
// Property tests for the browser UI's pure functions (ui-app/src/*.js).
//
// The example-based suites (ui-listedit.mjs, ui-shortpath.mjs) pin the cases
// someone thought of. This one pins the cases nobody thought of: fast-check
// generates documents, carets, path lists and names by the thousand and
// checks the CONTRACTS instead of the outputs. A contract is the sort of
// thing that is boring to state and expensive to break:
//
//   listEnter  - never throws, never returns a range outside the document,
//                never loses text outside the range it replaces
//   shortPath  - no two grants in one list ever render as the same string
//   esc        - the output can never open a tag
//   seg        - an uploaded filename can never grow a path separator
//   acRank     - the dropdown only ever offers pages that match what you typed
//
// Sources are read and evaluated straight out of ui-app/src, the same idiom
// as scripts/ui-listedit.mjs, so this needs no browser and no ship.
//
// Usage:  node scripts/ui-props.mjs
// Setup:  npm i --no-save fast-check     (nothing is added to a manifest)

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fc;
try { fc = (await import('fast-check')).default; }
catch { console.error('fast-check missing: npm i --no-save fast-check'); process.exit(2); }

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, '../grubbery-overlay/nex/lattice/ui-app/src', f), 'utf8');
const cut = (file, re, what) => {
  const m = read(file).match(re);
  if (!m) { console.error(`could not find ${what} in ${file}`); process.exit(2); }
  return m[0];
};

// ── the functions under test, lifted out of the source ─────────────────────
const listEnter = new Function(`${read('22-listedit.js')}\nreturn listEnter;`)();
const listTab = new Function(`${read('22-listedit.js')}\nreturn listTab;`)();
const shortPath = new Function(
  `${cut('10-shell.js', /const shortPath = \([\s\S]*?\n {2}\};/, 'shortPath')}\nreturn shortPath;`)();
const esc = new Function(
  `${cut('25-editor.js', /const esc = .*/, 'esc')}\nreturn esc;`)();
const seg = new Function(
  `${cut('70-upload.js', /const seg = .*/, 'seg')}\nreturn seg;`)();
const mkAcRank = new Function('nodes', 'current', 'folderCtx',
  cut('55-autocomplete.js', /const dirOf = .*\n\s*const segOf = .*/, 'dirOf/segOf') + '\n'
  + cut('55-autocomplete.js', /function acRank\(q\) \{[\s\S]*?\n {2}\}/, 'acRank')
  + '\nreturn acRank;');

// ── harness ────────────────────────────────────────────────────────────────
let fails = 0, props = 0;
const RUNS = Number(process.env.RUNS || 2000);   // RUNS=50000 for a deep hunt
const prop = (name, property, runs = RUNS) => {
  props++;
  try {
    fc.assert(property, { numRuns: runs, verbose: false });
    console.log('  ok   - ' + name);
  } catch (e) {
    fails++;
    console.log('  FAIL - ' + name);
    console.log(String(e.message).split('\n').map((l) => '         ' + l).join('\n'));
  }
};
const ok = (name, cond, detail) => {
  props++;
  if (cond) console.log('  ok   - ' + name);
  else { console.log('  FAIL - ' + name + (detail ? ' (' + detail + ')' : '')); fails++; }
};

// ═══ listEnter (22-listedit.js) ════════════════════════════════════════════
// Documents that look like the ones people actually type, mixed with hostile
// noise. A generator of pure random strings almost never produces a list
// item, so it would exercise only the "return null" path.
const MARKERS = ['- ', '* ', '+ ', '1. ', '2) ', '9. ', '99. ', '0. ', '1.   ',
  '  - ', '    - ', '\t- ', '   1. ', '  1) ', '- [ ] ', '- [x] ', '- [X] ',
  '1. [ ] ', '1. [x] ', '> - ', '', '', '#  ', '```', '~~~', '=> urb://~zod/x ',
  '-', '1 ', '---', '  '];
const TEXTS = ['', 'one', 'two words', 'x', '   ', 'a/b', 'é中', '- ', '1. ',
  '[[link]]', '\\', '&<>'];
const lineArb = fc.tuple(fc.constantFrom(...MARKERS), fc.constantFrom(...TEXTS))
  .map(([m, t]) => m + t);
const docArb = fc.oneof(
  { arbitrary: fc.array(lineArb, { maxLength: 9 }).map((ls) => ls.join('\n')), weight: 6 },
  { arbitrary: fc.string({ maxLength: 40 }), weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 30 }), weight: 1 },
);
const flavourArb = fc.constantFrom('md', 'gmi', undefined);
// a document plus an in-range selection, collapsed roughly half the time
const caseArb = fc.tuple(docArb, fc.nat(), fc.nat(), fc.boolean(), flavourArb)
  .map(([value, i, j, collapse, flavor]) => {
    const n = value.length + 1;
    let a = i % n, b = collapse ? a : j % n;
    if (a > b) [a, b] = [b, a];
    return { value, selStart: a, selEnd: b, flavor };
  });
const nl = (s) => s.split('\n').length;
const apply = (v, r) => v.slice(0, r.from) + r.text + v.slice(r.to);

console.log('listEnter: shape of the edit');
prop('it never throws', fc.property(caseArb, (c) => {
  listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return true;
}));
prop('the result is null or a well-formed edit', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  if (r === null) return true;
  return r && typeof r === 'object' && typeof r.text === 'string'
    && Number.isInteger(r.from) && Number.isInteger(r.to) && Number.isInteger(r.caret);
}));
prop('the replaced range is inside the document', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return !r || (r.from >= 0 && r.from <= r.to && r.to <= c.value.length);
}));
prop('the caret lands inside the text that was inserted', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return !r || (r.caret >= r.from && r.caret <= r.from + r.text.length);
}));
prop('the caret lands inside the resulting document', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return !r || (r.caret >= 0 && r.caret <= apply(c.value, r).length);
}));
prop('the edit is a superset of the selection', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  // whatever else it rewrites, an Enter must consume the whole selection:
  // a range clamped short of selEnd leaves typed-over text alive
  return !r || (r.from <= c.selStart && r.to >= c.selEnd);
}));

console.log('\nlistEnter: nothing outside the range is touched');
prop('the text before the range survives verbatim', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  if (!r) return true;
  return apply(c.value, r).startsWith(c.value.slice(0, r.from));
}));
prop('the text after the range survives verbatim', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  if (!r) return true;
  return apply(c.value, r).endsWith(c.value.slice(r.to));
}));
prop('undoing the inserted marker gives back the document, minus the selection',
  fc.property(caseArb, (c) => {
    const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
    if (!r || !r.text.startsWith('\n')) return true;   // not the "continue" edit
    const out = apply(c.value, r);
    // the caret sits just past the marker, so [from, caret) is exactly the
    // newline and the marker this Enter wrote. Cut them back out and what
    // remains must be the original document with the selection typed over,
    // give or take the digits renumbering rewrote below the caret.
    const key = (s) => s.split('\n').map((l) => l.replace(/^([ \t]*)(\d+)([.)])/, '$1#$3'));
    const undone = key(out.slice(0, r.from) + out.slice(r.caret));
    const want = key(c.value.slice(0, c.selStart) + c.value.slice(c.selEnd));
    return undone.length === want.length && undone.every((l, i) => l === want[i]);
  }));

console.log('\nlistEnter: what one Enter does to the document');
prop('one Enter never adds more than one line', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return !r || nl(apply(c.value, r)) - nl(c.value) <= 1;
}));
prop('with no selection it adds exactly one line, or empties the item',
  fc.property(caseArb, (c) => {
    if (c.selStart !== c.selEnd) return true;
    const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
    if (!r) return true;
    const d = nl(apply(c.value, r)) - nl(c.value);
    // d === 0 is the "leave the list" edit: the marker line is rewritten in
    // place (emptied, or replaced by the parent's marker), never split
    return d === 1 || (d === 0 && !r.text.includes('\n'));
  }));
prop('a continued item keeps every other line, numbering aside',
  fc.property(caseArb, (c) => {
    if (c.selStart !== c.selEnd) return true;
    // caret at the end of its line: no text is being split off to the right
    const eol = c.value.indexOf('\n', c.selStart);
    const atEol = eol === -1 ? c.selStart === c.value.length : eol === c.selStart;
    if (!atEol) return true;
    const r = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
    if (!r) return true;
    const out = apply(c.value, r);
    if (nl(out) !== nl(c.value) + 1) return true;      // the "leave list" edit
    // renumbering may rewrite the digits of an ordered marker and nothing
    // else, so compare lines with their numbers blanked out
    const key = (l) => l.replace(/^([ \t]*)(\d+)([.)])/, '$1#$3');
    const a = c.value.split('\n').map(key), b = out.split('\n').map(key);
    for (let i = 0; i < b.length; i++) {
      const cut2 = b.slice(0, i).concat(b.slice(i + 1));
      if (cut2.length === a.length && cut2.every((x, j) => x === a[j])) return true;
    }
    return false;
  }));

console.log('\nlistEnter: pressing Enter repeatedly settles');
prop('Enter at the end of a document terminates', fc.property(docArb, flavourArb, (v0, flavor) => {
  // continue, continue, ... then out of the list. Every step must make
  // progress: an edit that neither shortens the marker nor adds a line would
  // spin forever under a held key.
  let v = v0, at = v.length;
  for (let i = 0; i < 40; i++) {
    const r = listEnter(v, at, at, flavor);
    if (!r) return true;
    v = apply(v, r); at = r.caret;
  }
  return false;
}));
prop('gemtext only ever writes a gemtext marker', fc.property(caseArb, (c) => {
  const r = listEnter(c.value, c.selStart, c.selEnd, 'gmi');
  // gemtext has one list form. Writing "- " or "2. " here would put literal
  // characters on screen, which is the bug this rules out.
  return !r || r.text === '' || /^\n\* +$/.test(r.text);
}));
prop('it is a pure function of its arguments', fc.property(caseArb, (c) => {
  const a = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  const b = listEnter(c.value, c.selStart, c.selEnd, c.flavor);
  return JSON.stringify(a) === JSON.stringify(b);
}));


// ═══ listTab (22-listedit.js) ════════════════════════════════════════════════════════
// Tab/Shift-Tab share listEnter's document generator and its contracts, plus
// two of their own: an indent-then-outdent round-trips the document, and the
// line COUNT never changes (Tab restructures, it never splits or joins).
const dirArb = fc.constantFrom(1, -1);
const tabCase = fc.tuple(caseArb, dirArb).map(([c, dir]) => ({ ...c, dir }));

console.log('\nlistTab: shape of the edit');
prop('it never throws', fc.property(tabCase, (c) => {
  listTab(c.value, c.selStart, c.selEnd, c.flavor, c.dir);
  return true;
}));
prop('the replaced range is inside the document', fc.property(tabCase, (c) => {
  const r = listTab(c.value, c.selStart, c.selEnd, c.flavor, c.dir);
  return !r || (r.from >= 0 && r.from <= r.to && r.to <= c.value.length);
}));
prop('the text outside the range survives verbatim', fc.property(tabCase, (c) => {
  const r = listTab(c.value, c.selStart, c.selEnd, c.flavor, c.dir);
  if (!r) return true;
  const out = apply(c.value, r);
  return out.startsWith(c.value.slice(0, r.from)) && out.endsWith(c.value.slice(r.to));
}));
prop('the line count never changes', fc.property(tabCase, (c) => {
  const r = listTab(c.value, c.selStart, c.selEnd, c.flavor, c.dir);
  return !r || nl(apply(c.value, r)) === nl(c.value);
}));
prop('indent then outdent round-trips', fc.property(caseArb, (c) => {
  const r1 = listTab(c.value, c.selStart, c.selEnd, c.flavor, 1);
  if (!r1) return true;
  const v2 = apply(c.value, r1);
  const r2 = listTab(v2, r1.caret, r1.caretEnd == null ? r1.caret : r1.caretEnd, c.flavor, -1);
  return !!r2 && apply(v2, r2) === c.value;
}));

// ═══ shortPath (10-shell.js) ═══════════════════════════════════════════════
// The contract is a uniqueness claim, so the generator has to be adversarial
// about the thing that breaks uniqueness: strip() drops an optional "page/",
// so paths that differ only by that prefix collapse together.
const B = '/apps/lattice.lattice_app/';
// A THREE-letter alphabet on purpose, "page" among them. With a wide segment
// vocabulary two grants almost never come close enough to collide and the
// property passes vacuously; with this one they collide constantly.
const SEGS = ['page', 'a', 'b'];
const WIDE = ['page', 'foo', 'a', 'b', 'notes', 'apps', 'lattice.lattice_app', 'pub'];
const pathArb = fc.oneof(
  { arbitrary: fc.array(fc.constantFrom(...SEGS), { minLength: 1, maxLength: 3 })
    .map((s) => B + s.join('/')), weight: 10 },
  { arbitrary: fc.array(fc.constantFrom(...WIDE), { minLength: 1, maxLength: 4 })
    .map((s) => B + s.join('/')), weight: 3 },
  { arbitrary: fc.array(fc.constantFrom(...WIDE), { minLength: 1, maxLength: 3 })
    .map((s) => '/apps/other.app/' + s.join('/')), weight: 2 },
  { arbitrary: fc.constantFrom(B, B.slice(0, -1), B + 'page/', '', '/', 'x'), weight: 1 },
);
const listArb = fc.array(pathArb, { minLength: 1, maxLength: 6 })
  .map((ps) => [...new Set(ps)]);

console.log('\nshortPath: the uniqueness contract');
prop('no two distinct paths in one list ever render the same', fc.property(listArb, (all) => {
  const seen = new Map();
  for (const p of all) {
    const s = shortPath(p, all);
    if (seen.has(s)) return false;
    seen.set(s, p);
  }
  return true;
}));

console.log('\nshortPath: the label still names the path');
prop('the label is a tail of the path, on a segment boundary', fc.property(listArb, (all) =>
  all.every((p) => {
    const s = shortPath(p, all).replace(/^…\//, '');
    return s === p || p.endsWith('/' + s) || p === '' || s === '';
  })));
prop('the label is never empty for a non-empty path', fc.property(listArb, (all) =>
  all.every((p) => !p || shortPath(p, all) !== '')));
prop('a grant shown on its own is cut back to its leaf', fc.property(pathArb, (p) => {
  // "shortest tail" is half the contract. Nothing to disambiguate against
  // means nothing to grow for, so a lone grant is one segment.
  const s = shortPath(p, [p]);
  return s === p || s.replace(/^…\//, '').split('/').length === 1;
}));
prop('the label does not depend on the order of the list', fc.property(listArb, (all) =>
  all.every((p) => shortPath(p, all) === shortPath(p, [...all].reverse()))));
prop('it never throws and never mutates the list', fc.property(listArb, (all) => {
  const before = JSON.stringify(all);
  all.forEach((p) => shortPath(p, all));
  return JSON.stringify(all) === before;
}));

// ═══ esc (25-editor.js) ════════════════════════════════════════════════════
// esc is the fallback path in render(): when Prism has no grammar for the
// page's kind, the raw source goes into innerHTML through this and nothing
// else. It is the whole XSS boundary for that path.
const textArb = fc.oneof(
  { arbitrary: fc.string({ maxLength: 60 }), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 40 }), weight: 2 },
  { arbitrary: fc.array(fc.constantFrom('<', '>', '&', '"', "'", 'script', '/', '&amp;',
    '&lt;', ' ', '\n', 'img src=x onerror=alert(1)', '<!--', ']]>'),
    { maxLength: 12 }).map((a) => a.join('')), weight: 3 },
);

console.log('\nesc: the XSS boundary');
prop('the output can never contain a raw <', fc.property(textArb, (t) => !esc(t).includes('<')));
prop('every & in the output opens a known entity', fc.property(textArb, (t) =>
  !esc(t).replace(/&(amp|lt);/g, '').includes('&')));
prop('escaping is reversible, so nothing is lost on screen', fc.property(textArb, (t) =>
  esc(t).replace(/&(amp|lt);/g, (_, e) => (e === 'amp' ? '&' : '<')) === t));
prop('the output is never shorter than the input', fc.property(textArb, (t) =>
  esc(t).length >= t.length));

// ═══ seg (70-upload.js) ════════════════════════════════════════════════════
// seg sanitises one segment of an uploaded file's relative path before it is
// joined back with "/" into a page name. Anything that survives here reaches
// the ship as part of a path.
const nameArb = fc.oneof(
  { arbitrary: fc.string({ maxLength: 30 }), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 25 }), weight: 2 },
  { arbitrary: fc.array(fc.constantFrom('.', '..', '/', '\\', '~', '-', '_', 'a', 'A', '0',
    ' ', '%2e', 'C:', 'é'), { maxLength: 10 }).map((a) => a.join('')), weight: 3 },
);

console.log('\nseg: an upload can never escape its path segment');
prop('the output only contains the allowed characters', fc.property(nameArb, (x) =>
  /^[a-z0-9._~-]*$/.test(seg(x))));
prop('the output never contains a path separator', fc.property(nameArb, (x) =>
  !seg(x).includes('/') && !seg(x).includes('\\')));
prop('the output is never a dot segment', fc.property(nameArb, (x) =>
  seg(x) !== '.' && seg(x) !== '..'));
prop('it never starts or ends with a dot or dash', fc.property(nameArb, (x) =>
  !/^[-.]|[-.]$/.test(seg(x))));
prop('sanitising twice changes nothing', fc.property(nameArb, (x) => seg(seg(x)) === seg(x)));
prop('an already-clean name is left alone', fc.property(
  fc.stringMatching(/^[a-z0-9_~][a-z0-9._~-]*[a-z0-9_~]$/), (x) => seg(x) === x));

// ═══ acRank (55-autocomplete.js) ═══════════════════════════════════════════
const nodeArb = fc.record({
  path: fc.array(fc.constantFrom('a', 'b', 'notes', 'Foo', 'x', 'deep'),
    { minLength: 1, maxLength: 4 }).map((s) => s.join('/')),
  page: fc.boolean(),
});
const treeArb = fc.uniqueArray(nodeArb, { selector: (n) => n.path, maxLength: 14 });
const qArb = fc.constantFrom('', 'a', 'foo', 'FOO', 'notes', 'b/notes', 'zzz', '/', 'deep');

console.log('\nacRank: the dropdown only offers what matches');
prop('every suggestion contains the query', fc.property(treeArb, qArb, fc.option(fc.string()),
  (nodes, q, current) => {
    const out = mkAcRank(nodes, current, '')(q);
    return out.every((p) => p.toLowerCase().includes(q.toLowerCase()));
  }));
prop('it offers exactly the top 8 of the matching pages',
  fc.property(treeArb, qArb, (nodes, q) => {
    const current = nodes.length ? nodes[0].path : null;
    const out = mkAcRank(nodes, current, '')(q);
    const hits = nodes.filter((n) => n.page && n.path !== current
      && n.path.toLowerCase().includes(q.toLowerCase()));
    return out.length === Math.min(8, hits.length);
  }));
prop('it never offers a folder, and never the page being edited',
  fc.property(treeArb, qArb, (nodes, q) => {
    const current = nodes.length ? nodes[0].path : null;
    const out = mkAcRank(nodes, current, '')(q);
    const pages = new Set(nodes.filter((n) => n.page).map((n) => n.path));
    return out.every((p) => pages.has(p) && p !== current);
  }));
prop('it never offers the same page twice', fc.property(treeArb, qArb, (nodes, q) => {
  const out = mkAcRank(nodes, null, '')(q);
  return new Set(out).size === out.length;
}));
prop('ranking does not reorder the tree it reads', fc.property(treeArb, qArb, (nodes, q) => {
  const before = JSON.stringify(nodes);
  mkAcRank(nodes, null, '')(q);
  return JSON.stringify(nodes) === before;
}));
prop('a sibling of the page being edited outranks a stranger with the same name',
  fc.property(fc.constantFrom('notes', 'x', 'a'), (leaf) => {
    const nodes = [
      { path: 'here/' + leaf, page: true },
      { path: 'far/away/deep/' + leaf, page: true },
      { path: 'here/me', page: true },
    ];
    const out = mkAcRank(nodes, 'here/me', '')(leaf);
    return out[0] === 'here/' + leaf;
  }), 20);

// ── a couple of anchors that are not properties ────────────────────────────
console.log('\nsanity anchors');
ok('esc leaves ordinary prose alone', esc('a plain line') === 'a plain line');
ok('seg keeps a normal filename', seg('My Notes.md') === 'my-notes.md', seg('My Notes.md'));
ok('shortPath still shortens a lone grant', shortPath(B + 'page/notes', [B + 'page/notes']) === 'notes');

console.log(fails
  ? `\n${fails} of ${props} propert${props === 1 ? 'y' : 'ies'} FAILED`
  : `\nall ${props} properties passed`);
process.exit(fails ? 1 : 0);
