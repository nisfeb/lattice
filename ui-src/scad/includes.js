//  includes.js: OpenSCAD's include <...> and use <...>, resolved against
//  lattice pages before a render.
//
//  OpenSCAD runs in a worker with a virtual file system and no network, so
//  everything it may read is put there first. A page `parts/box` is the
//  file /w/parts/box.scad, and `include <lib/screws.scad>` in it names the
//  page parts/lib/screws (the .scad is optional). The file goes in under
//  the name the include wrote, so OpenSCAD finds it where it looks.
//
//  Paths stay inside lattice: an absolute path, a URL and a `..` above the
//  root are refused, and depth, file count and size are capped so a
//  runaway include tree stops. A page that does not exist is left out, and
//  OpenSCAD reports the include it could not open, on its line.

export const ROOT = '/w/';
//  `files` caps the pages asked for, found or not, and `refs` the include
//  lines looked at, so a hostile page costs neither reads nor notes
export const CAPS = { depth: 8, files: 64, bytes: 4 * 1024 * 1024, refs: 1024 };

const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === '\v';

//  every include and use in a source: { kind, ref, line }
//
//  One pass, each character looked at a bounded number of times, because
//  the text is the page's and may be hostile. Comments and strings hide
//  an include. A block comment that never ends is not one, and neither
//  is an include with no > on its line: the scan goes on from there, and
//  looks for that end only once.
//  An include's path is read whole, as OpenSCAD's lexer does, so a `//`
//  inside one is part of the path, not a comment.
//  `tally.steps`, when asked for, is the work done, for the suite.
export function scanIncludes(src, tally) {
  const s = String(src), n = s.length, out = [];
  let i = 0, line = 1, steps = 0;
  //  what came before: an include starts the text or follows white
  //  space, a ; or a }. A comment or a string counts as a space.
  let prev = ' ';
  //  the next of each, found once and kept while it is still ahead
  let gt = -1, eol = -1, close = -1, noClose = false;
  const ahead = (at, ch, from) => {
    if (at >= from) return at;
    const e = s.indexOf(ch, from);
    steps += (e < 0 ? n : e) - from;
    return e < 0 ? n : e;
  };
  while (i < n) {
    steps++;
    const c = s[i];
    if (c === '\n') { line++; prev = c; i++; continue; }
    if (c === '/' && s[i + 1] === '/') { i = eol = ahead(eol, '\n', i); prev = ' '; continue; }
    if (c === '/' && s[i + 1] === '*' && !noClose) {
      if (close < i + 2) { const e = s.indexOf('*/', i + 2); steps += (e < 0 ? n : e) - i; close = e; noClose = e < 0; }
      if (!noClose) {
        for (let k = i; k < close; k++) if (s[k] === '\n') line++;
        i = close + 2; prev = ' ';
        continue;
      }
    }
    if (c === '"') {
      //  to the closing quote on this line
      eol = ahead(eol, '\n', i);
      let j = i + 1;
      while (j < eol && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      steps += j - i;
      if (j < eol) { i = j + 1; prev = ' '; continue; }
      //  a quote with no partner on its line: the rest of the line is
      //  inside it, as OpenSCAD reads it, so no include is read there
      i = eol; prev = ' ';
      continue;
    }
    const kind = (prev === ';' || prev === '}' || isWs(prev)) && (s.startsWith('include', i) ? 'include' : s.startsWith('use', i) ? 'use' : null);
    if (kind) {
      let j = i + kind.length, nl = 0;
      while (j < n && isWs(s[j])) { if (s[j] === '\n') nl++; j++; }
      steps += j - i;
      if (s[j] === '<') {
        gt = ahead(gt, '>', j + 1);
        eol = ahead(eol, '\n', j + 1);
        if (gt < eol) {
          out.push({ kind, ref: s.slice(j + 1, gt), line });
          line += nl;
          i = gt + 1; prev = '>';
          continue;
        }
      }
    }
    prev = c; i++;
  }
  if (tally) tally.steps = steps;
  return out;
}

//  a reference from a file in `dir` (a page folder, '' at the root) to its
//  page name and the file it becomes, or { error }
export function resolveRef(dir, ref) {
  const r = String(ref).trim();
  if (!r) return { error: 'an empty include' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('/') || r.startsWith('\\') || r.includes('\\'))
    return { error: `${r}: only lattice pages can be included, by a relative path` };
  const parts = (dir ? dir.split('/') : []).concat(r.split('/'));
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) return { error: `${r}: reaches above the top of your pages` };
      out.pop();
      continue;
    }
    out.push(p);
  }
  if (!out.length) return { error: `${r}: names no page` };
  const file = out.join('/');
  const page = file.replace(/\.scad$/i, '');
  return { page, file: ROOT + file };
}

const dirOf = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');

//  the main page and everything it includes, as [file, text] pairs for the
//  worker. `read(page)` answers the page's text or null. `notes` say what
//  was refused or capped.
export async function collect(name, text, read, caps = CAPS) {
  const main = ROOT + name + '.scad';
  const files = new Map([[main, text]]);
  const notes = [];
  let bytes = text.length;
  //  a page's own file, so its includes resolve from the page's folder
  const queue = [{ page: name, text, depth: 0 }];
  const asked = new Map();
  let looked = 0;
  //  a file cannot also be a folder: `include <a>` is the file /w/a, so a
  //  page under it, /w/a/b, has nowhere to go, and the other way round
  const clash = (f) => {
    for (let d = f.lastIndexOf('/'); d > ROOT.length; d = f.lastIndexOf('/', d - 1)) if (files.has(f.slice(0, d))) return f.slice(0, d);
    for (const k of files.keys()) if (k.startsWith(f + '/')) return k;
    return null;
  };
  while (queue.length) {
    const { page, text: t, depth } = queue.shift();
    for (const inc of scanIncludes(t)) {
      if (++looked > caps.refs) { notes.push(`more than ${caps.refs} include lines, the rest not looked at`); queue.length = 0; break; }
      const r = resolveRef(dirOf(page), inc.ref);
      if (r.error) { notes.push(`line ${inc.line} of ${page}: ${r.error}`); continue; }
      if (files.has(r.file)) continue;
      if (depth + 1 > caps.depth) { notes.push(`${r.page}: includes nest deeper than ${caps.depth}, not read`); continue; }
      if (files.size >= caps.files) { notes.push(`more than ${caps.files} included files, the rest not read`); queue.length = 0; break; }
      let body = asked.get(r.page);
      if (body === undefined) {
        //  a page that does not exist costs a read as well
        if (asked.size >= caps.files) { notes.push(`more than ${caps.files} included files, the rest not read`); queue.length = 0; break; }
        try { body = await read(r.page); } catch { body = null; }
        asked.set(r.page, body);
      }
      if (typeof body !== 'string') continue;
      const hit = clash(r.file);
      if (hit) { notes.push(`${inc.ref}: not read, ${hit.slice(ROOT.length)} is in its way. Write the .scad on the include of the page above it`); continue; }
      if (bytes + body.length > caps.bytes) { notes.push(`${r.page}: the included files pass ${caps.bytes >> 20} MB, not read`); continue; }
      bytes += body.length;
      files.set(r.file, body);
      queue.push({ page: r.page, text: body, depth: depth + 1 });
    }
  }
  return { main, files: [...files.entries()], notes };
}
