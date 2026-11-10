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
export const CAPS = { depth: 8, files: 64, bytes: 4 * 1024 * 1024 };

//  the source with its comments and strings blanked, lengths kept
//  An include's path is read whole, as OpenSCAD's lexer does, so a `//`
//  inside one is part of the path, not a comment.
function bare(src) {
  return src.replace(/\b(?:include|use)\s*<[^>\n]*>|\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g,
    (m) => (/^(include|use)/.test(m) ? m : m.replace(/[^\n]/g, ' ')));
}

//  every include and use in a source: { kind, ref, line }
export function scanIncludes(src) {
  const out = [];
  const b = bare(String(src));
  const re = /(^|[;\s}])(include|use)\s*<([^>\n]*)>/g;
  let m;
  while ((m = re.exec(b))) {
    const at = m.index + m[1].length;
    const ref = String(src).slice(at, at + m[0].length - m[1].length).replace(/^(include|use)\s*</, '').replace(/>$/, '');
    out.push({ kind: m[2], ref, line: b.slice(0, at).split('\n').length });
  }
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
  while (queue.length) {
    const { page, text: t, depth } = queue.shift();
    for (const inc of scanIncludes(t)) {
      const r = resolveRef(dirOf(page), inc.ref);
      if (r.error) { notes.push(`line ${inc.line} of ${page}: ${r.error}`); continue; }
      if (files.has(r.file)) continue;
      if (depth + 1 > caps.depth) { notes.push(`${r.page}: includes nest deeper than ${caps.depth}, not read`); continue; }
      if (files.size >= caps.files) { notes.push(`more than ${caps.files} included files, the rest not read`); queue.length = 0; break; }
      let body = asked.get(r.page);
      if (body === undefined) {
        try { body = await read(r.page); } catch { body = null; }
        asked.set(r.page, body);
      }
      if (typeof body !== 'string') continue;
      if (bytes + body.length > caps.bytes) { notes.push(`${r.page}: the included files pass ${caps.bytes >> 20} MB, not read`); continue; }
      bytes += body.length;
      files.set(r.file, body);
      queue.push({ page: r.page, text: body, depth: depth + 1 });
    }
  }
  return { main, files: [...files.entries()], notes };
}
