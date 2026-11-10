//  core.js: a map page's body, in pure JavaScript (no DOM, no Leaflet).
//
//  A map page is a GeoJSON FeatureCollection. This file parses and checks
//  one with hard caps, reads the few properties lattice shows, and writes
//  the body back in lattice's layout: the `lattice` view member first,
//  then one feature per line, so a moved point is a one-line diff.
//
//  The ship (/lib/lattice-geojson) parses the same body. A body written
//  by someone else is accepted as any valid FeatureCollection and keeps
//  its own layout until lattice next edits it. Unknown members and
//  properties are kept.

export const BIG = 2 * 1024 * 1024;        // over this, the map is read-only
export const MAX_TEXT = 16 * 1024 * 1024;  // over this, it is not parsed at all
export const MAX_FEATURES = 20000;
export const MAX_POSITIONS = 200000;
export const MAX_DEPTH = 12;               // brackets deep, members included
export const STYLES = ['streets', 'outdoors', 'satellite', 'dark'];
export const MAX_LAYERS = 20;
//  icon names a feature may carry, each with the glyph lattice shows for it
export const ICONS = Object.freeze({
  dot: '•', pin: '⌖', star: '★', flag: '⚑', home: '⌂', camera: '◉',
  alert: '⚠', person: '☺', car: '▣', boat: '⛵', plane: '✈', fire: '♨',
  water: '≈', tent: '△', cross: '✚', question: '?',
});
export const BLANK = '{"type":"FeatureCollection","lattice":{},"features":[\n]}\n';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (n) => typeof n === 'number' && Number.isFinite(n);
//  set an own key, never a setter: a parsed "__proto__" stays plain data
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

//  the deepest bracket nesting in a JSON text, strings skipped. A linear
//  scan, so a body of a million `[` is refused before JSON.parse sees it.
export function depthOf(t) {
  let d = 0, max = 0, inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;
      else if (c === 34) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 91 || c === 123) { if (++d > max) max = d; }
    else if (c === 93 || c === 125) d--;
  }
  return max;
}

//  ── checking ──────────────────────────────────────────────────────────

class Refusal extends Error {}
const no = (m) => { throw new Refusal(m); };

function position(p, n) {
  if (!Array.isArray(p) || p.length < 2 || p.length > 4) no('a position is not [lon, lat]');
  for (const v of p) if (!fin(v)) no('a coordinate is not a number');
  if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) no('a coordinate is outside the world');
  if (++n.pos > MAX_POSITIONS) no(`more than ${MAX_POSITIONS} positions`);
}
function positions(a, n, min) {
  if (!Array.isArray(a)) no('coordinates are not a list');
  if (a.length > MAX_POSITIONS) no(`more than ${MAX_POSITIONS} positions`);
  if (a.length < min) no('a line or ring has too few positions');
  for (const p of a) position(p, n);
}
function rings(a, n) {
  if (!Array.isArray(a)) no('coordinates are not a list');
  for (const r of a) positions(r, n, 4);
}
function geometry(g, n, inner) {
  if (g === null) return;
  if (!isObj(g)) no('a geometry is not an object');
  const c = g.coordinates;
  switch (g.type) {
    case 'Point': position(c, n); break;
    case 'MultiPoint': positions(c, n, 0); break;
    case 'LineString': positions(c, n, 2); break;
    case 'MultiLineString':
      if (!Array.isArray(c)) no('coordinates are not a list');
      for (const l of c) positions(l, n, 2);
      break;
    case 'Polygon': rings(c, n); break;
    case 'MultiPolygon':
      if (!Array.isArray(c)) no('coordinates are not a list');
      for (const p of c) rings(p, n);
      break;
    case 'GeometryCollection':
      if (inner) no('a geometry collection inside another');
      if (!Array.isArray(g.geometries)) no('a geometry collection has no geometries');
      for (const h of g.geometries) { if (h === null) no('a null geometry in a collection'); geometry(h, n, true); }
      break;
    default: no('an unknown geometry type');
  }
}

