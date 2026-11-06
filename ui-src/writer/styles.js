//  styles.js: the document's style table, the resolver, CSS from the
//  whitelist, and the automatic-style registry (spec, Styles and
//  automatic-style churn; Rendering fidelity).
//
//  Style names are unique only within a family (13-large has a text style
//  T1 and a table style T1), so every lookup is by family and name.
//
//  Lattice never renames, reorders or deletes a style. Direct formatting
//  needs an automatic style: the registry builds a canonical key for the
//  wanted style (family, parent, the other style:style attributes and
//  each properties element's sorted attributes) and reuses any automatic
//  style with exactly that key, LibreOffice's own included. Only when
//  none matches is a new one appended, named L, the family letter and
//  eight hex digits of a hash of the key (LT3fa9c210): the same
//  formatting gets the same name in every session and on every ship.
import { attr, decode, elements, escAttr } from './xml.js';

const NUL = '\u0000';
const keyOf = (family, name) => family + NUL + name;

//  the attributes of style:style that are its identity, not its look
const ID_ATTRS = new Set(['style:name', 'style:family', 'style:parent-style-name', 'style:display-name']);

//  +readStyles: the style table from the head of a parsed document.
//  `doc` is the office:document element.
export function readStyles(src, doc) {
  const st = {
    styles: new Map(),     // family NUL name -> entry
    defaults: new Map(),   // family -> entry
    fonts: new Map(),      // font-face name -> { family, generic }
    lists: new Map(),      // list style name -> element
    layouts: new Map(),    // page-layout name -> { props }
    masters: [],           // [{ name, layout }]
    autoKeys: new Map(),   // canonical key -> name (first automatic style with it)
    autoNames: new Set(),  // family NUL name of every automatic style
    autoClose: -1,         // offset of </office:automatic-styles>, or -1
    autoEmpty: null,       // the <office:automatic-styles/> element, if empty
    autoMissing: true,
    opaqueRaw: new Map(),  // family NUL opaque -> { inner, other }: the raw XML
  };
  if (!doc) return st;
  for (const sec of elements(doc)) {
    if (sec.name === 'office:font-face-decls') {
      for (const f of elements(sec)) {
        if (f.name !== 'style:font-face') continue;
        st.fonts.set(attr(f, 'style:name'), {
          family: attr(f, 'svg:font-family'),
          generic: attr(f, 'style:font-family-generic'),
        });
      }
    } else if (sec.name === 'office:styles' || sec.name === 'office:automatic-styles') {
      const auto = sec.name === 'office:automatic-styles';
      if (auto) {
        st.autoMissing = false;
        if (sec.empty) st.autoEmpty = sec;
        else st.autoClose = sec.closeStart;
      }
      for (const e of elements(sec)) {
        if (e.name === 'style:style') {
          const entry = styleEntry(src, e, auto);
          st.styles.set(keyOf(entry.family, entry.name), entry);
          const ok = keyOf(entry.family, entry.opaque);
          if (entry.opaque && !st.opaqueRaw.has(ok)) st.opaqueRaw.set(ok, entry.raw);
          if (auto) {
            st.autoNames.add(keyOf(entry.family, entry.name));
            if (!st.autoKeys.has(entry.key)) st.autoKeys.set(entry.key, entry.name);
          }
        } else if (e.name === 'style:default-style') {
          const entry = styleEntry(src, e, false);
          st.defaults.set(entry.family, entry);
        } else if (e.name === 'text:list-style') {
          st.lists.set(attr(e, 'style:name'), e);
        } else if (e.name === 'style:page-layout') {
          const p = elements(e).find((k) => k.name === 'style:page-layout-properties');
          st.layouts.set(attr(e, 'style:name'), { props: p ? props(p) : {} });
        }
      }
    } else if (sec.name === 'office:master-styles') {
      for (const m of elements(sec)) {
        if (m.name !== 'style:master-page') continue;
        st.masters.push({ name: attr(m, 'style:name'), layout: attr(m, 'style:page-layout-name') });
      }
    }
  }
  return st;
}

