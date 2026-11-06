//  xml.js: a small, non-validating XML tokenizer for flat ODT, with byte
//  spans. The same rules as the ship's scanner (/lib/lattice-fodt):
//
//  - no DTD is processed: a DOCTYPE with an internal subset and any
//    <!ENTITY are refused, so entity expansion and external entities
//    cannot happen;
//  - only the five XML entities and numeric character references are
//    decoded;
//  - a document over the size cap, nested deeper than the depth cap, or
//    with more elements than the element cap is refused (spec, Security).
//
//  It keeps what DOMParser throws away: every element's span in the
//  source, its attributes in source order with their raw (undecoded)
//  values, and the text between elements as spans. The minimal-diff
//  serializer copies untouched bytes from those spans.
//
//  "Byte" spans are JS string offsets (UTF-16 code units): the body is a
//  string on both sides, and slicing it at these offsets gives the exact
//  source text back.

export const LIMITS = Object.freeze({ size: 8 * 1024 * 1024, depth: 256, elements: 200000 });

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

//  decode the five entities and numeric references; anything else is
//  left as written (it cannot be expanded, there is no DTD)
export function decode(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(n > 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return m;
      return String.fromCodePoint(n);
    }
    return ENT[e] ?? m;
  });
}

//  the characters XML 1.0 does not allow, even as a reference: a pasted
//  control character (Word's vertical tab, a form feed) would leave a
//  file LibreOffice refuses to open, so they are never written
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
//  text content: & < > only, as LibreOffice writes it
export const escText = (s) => s.replace(NOT_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
//  an attribute value in double quotes: LibreOffice also writes &quot; and &apos;
export const escAttr = (s) => escText(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const isNameChar = (c) => c > 32 && c !== 61 && c !== 62 && c !== 47 && c !== 34 && c !== 39;
const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;

class Refused extends Error {}
const refuse = (why) => { throw new Refused(why); };

//  +parseXml: the element tree of `text`, or { error }.
//
//  An element is { name, attrs, start, end, openEnd, closeStart, kids,
//  empty } where `attrs` is [[name, raw], ...] in source order, `start`
//  and `end` span the whole element, `openEnd` is the end of its start
//  tag, `closeStart` the start of its end tag (equal to `end` for an
//  empty element), and `kids` holds child elements and text runs
//  ({ text: true, start, end }). The root is a pseudo element holding the
//  top-level nodes.
export function parseXml(text, limits = LIMITS) {
  try {
    return { root: tree(text, limits) };
  } catch (e) {
    if (e instanceof Refused) return { error: e.message };
    return { error: 'not well-formed' };
  }
}

function tree(s, lim) {
  if (typeof s !== 'string') refuse('not text');
  if (s.length > lim.size) refuse('too large');
  const root = { name: '#root', attrs: [], start: 0, end: s.length, openEnd: 0, closeStart: s.length, kids: [], empty: false };
  const stack = [root];
  let cur = root;
  let n = 0;
  let i = 0;
  const L = s.length;
  while (i < L) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { cur.kids.push({ text: true, start: i, end: L }); break; }
    if (lt > i) cur.kids.push({ text: true, start: i, end: lt });
    const c = s.charCodeAt(lt + 1);
    if (c === 63) { // <? ... ?>
      const e = s.indexOf('?>', lt + 2);
      if (e < 0) refuse('not well-formed');
      cur.kids.push({ pi: true, start: lt, end: e + 2 });
      i = e + 2;
      continue;
    }
    if (c === 33) { // <!
      if (s.startsWith('--', lt + 2)) {
        const e = s.indexOf('-->', lt + 4);
        if (e < 0) refuse('not well-formed');
        cur.kids.push({ comment: true, start: lt, end: e + 3 });
        i = e + 3;
        continue;
      }
      if (s.startsWith('[CDATA[', lt + 2)) {
        const e = s.indexOf(']]>', lt + 9);
        if (e < 0) refuse('not well-formed');
        cur.kids.push({ text: true, cdata: true, start: lt, end: e + 3 });
        i = e + 3;
        continue;
      }
      if (s.startsWith('DOCTYPE', lt + 2)) {
        const e = s.indexOf('>', lt + 9);
        if (e < 0) refuse('not well-formed');
        if (s.slice(lt, e).includes('[')) refuse('a DOCTYPE with an internal subset');
        cur.kids.push({ doctype: true, start: lt, end: e + 1 });
        i = e + 1;
        continue;
      }
      if (s.startsWith('ENTITY', lt + 2)) refuse('an entity declaration');
      refuse('a markup declaration');
    }
    if (c === 47) { // </name>
      const e = s.indexOf('>', lt + 2);
      if (e < 0) refuse('not well-formed');
      const name = s.slice(lt + 2, e).trim();
      if (stack.length < 2 || cur.name !== name) refuse('mismatched end tag');
      cur.closeStart = lt;
      cur.end = e + 1;
      stack.pop();
      cur = stack[stack.length - 1];
      i = e + 1;
      continue;
    }
    // a start tag
    let j = lt + 1;
    while (j < L && isNameChar(s.charCodeAt(j))) j++;
    const name = s.slice(lt + 1, j);
    if (!name) refuse('not well-formed');
    const attrs = [];
    for (;;) {
      while (j < L && isWs(s.charCodeAt(j))) j++;
      if (j >= L) refuse('not well-formed');
      const ch = s.charCodeAt(j);
      if (ch === 62 || ch === 47) break;
      const a0 = j;
      while (j < L && isNameChar(s.charCodeAt(j))) j++;
      const an = s.slice(a0, j);
      if (!an) refuse('not well-formed');
      while (j < L && isWs(s.charCodeAt(j))) j++;
      if (s.charCodeAt(j) !== 61) refuse('not well-formed');
      j++;
      while (j < L && isWs(s.charCodeAt(j))) j++;
      const q = s.charCodeAt(j);
      if (q !== 34 && q !== 39) refuse('not well-formed');
      const e = s.indexOf(q === 34 ? '"' : "'", j + 1);
      if (e < 0) refuse('not well-formed');
      const raw = s.slice(j + 1, e);
      if (raw.indexOf('<') >= 0) refuse('not well-formed');
      attrs.push([an, raw]);
      j = e + 1;
    }
    if (++n > lim.elements) refuse('too many elements');
    const empty = s.charCodeAt(j) === 47;
    if (empty && s.charCodeAt(j + 1) !== 62) refuse('not well-formed');
    const openEnd = empty ? j + 2 : j + 1;
    const el = { name, attrs, start: lt, end: openEnd, openEnd, closeStart: openEnd, kids: [], empty };
    cur.kids.push(el);
    if (!empty) {
      if (stack.length > lim.depth) refuse('nested too deep');
      stack.push(el);
      cur = el;
    }
    i = openEnd;
  }
  if (stack.length > 1) refuse('not well-formed');
  return root;
}

//  helpers over the tree
export const attr = (el, name) => {
  for (const [k, v] of el.attrs) if (k === name) return decode(v);
  return undefined;
};
export const elements = (el) => el.kids.filter((k) => k.name);
export const child = (el, name) => el.kids.find((k) => k.name === name);

//  the character data of an element, entities decoded, every descendant's
export function textOf(src, el) {
  let out = '';
  const walk = (e) => {
    for (const k of e.kids) {
      if (k.name) walk(k);
      else if (k.text) out += k.cdata ? src.slice(k.start + 9, k.end - 3) : decode(src.slice(k.start, k.end));
    }
  };
  walk(el);
  return out;
}