//  parse(text) -> { doc } | { error }
//    doc: { lattice, features, extra, big }
//      lattice   the view member, as written (an object)
//      features  the features, as parsed (each one checked)
//      extra     the collection's other members, in order, kept
//      big       over BIG: shown, never edited
export function parse(text) {
  const t = String(text ?? '');
  if (t.length > MAX_TEXT) return { error: 'the page is too large to show as a map' };
  if (!t.trim()) return { error: 'the page is empty' };
  if (depthOf(t) > MAX_DEPTH) return { error: 'the JSON is nested too deeply' };
  let j;
  try { j = JSON.parse(t); } catch (e) { return { error: 'the page is not valid JSON' }; }
  try {
    if (!isObj(j) || j.type !== 'FeatureCollection') no('the page is not a GeoJSON FeatureCollection');
    if (!Array.isArray(j.features)) no('the collection has no features list');
    if (j.features.length > MAX_FEATURES) no(`more than ${MAX_FEATURES} features`);
    const n = { pos: 0 };
    for (const f of j.features) {
      if (!isObj(f) || f.type !== 'Feature') no('a feature is not a Feature');
      if (!own(f, 'geometry')) no('a feature has no geometry');
      geometry(f.geometry, n, false);
      if (own(f, 'properties') && f.properties !== null && !isObj(f.properties)) no('a feature\'s properties are not an object');
    }
    if (own(j, 'lattice') && !isObj(j.lattice)) no('the lattice member is not an object');
  } catch (e) {
    if (e instanceof Refusal) return { error: e.message };
    return { error: 'the page cannot be read as a map' };
  }
  const extra = [];
  for (const k of Object.keys(j)) if (k !== 'type' && k !== 'lattice' && k !== 'features') extra.push([k, j[k]]);
  return { doc: { lattice: own(j, 'lattice') ? j.lattice : {}, features: j.features, extra, big: t.length > BIG } };
}

//  ── writing ───────────────────────────────────────────────────────────

const r7 = (v) => (fin(v) ? Math.round(v * 1e7) / 1e7 : v);
//  a geometry with every coordinate rounded to 7 places (about 1 cm)
export function roundGeom(g) {
  if (!g) return g;
  const deep = (c) => (Array.isArray(c) && typeof c[0] === 'number' ? c.map(r7) : Array.isArray(c) ? c.map(deep) : c);
  const out = {};
  for (const k of Object.keys(g)) {
    if (k === 'coordinates') put(out, k, deep(g[k]));
    else if (k === 'geometries' && Array.isArray(g[k])) put(out, k, g[k].map(roundGeom));
    else put(out, k, g[k]);
  }
  return out;
}
//  one feature, on one line: type, geometry, properties, id, then the rest
export function featureLine(f) {
  const o = { type: 'Feature', geometry: roundGeom(f.geometry ?? null), properties: own(f, 'properties') ? f.properties : {} };
  if (own(f, 'id')) o.id = f.id;
  for (const k of Object.keys(f)) if (!own(o, k) && k !== 'type') put(o, k, f[k]);
  return JSON.stringify(o);
}
//  the body in lattice's layout
export function serialize(doc) {
  let s = '{"type":"FeatureCollection","lattice":' + JSON.stringify(doc.lattice || {});
  for (const [k, v] of doc.extra || []) s += ',' + JSON.stringify(k) + ':' + JSON.stringify(v);
  const lines = doc.features.map(featureLine);
  return s + ',"features":[\n' + (lines.length ? lines.join(',\n') + '\n' : '') + ']}\n';
}

//  ── what lattice reads ────────────────────────────────────────────────