const props = (el) => {
  const o = {};
  for (const [k, v] of el.attrs) o[k] = decode(v);
  return o;
};

function styleEntry(src, e, auto) {
  const family = attr(e, 'style:family') || '';
  const name = attr(e, 'style:name') || '';
  const parent = attr(e, 'style:parent-style-name') || null;
  const extra = [];
  for (const [k, v] of e.attrs) if (!ID_ATTRS.has(k)) extra.push([k, decode(v)]);
  const pr = {};
  let opaque = '';
  //  the raw XML behind `opaque`, so a new style derived from this one
  //  writes it back: the content of each properties element that has
  //  children, and every other child element
  const raw = { inner: {}, other: [] };
  for (const k of elements(e)) {
    //  a properties element whose only content is attributes takes part
    //  in the key as a sorted property set; anything else (tab stops,
    //  drop caps, background images) only as its exact source text, so
    //  such a style is reused only by an identical one
    if (/^style:[a-z-]+-properties$/.test(k.name)) {
      pr[k.name] = props(k);
      if (elements(k).length) {
        opaque += src.slice(k.openEnd, k.closeStart).replace(/\s+/g, ' ');
        raw.inner[k.name] = src.slice(k.openEnd, k.closeStart);
      }
    } else {
      opaque += src.slice(k.start, k.end).replace(/\s+/g, ' ');
      raw.other.push(src.slice(k.start, k.end));
    }
  }
  const entry = {
    name, family, parent, auto, display: attr(e, 'style:display-name') || name,
    extra, props: pr, opaque, raw,
  };
  entry.key = canonicalKey(entry);
  return entry;
}

//  [name, value] pairs in name order
export const byName = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

//  +canonicalKey: family, parent, the other attributes and each
//  properties element's attributes, all sorted, as one string
export function canonicalKey({ family, parent, extra = [], props: pr = {}, opaque = '' }) {
  const sortPairs = (o) => Object.entries(o).sort(byName);
  const ex = [...extra].sort(byName);
  const pe = Object.keys(pr).sort().map((k) => [k, sortPairs(pr[k])]).filter(([, v]) => v.length);
  return JSON.stringify([family, parent || '', ex, pe, opaque]);
}

