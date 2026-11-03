//  odt.js: .odt in and out, in the browser (plan, Task 12).
//
//  Import unzips the package (central directory, DecompressionStream
//  'deflate-raw', tiny-inflate where the browser has no such stream) and
//  builds the one office:document LibreOffice writes as flat ODT: the
//  roots' namespaces, then meta, settings, scripts, font faces (merged by
//  name), styles, automatic styles, master styles and the body. styles.xml
//  and content.xml keep their automatic styles in separate name scopes, so
//  a styles.xml name that content.xml also uses is renamed, with its
//  references in styles.xml's automatic and master styles. Pictures and
//  other package files are left out, and the note says which.
//
//  Export splits a fodt back into content.xml, styles.xml, meta.xml and
//  settings.xml (styles.xml takes the page layouts and the automatic
//  styles the master pages use, content.xml the rest) and zips them STORED, mimetype first, with
//  META-INF/manifest.xml.
import tinf from 'tiny-inflate';
import { parseXml, elements, child, attr, escAttr, LIMITS } from './xml.js';

const MIME = 'application/vnd.oasis.opendocument.text';
//  what one entry may inflate to; a zip bomb stops here
export const ENTRY_MAX = 16 * 1024 * 1024;

// ---------------------------------------------------------------- unzip
//  the entries of a zip, from its central directory: name -> entry
function entries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('this is not a zip file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('its zip directory is damaged');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    out.set(name, { flags, method, csize, size, local });
    p += 46 + nl + xl + cl;
  }
  return out;
}

//  an entry's bytes, inflated, never past ENTRY_MAX
async function bytes(u8, e) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (e.flags & 1) throw new Error('it is password protected');
  if (e.csize === 0xffffffff || e.size === 0xffffffff) throw new Error('it is a zip64 file');
  if (e.size > ENTRY_MAX) throw new Error('it is too large to import');
  if (dv.getUint32(e.local, true) !== 0x04034b50) throw new Error('its zip entries are damaged');
  const at = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  const raw = u8.subarray(at, at + e.csize);
  if (raw.length !== e.csize) throw new Error('it is cut short');
  if (e.method === 0) return raw;
  if (e.method !== 8) throw new Error('it uses a compression lattice cannot read');
  if (typeof DecompressionStream === 'function') {
    const rd = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let len = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      len += value.length;
      if (len > ENTRY_MAX || len > e.size) { rd.cancel(); throw new Error('it inflates past its stated size'); }
      parts.push(value);
    }
    const all = new Uint8Array(len);
    let o = 0;
    for (const v of parts) { all.set(v, o); o += v.length; }
    return all;
  }
  //  tiny-inflate drops what does not fit its buffer, so one byte more
  //  than the stated size shows an entry that inflates past it
  const out = tinf(raw, new Uint8Array(e.size + 1));
  if (out.length > e.size) throw new Error('it inflates past its stated size');
  return out;
}