const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '');
export const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
//  a feature's properties as lattice shows them, every one checked
export function props(f) {
  const p = isObj(f && f.properties) ? f.properties : {};
  const g = (k) => (own(p, k) ? p[k] : undefined);
  const time = str(g('time'), 64);
  const ms = time ? Date.parse(time) : NaN;
  const r = g('radius');
  const icon = str(g('icon'), 20);
  const color = str(g('color'), 7);
  return {
    name: str(g('name'), 300),
    note: str(g('note'), 100000),
    time: Number.isFinite(ms) ? time : '',
    ms: Number.isFinite(ms) ? ms : null,
    source: str(g('source'), 2000),
    kind: str(g('kind'), 40).trim(),
    color: COLOR.test(color) ? color : '',
    icon: own(ICONS, icon) ? icon : '',
    radius: fin(r) && r > 0 && r <= 2e7 ? r : 0,
  };
}
//  a source as something to link: an http(s) URL, a lattice page, or none
export function sourceLink(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  if (/^https?:\/\/[^\s]+$/i.test(v)) {
    try { const u = new URL(v); if (u.protocol === 'http:' || u.protocol === 'https:') return { url: u.href }; } catch { /* not a URL */ }
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;   // another scheme: never a link
  const page = v.replace(/^\[\[|\]\]$/g, '').replace(/^\/+/, '');
  return /^[A-Za-z0-9~._-]+(?:\/[A-Za-z0-9~._-]+)*$/.test(page) && !/(^|\/)\.\.?(\/|$)/.test(page) ? { page } : null;
}
//  the view member, every field checked
export function view(lat) {
  const l = isObj(lat) ? lat : {};
  const c = l.center;
  const center = Array.isArray(c) && c.length === 2 && fin(c[0]) && fin(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90 ? [c[0], c[1]] : null;
  return {
    title: str(l.title, 300),
    center,
    zoom: fin(l.zoom) && l.zoom >= 0 && l.zoom <= 22 ? l.zoom : null,
    base: STYLES.includes(l.base) ? l.base : 'streets',
    layers: Array.isArray(l.layers) ? l.layers.filter((x) => typeof x === 'string' && x && x.length < 400).slice(0, MAX_LAYERS) : [],
  };
}
//  the map's title: lattice.title, else the first feature's name, else ''
export function title(doc) {
  const v = view(doc.lattice);
  if (v.title) return v.title;
  for (const f of doc.features) { const n = props(f).name; if (n) return n; }
  return '';
}
//  the words search finds a map by: its title, names, kinds and notes
export function text(body) {
  const r = parse(body);
  if (r.error) return '';
  const out = [];
  const t = view(r.doc.lattice).title;
  if (t) out.push(t);
  for (const f of r.doc.features) {
    const p = props(f);
    if (p.name) out.push(p.name);
    if (p.kind) out.push(p.kind);
    if (p.note) out.push(p.note);
  }
  return out.join('\n');
}
//  the outline: one row per named feature, [{ level, text }]
export function outline(body) {
  const r = parse(body);
  if (r.error) return [];
  const out = [];
  for (const f of r.doc.features) {
    const n = props(f).name;
    if (n) out.push({ level: 1, text: n });
    if (out.length >= 500) break;
  }
  return out;
}

//  ── geometry helpers ──────────────────────────────────────────────────

//  every [lon, lat] of a geometry, in order
export function eachPos(g, fn) {
  if (!g) return;
  const walk = (c) => { if (typeof c[0] === 'number') fn(c); else for (const x of c) walk(x); };
  if (g.type === 'GeometryCollection') { for (const h of g.geometries) eachPos(h, fn); return; }
  if (Array.isArray(g.coordinates)) walk(g.coordinates);
}
//  [w, s, e, n] of some features, or null when they have no positions
export function bounds(features) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) {
    eachPos(f.geometry, (p) => {
      if (p[0] < w) w = p[0];
      if (p[0] > e) e = p[0];
      if (p[1] < s) s = p[1];
      if (p[1] > n) n = p[1];
    });
  }
  return w === Infinity ? null : [w, s, e, n];
}
//  a feature's first position, for the list and the table
export function firstPos(g) {
  let out = null;
  try { eachPos(g, (p) => { if (!out) { out = p; throw 0; } }); } catch { /* found */ }
  return out;
}
export const fmtPos = (p) => (p ? `${p[1].toFixed(5)}, ${p[0].toFixed(5)}` : '');

//  Douglas-Peucker on [lon, lat] positions, iterative so a long track
//  cannot overflow the stack. Keeps the first and last positions.
export function dp(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let far = -1, fd = t2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0], py = pts[i][1];
      let d;
      if (!len) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
        d = (ax + u * dx - px) ** 2 + (ay + u * dy - py) ** 2;
      }
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
//  drop each position nearer than tol to the last one kept: one linear
//  pass, so Douglas-Peucker then works on far fewer positions
export function radial(pts, tol) {
  const t2 = tol * tol, out = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], dx = p[0] - last[0], dy = p[1] - last[1];
    if (dx * dx + dy * dy > t2) { out.push(p); last = p; }
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  return out;
}
export const SIMPLIFY_TO = 500;
//  a line of more than SIMPLIFY_TO positions, simplified until it fits.
//  The tolerance starts at a ten-thousandth of the line's extent (about
//  15 m on a track a degree across, never under a metre) and doubles. A
//  tiny start keeps nearly every point and costs far more on a long line.
export function simplify(pts, target = SIMPLIFY_TO) {
  if (pts.length <= target) return pts;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
  let tol = Math.max(0.00001, Math.hypot(e - w, n - s) * 1e-4), out = pts;
  while (out.length > target && tol < 1) { out = dp(radial(pts, tol), tol); tol *= 2; }
  return out;
}
//  a feature with its long lines simplified -> [feature, before, after]
export function simplifyFeature(f) {
  const g = f.geometry;
  if (!g) return [f, 0, 0];
  let before = 0, after = 0;
  const line = (c) => { before += c.length; const s = simplify(c); after += s.length; return s; };
  let ng = g;
  if (g.type === 'LineString') ng = { ...g, coordinates: line(g.coordinates) };
  else if (g.type === 'MultiLineString') ng = { ...g, coordinates: g.coordinates.map(line) };
  else return [f, 0, 0];
  return [{ ...f, geometry: ng }, before, after];
}

//  ── the tile-free render, for the preview, print and peers ────────────