//  FNV-1a, 32 bits, over the UTF-16 code units: deterministic everywhere,
//  with no async crypto
export function hash8(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const lookup = (st, family, name) => (name == null ? undefined : st.styles.get(keyOf(family, name)));
export const isAuto = (st, family, name) => st.autoNames.has(keyOf(family, name));

//  +registry: the automatic styles a serialization reuses or adds. One per
//  serialization, so the same input always gives the same output.
export function registry(st) {
  const added = [];            // [{ name, family, xml }]
  const addedKeys = new Map(); // key -> name
  const taken = new Set([...st.styles.keys()]);
  return {
    added,
    //  the name of an automatic style with exactly this content, reusing
    //  the hint, then any existing one, then one added before
    ensure(want, hint) {
      const key = canonicalKey(want);
      if (hint != null) {
        const h = lookup(st, want.family, hint);
        if (h && h.auto && h.key === key) return hint;
      }
      const have = st.autoKeys.get(key) ?? addedKeys.get(key);
      if (have != null) return have;
      const letter = (want.family[0] || 'X').toUpperCase();
      let name = 'L' + letter + hash8(key);
      for (let n = 2; taken.has(keyOf(want.family, name)); n++) name = 'L' + letter + hash8(key) + '-' + n;
      taken.add(keyOf(want.family, name));
      addedKeys.set(key, name);
      const raw = want.opaque ? st.opaqueRaw.get(keyOf(want.family, want.opaque)) : null;
      added.push({ name, family: want.family, xml: autoStyleXml(name, want, raw) });
      return name;
    },
  };
}

//  a new automatic style in LibreOffice's layout, inside
//  office:automatic-styles (one level in), properties sorted. `raw` is
//  the child XML of the style it was derived from (tab stops, drop caps,
//  style:map), written back as it was
export function autoStyleXml(name, { family, parent, extra = [], props: pr = {} }, raw = null) {
  const at = [['style:name', name], ['style:family', family]];
  if (parent) at.push(['style:parent-style-name', parent]);
  for (const p of [...extra].sort(byName)) at.push(p);
  const open = '<style:style' + at.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  const inner = (raw && raw.inner) || {};
  const kids = Object.keys({ ...pr, ...inner }).sort().filter((k) => Object.keys(pr[k] || {}).length || inner[k] != null).map((k) => {
    const tag = '   <' + k + Object.keys(pr[k] || {}).sort().map((a) => ` ${a}="${escAttr(pr[k][a])}"`).join('');
    return inner[k] != null ? tag + '>' + inner[k] + '</' + k + '>' : tag + '/>';
  });
  for (const o of (raw && raw.other) || []) kids.push('   ' + o);
  if (!kids.length) return '  ' + open + '/>\n';
  return '  ' + open + '>\n' + kids.join('\n') + '\n  </style:style>\n';
}

//  +resolve: a style's effective properties for one properties element,
//  through its parent chain and the family's default style
export function resolve(st, family, name, el) {
  const chain = [];
  const seen = new Set();
  let s = lookup(st, family, name);
  while (s && !seen.has(s.name) && chain.length < 64) {
    seen.add(s.name);
    chain.push(s);
    s = lookup(st, family, s.parent);
  }
  const d = st.defaults.get(family);
  const out = {};
  if (d && d.props[el]) Object.assign(out, d.props[el]);
  for (const c of chain.reverse()) if (c.props[el]) Object.assign(out, c.props[el]);
  return out;
}

//  whether a paragraph style is Quotations or inherits from it
export function isQuote(st, name) {
  const seen = new Set();
  let s = lookup(st, 'paragraph', name);
  while (s && !seen.has(s.name)) {
    if (s.name === 'Quotations') return true;
    seen.add(s.name);
    s = lookup(st, 'paragraph', s.parent);
  }
  return name === 'Quotations';
}

export const breaksPage = (st, name) => resolve(st, 'paragraph', name, 'style:paragraph-properties')['fo:break-before'] === 'page';

//  +layout: page width and margins from the first master page's layout
export function layout(st) {
  const m = st.masters[0];
  const p = (m && st.layouts.get(m.layout)?.props) || {};
  const len = (v) => cssLength(v, false) ?? null;
  return {
    width: len(p['fo:page-width']), height: len(p['fo:page-height']),
    marginTop: len(p['fo:margin-top']), marginBottom: len(p['fo:margin-bottom']),
    marginLeft: len(p['fo:margin-left']), marginRight: len(p['fo:margin-right']),
  };
}

// ---------------------------------------------------------------- CSS
//  Every value is rebuilt from a parse against a strict grammar, so no
//  raw ODF string reaches the CSS: no url(, no expression(, no </style>.

const UNITS = new Set(['cm', 'mm', 'in', 'pt', 'pc', 'px']);
export function cssLength(v, pct = true, neg = true) {
  const m = /^(-?)(\d{1,6}(?:\.\d{1,6})?|\.\d{1,6})(cm|mm|in|pt|pc|px|%)$/.exec(String(v ?? '').trim());
  if (!m) return undefined;
  if (m[1] && !neg) return undefined;
  if (m[3] === '%' && !pct) return undefined;
  if (m[3] !== '%' && !UNITS.has(m[3])) return undefined;
  return m[1] + m[2] + m[3];
}
const cssColor = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v ?? '')) ? String(v).toLowerCase() : v === 'transparent' ? 'transparent' : undefined);
const fontName = (v) => {
  const s = String(v ?? '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  return /^[A-Za-z0-9 -]{1,64}$/.test(s) ? s : undefined;
};
const GENERIC = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace', script: 'cursive', decorative: 'fantasy', system: 'sans-serif' };
const KNOWN = {
  'Liberation Serif': '"Liberation Serif", "Times New Roman", Times, serif',
  'Liberation Sans': '"Liberation Sans", Arial, Helvetica, sans-serif',
  'Liberation Mono': '"Liberation Mono", "Courier New", Courier, monospace',
};
function fontStack(st, p) {
  let fam; let gen;
  const fn = p['style:font-name'];
  if (fn != null) {
    const f = st.fonts.get(fn);
    fam = fontName(f?.family ?? fn);
    gen = GENERIC[f?.generic];
  }
  if (!fam && p['fo:font-family'] != null) fam = fontName(p['fo:font-family']);
  if (!fam) return undefined;
  if (KNOWN[fam]) return KNOWN[fam];
  return `"${fam}", ${gen || 'serif'}`;
}
const KEYWORDS = {
  'fo:font-weight': ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'],
  'fo:font-style': ['normal', 'italic', 'oblique'],
  'fo:text-align': ['start', 'end', 'left', 'right', 'center', 'justify'],
  'fo:text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'fo:font-variant': ['normal', 'small-caps'],
};
const ALIGN = { start: 'left', end: 'right' };

//  +css: CSS declarations for a resolved property map (text and
//  paragraph properties merged), from the whitelist only
export function css(st, p) {
  const o = [];
  const put = (k, v) => { if (v !== undefined) o.push(k + ':' + v); };
  const kw = (k) => (KEYWORDS[k].includes(p[k]) ? p[k] : undefined);
  put('font-family', fontStack(st, p));
  put('font-size', cssLength(p['fo:font-size'], true, false));
  put('font-weight', kw('fo:font-weight'));
  put('font-style', kw('fo:font-style'));
  put('color', cssColor(p['fo:color']));
  put('background-color', cssColor(p['fo:background-color']));
  for (const side of ['top', 'bottom', 'left', 'right']) put('margin-' + side, cssLength(p['fo:margin-' + side]));
  put('text-indent', cssLength(p['fo:text-indent']));
  const lh = p['fo:line-height'];
  put('line-height', lh === 'normal' ? 'normal' : cssLength(lh, true, false));
  const ta = kw('fo:text-align');
  put('text-align', ta && (ALIGN[ta] || ta));
  const deco = [];
  const ul = p['style:text-underline-style'];
  if (ul && ul !== 'none' && /^[a-z-]+$/.test(ul)) deco.push('underline');
  const lt = p['style:text-line-through-style'];
  if (lt && lt !== 'none' && /^[a-z-]+$/.test(lt)) deco.push('line-through');
  if (deco.length) put('text-decoration', deco.join(' '));
  put('text-transform', kw('fo:text-transform'));
  put('font-variant', kw('fo:font-variant'));
  const ls = p['fo:letter-spacing'];
  put('letter-spacing', ls === 'normal' ? 'normal' : cssLength(ls, false));
  return o.join(';');
}

//  the CSS of a named or automatic style, parents and defaults included
export function styleCss(st, family, name) {
  const p = { ...resolve(st, family, name, 'style:text-properties') };
  if (family === 'paragraph') Object.assign(p, resolve(st, family, name, 'style:paragraph-properties'));
  return css(st, p);
}

//  the named styles a picker lists, by display name
export function namedStyles(st, family) {
  const out = [];
  for (const s of st.styles.values()) if (!s.auto && s.family === family) out.push({ name: s.name, display: s.display });
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

//  bullet or number, from a list style's first level
export function listKind(st, name) {
  const e = st.lists.get(name);
  const lv = e && elements(e)[0];
  if (!lv) return null;
  return lv.name === 'text:list-level-style-number' ? 'number' : lv.name === 'text:list-level-style-bullet' ? 'bullet' : null;
}