//  LibreOffice reads a relative link in a package from inside it, as if
//  the .odt were a folder, and in a flat file from beside it, so the same
//  target is one ../ deeper in an .odt (checked with 26.8)
const inTags = (xml, f) => xml.replace(/<[^>]*>/g, f);
const linksOut = (xml) => inTags(xml, (t) => t.replace(/(\sxlink:href=")(?=[^"])(?![a-zA-Z][\w+.-]*:|\/|#)/g, '$1../'));
const linksIn = (xml) => inTags(xml, (t) => t.replace(/(\sxlink:href=")\.\.\//g, '$1'));

// ---------------------------------------------------------------- import
const ROOTS = {
  'content.xml': 'office:document-content',
  'styles.xml': 'office:document-styles',
  'meta.xml': 'office:document-meta',
  'settings.xml': 'office:document-settings',
};
//  attributes that name a style: every *style-name, and the page layout
const REF = /(\s(?:[\w-]+:[\w-]*style-name|style:page-layout-name)=")([^"]*)(")/g;
const styleNames = (el) => new Set(el ? elements(el).map((s) => attr(s, 'style:name')).filter(Boolean) : []);

//  the package's Basic libraries (Basic/) as the office:script a flat
//  ODT embeds them in, or ''. A linked library stays behind.
async function basic(ents, used, take) {
  const read = async (n) => {
    const e = ents.get(n);
    if (!e || used.has(n)) return null;
    const src = new TextDecoder().decode(await take(e));
    const x = parseXml(src);
    if (x.error) throw new Error(n + ': ' + x.error);
    used.add(n);
    return { src, el: elements(x.root)[0] };
  };
  const lc = await read('Basic/script-lc.xml');
  if (!lc || !lc.el) return '';
  let libs = '';
  for (const lib of elements(lc.el)) {
    const name = attr(lib, 'library:name');
    if (!name || attr(lib, 'library:link') === 'true') continue;
    const lb = await read('Basic/' + name + '/script-lb.xml');
    if (!lb || !lb.el) continue;
    let mods = '';
    for (const m of elements(lb.el)) {
      const mn = attr(m, 'library:name');
      const mod = mn && await read('Basic/' + name + '/' + mn + '.xml');
      if (!mod || !mod.el) continue;
      const code = mod.el.empty ? '' : mod.src.slice(mod.el.openEnd, mod.el.closeStart);
      mods += '<ooo:module ooo:name="' + escAttr(mn) + '"><ooo:source-code>' + code + '</ooo:source-code></ooo:module>';
    }
    libs += '<ooo:library-embedded ooo:name="' + escAttr(name) + '">' + mods + '</ooo:library-embedded>';
  }
  return libs && '<office:script script:language="ooo:Basic"><ooo:libraries xmlns:ooo="http://openoffice.org/2004/office" xmlns:xlink="http://www.w3.org/1999/xlink">'
    + libs + '</ooo:libraries></office:script>';
}

//  importOdt(ArrayBuffer) -> { text, note } | { error }
export async function importOdt(buf) {
  try {
    const u8 = new Uint8Array(buf);
    const ents = entries(u8);
    //  every entry read counts toward the document cap, Basic too
    let total = 0;
    const take = async (e) => {
      const b = await bytes(u8, e);
      if ((total += b.length) > LIMITS.size) throw new Error('it is too large to import');
      return b;
    };
    const mt = ents.get('mimetype');
    if (!mt || new TextDecoder().decode(await take(mt)).trim() !== MIME) throw new Error('it is not a Writer document');
    const parts = {};
    for (const [file, root] of Object.entries(ROOTS)) {
      const e = ents.get(file);
      if (!e) { if (file === 'content.xml') throw new Error('it has no content.xml'); continue; }
      const src = new TextDecoder().decode(await take(e));
      const x = parseXml(src);
      if (x.error) throw new Error(file + ': ' + x.error);
      const r = elements(x.root).find((k) => k.name === root);
      if (!r) throw new Error(file + ' is not ' + root);
      parts[file] = { src, r, get: (n) => { const k = child(r, n); return k ? src.slice(k.start, k.end) : ''; } };
    }
    const c = parts['content.xml'], s = parts['styles.xml'], m = parts['meta.xml'], g = parts['settings.xml'];
    //  the root: every namespace any part declares, then version and mimetype
    const ns = new Map();
    for (const p of [c, s, m, g]) if (p) for (const [k, v] of p.r.attrs) if (k.startsWith('xmlns:') && !ns.has(k)) ns.set(k, v);
    const ver = attr(c.r, 'office:version');
    let head = '<?xml version="1.0" encoding="UTF-8"?>\n\n<office:document';
    for (const [k, v] of ns) head += ' ' + k + '="' + v + '"';
    if (ver != null) head += ' office:version="' + ver + '"';
    head += ' office:mimetype="' + MIME + '">\n ';
    //  styles.xml's automatic names content.xml also uses get a new name
    let sAuto = s ? s.get('office:automatic-styles') : '', sMaster = s ? s.get('office:master-styles') : '';
    if (s) {
      const taken = styleNames(child(c.r, 'office:automatic-styles'));
      const mine = styleNames(child(s.r, 'office:automatic-styles'));
      const ren = new Map();
      for (const n of mine) {
        if (!taken.has(n)) continue;
        let k = 1;
        while (taken.has('M' + n + '_' + k) || mine.has('M' + n + '_' + k)) k++;
        ren.set(n, 'M' + n + '_' + k);
      }
      if (ren.size) {
        const fix = (xml) => xml.replace(/<[^>]*>/g, (tag) => tag.replace(REF, (all, a, v, z) => (ren.has(v) ? a + ren.get(v) + z : all))
          .replace(/(\sstyle:name=")([^"]*)(")/, (all, a, v, z) => (ren.has(v) ? a + ren.get(v) + z : all)));
        sAuto = fix(sAuto);
        sMaster = fix(sMaster);
      }
    }
    //  font faces: styles.xml's, then content.xml's not already there
    const faces = [];
    const seen = new Set();
    for (const p of [s, c]) {
      const d = p && child(p.r, 'office:font-face-decls');
      if (d) for (const f of elements(d)) { const n = attr(f, 'style:name'); if (!seen.has(n)) { seen.add(n); faces.push(p.src.slice(f.start, f.end)); } }
    }
    //  office:scripts, with the Basic libraries put in
    const used = new Set();
    const bas = await basic(ents, used, take);
    let scripts = c.get('office:scripts');
    if (bas) scripts = !scripts || /\/>$/.test(scripts) ? '<office:scripts>' + bas + '</office:scripts>' : scripts.replace(/<\/office:scripts>$/, bas + '</office:scripts>');
    //  the automatic styles of both, as one element
    const inner = (xml) => xml.replace(/^<[^>]*>|<\/[^>]*>$/g, '').replace(/^<[^>]*\/>$/, '');
    const cAuto = c.get('office:automatic-styles');
    const auto = (sAuto || cAuto) ? '<office:automatic-styles>' + inner(sAuto) + inner(cAuto) + '</office:automatic-styles>' : '';
    const body = [
      m && m.get('office:meta'),
      g && g.get('office:settings'),
      scripts,
      faces.length ? '<office:font-face-decls>' + faces.join('') + '</office:font-face-decls>' : '',
      s && s.get('office:styles'),
      auto,
      sMaster,
      c.get('office:body'),
    ].filter(Boolean).join('\n ');
    const text = head + linksIn(body) + '\n</office:document>\n';
    const ok = parseXml(text);
    if (ok.error) throw new Error(ok.error);
    //  what stays behind: pictures, embedded objects, macros
    const KEEP = /^(mimetype|content\.xml|styles\.xml|meta\.xml|settings\.xml|manifest\.rdf|layout-cache|META-INF\/.*|Thumbnails\/.*|Configurations2\/.*|.*\/)$/;
    const dropped = [...ents.keys()].filter((n) => !KEEP.test(n) && !used.has(n));
    const pics = dropped.filter((n) => n.startsWith('Pictures/'));
    const other = dropped.filter((n) => !n.startsWith('Pictures/'));
    let note = '';
    if (pics.length) note += 'left out ' + pics.length + (pics.length === 1 ? ' picture' : ' pictures') + ' (' + pics.slice(0, 4).map((n) => n.slice(9)).join(', ') + (pics.length > 4 ? ', ...' : '') + ')';
    if (other.length) note += (note ? ', and ' : 'left out ') + other.slice(0, 4).join(', ') + (other.length > 4 ? ', ...' : '');
    return { text, note };
  } catch (e) {
    return { error: 'This .odt cannot be imported: ' + (e && e.message ? e.message : 'it could not be read') + '.' };
  }
}

// ---------------------------------------------------------------- export
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

//  a zip of STORED entries, in the order given
export function zipStored(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], cents = [];
  let off = 0;
  for (const [name, data] of files) {
    const nm = enc.encode(name), d = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(d);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 10, true); h.setUint16(6, 0x0800, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true);
    h.setUint16(26, nm.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 10, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, d.length, true); cd.setUint32(24, d.length, true);
    cd.setUint16(28, nm.length, true); cd.setUint32(42, off, true);
    locals.push(new Uint8Array(h.buffer), nm, d);
    cents.push(new Uint8Array(cd.buffer), nm);
    off += 30 + nm.length + d.length;
  }
  const csize = cents.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...locals, ...cents, new Uint8Array(e.buffer)], { type: MIME });
}

//  exportOdt(fodt text) -> { blob } | { error }
export function exportOdt(text) {
  const x = parseXml(String(text ?? ''));
  const doc = !x.error && elements(x.root).find((k) => k.name === 'office:document');
  if (!doc) return { error: 'This document cannot be exported: ' + (x.error || 'it is not flat ODT') + '.' };
  const get = (n) => { const k = child(doc, n); return k ? linksOut(text.slice(k.start, k.end)) : ''; };
  const ver = attr(doc, 'office:version') || '1.3';
  let at = '';
  for (const [k, v] of doc.attrs) if (k !== 'office:mimetype') at += ' ' + k + '="' + v + '"';
  //  automatic styles as LibreOffice splits them: styles.xml gets the page
  //  layouts and what the master pages use (and what those use), and
  //  content.xml all but the page layouts
  const autoEl = child(doc, 'office:automatic-styles');
  const autos = autoEl ? elements(autoEl).map((e) => ({ name: attr(e, 'style:name'), el: e.name, raw: linksOut(text.slice(e.start, e.end)) })) : [];
  const want = new Set();
  const refs = (xml) => { for (const m of xml.matchAll(REF)) if (!want.has(m[2])) { want.add(m[2]); const a = autos.find((x) => x.name === m[2]); if (a) refs(a.raw); } };
  refs(get('office:master-styles'));
  const auto = (keep) => '<office:automatic-styles>' + autos.filter(keep).map((a) => a.raw).join('') + '</office:automatic-styles>';
  const sAuto = auto((a) => a.el === 'style:page-layout' || want.has(a.name));
  const cAuto = auto((a) => a.el !== 'style:page-layout');
  const part = (root, names) => '<?xml version="1.0" encoding="UTF-8"?>\n<' + root + at + '>'
    + names.map((n) => (n === 'office:automatic-styles' ? (root === 'office:document-styles' ? sAuto : cAuto) : get(n))).join('') + '</' + root + '>';
  const manifest = '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="' + ver + '">'
    + '<manifest:file-entry manifest:full-path="/" manifest:version="' + ver + '" manifest:media-type="' + MIME + '"/>'
    + ['content.xml', 'styles.xml', 'meta.xml', 'settings.xml'].map((f) => '<manifest:file-entry manifest:full-path="' + f + '" manifest:media-type="text/xml"/>').join('')
    + '</manifest:manifest>';
  return {
    blob: zipStored([
      ['mimetype', MIME],
      ['content.xml', part('office:document-content', ['office:scripts', 'office:font-face-decls', 'office:automatic-styles', 'office:body'])],
      ['styles.xml', part('office:document-styles', ['office:font-face-decls', 'office:styles', 'office:automatic-styles', 'office:master-styles'])],
      ['meta.xml', part('office:document-meta', ['office:meta'])],
      ['settings.xml', part('office:document-settings', ['office:settings'])],
      ['META-INF/manifest.xml', manifest],
    ]),
  };
}