export const RENDER_MAX = 2000;
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const KIND_COLORS = ['#c0392b', '#2e86c1', '#28a745', '#8e44ad', '#d68910', '#16a085', '#7f8c8d', '#e84393'];
export function kindColor(kind) {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) | 0;
  return KIND_COLORS[Math.abs(h) % KIND_COLORS.length];
}
export const colorOf = (p) => p.color || (p.kind ? kindColor(p.kind) : '#2e86c1');

//  the features drawn as an SVG in an equirectangular projection fitted to
//  their bounds, and a table of them. Nothing from the page is markup.
export function renderBody(doc) {
  const fs = doc.features.slice(0, RENDER_MAX);
  const W = 800;
  const b = bounds(fs);
  let svg = '';
  if (b) {
    const mid = ((b[1] + b[3]) / 2) * Math.PI / 180;
    const k = Math.max(Math.cos(mid), 0.05);
    let w = (b[2] - b[0]) * k, h = b[3] - b[1];
    const pad = Math.max(w, h, 0.01) * 0.05;
    w = Math.max(w, 0.01); h = Math.max(h, 0.01);
    const sx = (lon) => ((lon - b[0]) * k + pad);
    const sy = (lat) => (b[3] - lat + pad);
    const vw = w + 2 * pad, vh = h + 2 * pad;
    const H = Math.max(120, Math.min(600, Math.round(W * vh / vw)));
    const sw = vw / W;   // one screen pixel in view units
    const pt = (p) => `${sx(p[0]).toFixed(6)},${sy(p[1]).toFixed(6)}`;
    const ring = (r) => 'M' + r.map(pt).join('L') + 'Z';
    let shapes = '';
    const draw = (g, col) => {
      if (!g) return;
      switch (g.type) {
        case 'Point': shapes += `<circle cx="${sx(g.coordinates[0]).toFixed(6)}" cy="${sy(g.coordinates[1]).toFixed(6)}" r="${(4 * sw).toFixed(6)}" fill="${col}"/>`; break;
        case 'MultiPoint': for (const p of g.coordinates) draw({ type: 'Point', coordinates: p }, col); break;
        case 'LineString': shapes += `<polyline points="${g.coordinates.map(pt).join(' ')}" fill="none" stroke="${col}" stroke-width="${(2 * sw).toFixed(6)}"/>`; break;
        case 'MultiLineString': for (const l of g.coordinates) draw({ type: 'LineString', coordinates: l }, col); break;
        case 'Polygon': shapes += `<path d="${g.coordinates.map(ring).join('')}" fill="${col}" fill-opacity="0.2" fill-rule="evenodd" stroke="${col}" stroke-width="${(1.5 * sw).toFixed(6)}"/>`; break;
        case 'MultiPolygon': for (const p of g.coordinates) draw({ type: 'Polygon', coordinates: p }, col); break;
        case 'GeometryCollection': for (const h2 of g.geometries) draw(h2, col); break;
        default:
      }
    };
    for (const f of fs) draw(f.geometry, colorOf(props(f)));
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw.toFixed(6)} ${vh.toFixed(6)}" width="100%" style="max-width:${W}px;height:auto;max-height:${H}px;border:1px solid #8886;background:#f4f4f0" role="img" aria-label="Map outline">${shapes}</svg>`;
  }
  let rows = '';
  for (const f of fs) {
    const p = props(f);
    const g = f.geometry;
    rows += `<tr><td>${esc(p.name)}</td><td>${esc(p.kind)}</td><td>${esc(g ? g.type : '')}</td><td>${esc(p.time)}</td><td>${esc(fmtPos(firstPos(g)))}</td></tr>`;
  }
  const more = doc.features.length > RENDER_MAX ? `<p class="n">${doc.features.length - RENDER_MAX} more features not shown.</p>` : '';
  const t = title(doc);
  return (t ? `<h2>${esc(t)}</h2>` : '') + svg
    + (fs.length ? `<table><thead><tr><th>Name</th><th>Kind</th><th>Shape</th><th>Time</th><th>Lat, lon</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="n">No features yet.</p>')
    + more;
}
//  render(text) -> an HTML document, or null when it is not a map
export function render(body, print = false) {
  const r = parse(body);
  if (r.error) return null;
  const css = 'body{font:13px/1.4 system-ui,sans-serif;margin:12px;color:#1a1a1a;background:#fff}'
    + 'h2{font-size:16px;margin:0 0 8px}table{border-collapse:collapse;margin-top:10px}'
    + 'th,td{border:1px solid #8886;padding:2px 6px;text-align:left;vertical-align:top}'
    + '.n{color:#888;font-size:12px}'
    + (print ? '@page{margin:12mm}tr{break-inside:avoid}' : '@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e6e6e6}}');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body class="geojson">${renderBody(r.doc)}</body></html>`;
}
