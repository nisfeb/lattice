//  view.js: the map. Mounts a map page over a host element: Leaflet with
//  the features drawn on a canvas, a lat/lon grid under the base tiles,
//  a legend by kind, a searchable feature list, a pointer readout in
//  lat/lon and MGRS, a time filter, and other map pages drawn underneath
//  as layers. In Edit it adds the drawing tools (draw.js) and the detail
//  panel.
//
//  The shell's contract is the grid's (ui-src/sheet/view.js): the page's
//  text is the one buffer. Every edit writes the whole body through
//  opts.onText at once, in lattice's layout, so the shell can diff it
//  into the textarea and keep its undo stack. opts.undo and opts.redo run
//  that stack, and the shell then hands the text back through update().
//
//  Features paint before tiles: the vectors go on the map first, and the
//  tile layer is added on the frame after they are drawn.

import * as L from 'leaflet/dist/leaflet-src.esm.js';
import leafletCss from 'leaflet/dist/leaflet.css';
import { forward as toMgrs } from 'mgrs';
import {
  parse, serialize, props, view as readView, sourceLink, bounds, firstPos, fmtPos,
  colorOf, kindColor, ICONS, STYLES,
} from './core.js';
import { attachDraw } from './draw.js';
import { fileKind, importText, exportGpx } from './io.js';

const BASE_CSS = `
lat-map{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;font-size:13px;position:relative}
.lm-bar{display:flex;flex-wrap:wrap;gap:2px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border,#8884);flex:none}
.lm-bar button,.lm-bar select{font:inherit;font-size:13px;min-width:28px;height:28px;padding:0 8px;border:1px solid transparent;border-radius:4px;background:none;color:inherit;cursor:pointer}
.lm-bar select{border-color:var(--border,#8884)}
.lm-bar button:hover:not(:disabled){border-color:var(--border,#8886)}
.lm-bar button.on{background:var(--accent-tint,#8883);border-color:var(--border,#8886)}
.lm-bar button:disabled{opacity:.4;cursor:default}
.lm-bar .lm-sep{flex:none;width:1px;height:20px;background:var(--border,#8884);margin:0 3px}
.lm-bar .lm-grow{flex:1}
.lm-note{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border,#8884);background:var(--note-bg,#f0c04022);flex:none}
.lm-note.lm-ro{background:var(--warn-bg,#e0606022)}
.lm-note span{flex:1}
.lm-note button{font:inherit;font-size:12px;padding:2px 8px;border:1px solid var(--border,#8886);border-radius:4px;background:none;color:inherit;cursor:pointer}
.lm-main{flex:1;min-height:0;display:flex;position:relative}
.lm-map{flex:1;min-width:0;position:relative;background:#eceae4;outline:none}
.lm-map.lm-drawing{cursor:crosshair}
.lm-side{flex:none;width:280px;display:flex;flex-direction:column;border-left:1px solid var(--border,#8884);background:var(--bg,#fff);min-height:0}
.lm-side input,.lm-side textarea,.lm-side select{font:inherit;font-size:13px;box-sizing:border-box;width:100%;padding:3px 6px;border:1px solid var(--border,#8886);border-radius:4px;background:var(--bg,#fff);color:inherit}
.lm-side h4{margin:8px 10px 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#888)}
.lm-legend{padding:0 10px;flex:none;max-height:30%;overflow:auto}
.lm-legend button{display:flex;gap:6px;align-items:center;width:100%;font:inherit;font-size:12px;padding:2px 4px;border:0;background:none;color:inherit;cursor:pointer;text-align:left}
.lm-legend button.off{opacity:.4}
.lm-legend .lm-lnote{font-size:12px;color:var(--muted,#888);padding:2px 4px}
.lm-sw{flex:none;width:10px;height:10px;border-radius:50%}
.lm-search{padding:4px 10px;flex:none}
.lm-list{flex:1;min-height:60px;overflow:auto;padding:0 6px 6px}
.lm-list button{display:flex;gap:6px;align-items:baseline;width:100%;font:inherit;font-size:13px;padding:3px 4px;border:0;border-radius:4px;background:none;color:inherit;cursor:pointer;text-align:left}
.lm-list button:hover{background:var(--accent-tint,#8882)}
.lm-list button.on{background:var(--accent-tint,#8883);font-weight:600}
.lm-list .lm-g{flex:none;width:1.2em;text-align:center}
.lm-list .lm-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lm-list .lm-more{font-size:12px;color:var(--muted,#888);padding:4px}
.lm-detail{flex:none;max-height:55%;overflow:auto;border-top:1px solid var(--border,#8884);padding:6px 10px 10px}
.lm-detail label{display:block;font-size:12px;color:var(--muted,#888);margin-top:6px}
.lm-detail .lm-row{display:flex;gap:6px;align-items:center}
.lm-detail .lm-row>*{flex:1}
.lm-detail .lm-row>button{flex:none}
.lm-detail button{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--border,#8886);border-radius:4px;background:none;color:inherit;cursor:pointer}
.lm-detail .lm-dn{font-weight:600;font-size:14px;margin:2px 0 4px;word-break:break-word}
.lm-detail .lm-md{font-size:13px;word-break:break-word}
.lm-detail .lm-kv{font-size:12px;word-break:break-word}
.lm-detail .lm-kv b{font-weight:600}
.lm-foot{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:3px 8px;border-top:1px solid var(--border,#8884);flex:none;font-size:12px;color:var(--muted,#888);font-variant-numeric:tabular-nums}
.lm-foot input[type=range]{width:120px}
.lm-foot .lm-grow{flex:1}
lat-map.lm-narrow .lm-side{position:absolute;right:0;top:0;bottom:0;z-index:1000;width:min(300px,85%);box-shadow:-4px 0 16px #0003}
lat-map.lm-narrow .lm-side[data-shut]{display:none}
lat-map:not(.lm-narrow) .lm-sidebtn{display:none}
.lm-map .leaflet-container{background:#eceae4}
.lm-map .leaflet-tile-pane .lm-grid{z-index:0}
.lm-map .leaflet-control-attribution{font-size:10px}
`;
let baseIn = false;
function installBase() {
  if (baseIn) return;
  baseIn = true;
  const s = document.createElement('style');
  //  Leaflet's own rules, without the image URLs of the controls lattice
  //  does not use (markers, the layers control): they would load nothing
  //  useful and the map must not fetch outside its own tiles
  s.textContent = leafletCss.replace(/url\([^)]*\)/g, 'none') + BASE_CSS;
  document.head.append(s);
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const btn = (label, title, fn) => {
  const b = el('button', '', label);
  b.type = 'button';
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.onclick = fn;
  return b;
};

//  the lat/lon grid: a canvas per tile, always under the base tiles, so a
//  map with no token, offline or with a failed tile still has a frame
const Grid = L.GridLayer.extend({
  createTile(coords) {
    const c = document.createElement('canvas');
    const sz = this.getTileSize();
    c.width = sz.x; c.height = sz.y;
    const g = c.getContext('2d');
    const map = this._map;
    const nw = map.unproject(coords.scaleBy(sz), coords.z);
    const se = map.unproject(coords.add([1, 1]).scaleBy(sz), coords.z);
    const span = Math.max(se.lng - nw.lng, 1e-9);
    const STEPS = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001];
    const step = STEPS.find((s) => span / s <= 4) || STEPS[STEPS.length - 1];
    g.strokeStyle = 'rgba(120,120,120,0.35)';
    g.fillStyle = 'rgba(110,110,110,0.75)';
    g.font = '10px system-ui,sans-serif';
    g.lineWidth = 1;
    const dec = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    for (let lon = Math.ceil(nw.lng / step) * step; lon <= se.lng; lon += step) {
      const x = Math.round(map.project([nw.lat, lon], coords.z).x - coords.x * sz.x) + 0.5;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, sz.y); g.stroke();
      g.fillText(lon.toFixed(dec), x + 2, 10);
    }
    for (let lat = Math.ceil(se.lat / step) * step; lat <= nw.lat; lat += step) {
      const y = Math.round(map.project([lat, nw.lng], coords.z).y - coords.y * sz.y) + 0.5;
      g.beginPath(); g.moveTo(0, y); g.lineTo(sz.x, y); g.stroke();
      g.fillText(lat.toFixed(dec), 2, y - 2);
    }
    return c;
  },
});

const ll = (p) => [p[1], p[0]];
const AGES = [['all', 0], ['1 hour', 36e5], ['6 hours', 216e5], ['1 day', 864e5], ['3 days', 2592e5], ['1 week', 6048e5], ['30 days', 2592e6], ['1 year', 31536e6]];

//  opts: text, editable, name, cur(), onChange(), onText(text), onRefuse(msg),
//  undo(), redo(), tiles, layer(name), md(text), openSettings(), openPage(name)
export function mount(host, opts = {}) {
  const text = String(opts.text ?? '');
  const parsed = parse(text);
  if (parsed.error) return { error: 'The map editor cannot open this page (' + parsed.error + '), so it shows as JSON.' };
  installBase();
  host.replaceChildren();
  host.classList.remove('lm-narrow');

  const ctl = {};
  let doc = parsed.doc;
  let base = text;
  let wanted = opts.editable !== false;
  const locked = () => !wanted || doc.big;
  let sel = -1;                         // the selected feature
  const hiddenKinds = new Set();
  let maxAge = 0;
  let query = '';
  let dead = false;

  // ── the frame ──────────────────────────────────────────────────────────
  const bar = el('div', 'lm-bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Map');
  const notes = el('div');
  const main = el('div', 'lm-main');
  const mapEl = el('div', 'lm-map');
  mapEl.tabIndex = 0;
  const side = el('div', 'lm-side');
  const legend = el('div', 'lm-legend');
  const search = el('div', 'lm-search');
  const sIn = el('input');
  sIn.type = 'search';
  sIn.placeholder = 'Find a feature';
  sIn.setAttribute('aria-label', 'Find a feature');
  search.append(sIn);
  const list = el('div', 'lm-list');
  list.setAttribute('role', 'list');
  const detail = el('div', 'lm-detail');
  detail.hidden = true;
  side.append(el('h4', '', 'Legend'), legend, search, list, detail);
  main.append(mapEl, side);
  const foot = el('div', 'lm-foot');
  const readout = el('span', 'lm-read', '');
  const timeBox = el('span', 'lm-time');
  foot.append(readout, el('span', 'lm-grow'), timeBox);
  host.append(bar, notes, main, foot);

  ctl.say = (msg, ro) => {
    const n = el('div', 'lm-note' + (ro ? ' lm-ro' : ''));
    n.append(el('span', '', msg));
    if (!ro) { const x = btn('OK', '', () => n.remove()); n.append(x); setTimeout(() => n.remove(), 9000); }
    notes.replaceChildren(...[...notes.children].filter((c) => c.classList.contains('lm-ro')), n);
    return n;
  };
  if (doc.big) ctl.say('This map is large, so lattice shows it without editing. Open it in a GIS tool through a mount to change it.', true);

  // ── the map ────────────────────────────────────────────────────────────
  const renderer = L.canvas({ padding: 0.5, tolerance: 6 });
  const map = L.map(mapEl, {
    preferCanvas: true, renderer, minZoom: 1, worldCopyJump: false, zoomControl: true,
    attributionControl: true, doubleClickZoom: true, boxZoom: false, keyboard: true,
  });
  map.attributionControl.setPrefix('');
  map.createPane('lm-under');
  map.getPane('lm-under').style.zIndex = 390;
  const underRenderer = L.canvas({ padding: 0.5, pane: 'lm-under' });
  new Grid({ tileSize: 256, className: 'lm-grid', zIndex: 0 }).addTo(map);
  const feats = L.layerGroup().addTo(map);
  const under = L.layerGroup().addTo(map);
  const over = L.layerGroup().addTo(map);     // selection handles, drawing previews
  let shapes = [];                            // per feature: its Leaflet layers

  const viewOf = () => readView(doc.lattice);
  const visible = (i) => {
    const f = doc.features[i];
    const p = props(f);
    if (p.kind && hiddenKinds.has(p.kind)) return false;
    if (!p.kind && hiddenKinds.has('')) return false;
    if (maxAge && p.ms !== null && p.ms < Date.now() - maxAge) return false;
    return true;
  };
  //  the Leaflet layers of one geometry, none of them interactive: hits
  //  are found by draw.js's own test, which costs nothing on mouse moves
  function layersOf(g, p, selOn, rend, dim) {
    const out = [];
    if (!g) return out;
    const col = colorOf(p);
    const w = selOn ? 4 : 2;
    const o = { renderer: rend, interactive: false, color: col, weight: w, opacity: dim ? 0.5 : 1 };
    switch (g.type) {
      case 'Point':
        if (p.radius) out.push(L.circle(ll(g.coordinates), { ...o, radius: p.radius, fillOpacity: dim ? 0.05 : 0.12 }));
        out.push(L.circleMarker(ll(g.coordinates), { ...o, radius: selOn ? 8 : 6, color: selOn ? '#111' : '#fff', weight: selOn ? 3 : 1.5, fillColor: col, fillOpacity: dim ? 0.5 : 0.95 }));
        break;
      case 'MultiPoint': for (const c of g.coordinates) out.push(...layersOf({ type: 'Point', coordinates: c }, p, selOn, rend, dim)); break;
      case 'LineString': out.push(L.polyline(g.coordinates.map(ll), o)); break;
      case 'MultiLineString': out.push(L.polyline(g.coordinates.map((l) => l.map(ll)), o)); break;
      case 'Polygon': out.push(L.polygon(g.coordinates.map((r) => r.slice(0, -1).map(ll)), { ...o, fillOpacity: dim ? 0.08 : 0.2 })); break;
      case 'MultiPolygon': out.push(L.polygon(g.coordinates.map((pg) => pg.map((r) => r.slice(0, -1).map(ll))), { ...o, fillOpacity: dim ? 0.08 : 0.2 })); break;
      case 'GeometryCollection': for (const h of g.geometries) out.push(...layersOf(h, p, selOn, rend, dim)); break;
      default:
    }
    return out;
  }
  function drawOne(i) {
    for (const l of shapes[i] || []) feats.removeLayer(l);
    shapes[i] = [];
    if (!visible(i)) return;
    const f = doc.features[i];
    shapes[i] = layersOf(f.geometry, props(f), i === sel, renderer, false);
    for (const l of shapes[i]) feats.addLayer(l);
  }
  function drawAll() {
    feats.clearLayers();
    shapes = new Array(doc.features.length);
    for (let i = 0; i < doc.features.length; i++) drawOne(i);
  }

  // ── tiles: added after the features have painted ───────────────────────
  const T = opts.tiles || null;
  let tiles = null;
  let style = viewOf().base;
  const tileUrl = (s) => String(T.url).replace('{s}', encodeURIComponent(s));
  function addTiles() {
    if (dead || !T || !T.token) return;
    const max = Number.isFinite(T.max) ? T.max : 17;
    //  512 px tiles, asked for one zoom down (zoomOffset), so a request
    //  covers what four 256 px tiles would. The ship's ceiling is the
    //  zoom in the URL, which is the map's zoom less one, so the last real
    //  tile is at map zoom max+1 and Leaflet scales it past that.
    tiles = L.tileLayer(tileUrl(style), {
      tileSize: 512, zoomOffset: -1, minZoom: 1, minNativeZoom: 1, maxNativeZoom: max + 1, maxZoom: max + 3,
      zIndex: 1, attribution: '© Mapbox © OpenStreetMap', updateWhenIdle: true, keepBuffer: 1,
    }).addTo(map);
    map.setMaxZoom(max + 3);
  }
  function setStyle(s) {
    if (!STYLES.includes(s)) return;
    style = s;
    if (tiles) tiles.setUrl(tileUrl(s));
    styleSel.value = s;
  }
  //  "Refresh this area": the tiles in view at this zoom, fetched again
  //  past every cache, then drawn again
  async function refreshArea() {
    if (!tiles) return;
    const urls = [];
    for (const k of Object.keys(tiles._tiles || {})) {
      const t = tiles._tiles[k];
      if (t && t.current) urls.push(tiles.getTileUrl(t.coords));
    }
    const n = Date.now();
    await Promise.all(urls.map((u) => fetch(u + (u.includes('?') ? '&' : '?') + 'r=' + n, { cache: 'reload', credentials: 'same-origin' }).catch(() => null)));
    if (!dead && tiles) tiles.redraw();
    ctl.say(urls.length + ' tiles refreshed');
  }

  // ── the toolbar ────────────────────────────────────────────────────────
  const styleSel = el('select');
  styleSel.setAttribute('aria-label', 'Base map');
  for (const s of STYLES) { const o = el('option', '', s[0].toUpperCase() + s.slice(1)); o.value = s; styleSel.append(o); }
  styleSel.value = style;
  styleSel.onchange = () => {
    setStyle(styleSel.value);
    if (!locked()) write(() => { setLat('base', style); });
  };
  const refreshBtn = btn('Refresh', 'Refresh this area', () => refreshArea());
  const fitBtn = btn('Fit', 'Show every feature', () => fitAll(true));
  const sideBtn = btn('List', 'Legend and features', () => { if (side.dataset.shut != null) delete side.dataset.shut; else side.dataset.shut = ''; });
  sideBtn.className = 'lm-sidebtn';
  const tools = el('span', 'lm-tools');
  const expGj = btn('GeoJSON', 'Download as GeoJSON', () => download(base, '.geojson', 'application/geo+json'));
  const expGpx = btn('GPX', 'Download as GPX', () => download(exportGpx(doc, opts.name || 'map'), '.gpx', 'application/gpx+xml'));
  bar.append(tools, el('span', 'lm-grow'), styleSel, refreshBtn, fitBtn, expGj, expGpx, sideBtn);
  if (!T || !T.token) refreshBtn.hidden = true;
  if (T && !T.token) {
    const n = ctl.say('No base map yet. ', true);
    const a = el('a', '', 'Set a Mapbox token in Settings');
    a.href = '#';
    a.onclick = (e) => { e.preventDefault(); if (opts.openSettings) opts.openSettings(); };
    n.firstChild.append(a, '.');
  }
  function download(body, ext, type) {
    const nm = (String(opts.name || 'map').split('/').pop() || 'map').replace(/[^\w.-]+/g, '_') + ext;
    const u = URL.createObjectURL(new Blob([body], { type }));
    const a = el('a');
    a.href = u; a.download = nm;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }

  // ── writing ────────────────────────────────────────────────────────────
  function setLat(k, v) {
    const l = {};
    for (const key of Object.keys(doc.lattice || {})) Object.defineProperty(l, key, { value: doc.lattice[key], enumerable: true, writable: true, configurable: true });
    if (v === undefined) delete l[k]; else l[k] = v;
    doc.lattice = l;
  }
  //  change the doc, then write the whole body at once. Returns false when
  //  the map is read-only.
  function write(fn) {
    if (locked()) { if (opts.onRefuse && doc.big) opts.onRefuse('the map is too large to edit here'); return false; }
    fn();
    const t = serialize(doc);
    if (t === base) return true;
    base = t;
    if (opts.onChange) opts.onChange();
    if (opts.onText) opts.onText(t);
    return true;
  }

  // ── selection, list, legend, detail ────────────────────────────────────
  function select(i, fly) {
    const was = sel;
    sel = i >= 0 && i < doc.features.length ? i : -1;
    if (was >= 0 && was < doc.features.length) drawOne(was);
    if (sel >= 0) drawOne(sel);
    if (fly && sel >= 0) {
      const b = bounds([doc.features[sel]]);
      if (b) {
        if (b[0] === b[2] && b[1] === b[3]) map.setView(ll([b[0], b[1]]), Math.max(map.getZoom(), 13));
        else map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [30, 30], maxZoom: 16 });
      }
    }
    draw.selected();
    paintList();
    paintDetail();
  }
  function label(f, i) {
    const p = props(f);
    return p.name || `${f.geometry ? f.geometry.type : 'Feature'} ${i + 1}`;
  }
  const LIST_MAX = 500;
  function paintList() {
    const q = query.trim().toLowerCase();
    const rows = [];
    let more = 0;
    for (let i = 0; i < doc.features.length; i++) {
      const f = doc.features[i];
      if (!visible(i)) continue;
      const nm = label(f, i);
      if (q && !nm.toLowerCase().includes(q) && !props(f).kind.toLowerCase().includes(q)) continue;
      if (rows.length >= LIST_MAX) { more++; continue; }
      const p = props(f);
      const b = el('button', i === sel ? 'on' : '');
      b.type = 'button';
      b.setAttribute('role', 'listitem');
      const g = el('span', 'lm-g', p.icon ? ICONS[p.icon] : '●');
      g.style.color = colorOf(p);
      b.append(g, el('span', 'lm-n', nm));
      b.onclick = () => select(i, true);
      rows.push(b);
    }
    if (more) rows.push(el('div', 'lm-more', more + ' more. Search to narrow the list.'));
    if (!rows.length) rows.push(el('div', 'lm-more', doc.features.length ? 'Nothing matches.' : 'No features yet.'));
    list.replaceChildren(...rows);
  }
  const layerNotes = [];
  function paintLegend() {
    const counts = new Map();
    for (const f of doc.features) { const k = props(f).kind; counts.set(k, (counts.get(k) || 0) + 1); }
    const rows = [];
    for (const [k, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const b = el('button', hiddenKinds.has(k) ? 'off' : '');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(!hiddenKinds.has(k)));
      const sw = el('span', 'lm-sw');
      sw.style.background = k ? kindColor(k) : '#2e86c1';
      b.append(sw, el('span', '', (k || 'no kind') + ' (' + n + ')'));
      b.onclick = () => { if (hiddenKinds.has(k)) hiddenKinds.delete(k); else hiddenKinds.add(k); refilter(); };
      rows.push(b);
    }
    for (const t of layerNotes) rows.push(el('div', 'lm-lnote', t));
    legend.replaceChildren(...rows);
  }
  function refilter() {
    if (sel >= 0 && !visible(sel)) sel = -1;
    drawAll();
    draw.selected();
    paintLegend();
    paintList();
    paintDetail();
  }
  sIn.oninput = () => { query = sIn.value; paintList(); };

  function md(t) {
    const d = el('div', 'lm-md');
    if (opts.md) { try { d.innerHTML = opts.md(t); return d; } catch { /* plain below */ } }
    d.textContent = t;
    d.style.whiteSpace = 'pre-wrap';
    return d;
  }
  const KNOWN = ['name', 'note', 'time', 'source', 'kind', 'color', 'icon', 'radius'];
  function paintDetail() {
    if (sel < 0) { detail.hidden = true; detail.replaceChildren(); return; }
    detail.hidden = false;
    const f = doc.features[sel];
    const p = props(f);
    const raw = f.properties && typeof f.properties === 'object' ? f.properties : {};
    const parts = [];
    const g = f.geometry;
    const where = el('div', 'lm-kv');
    where.append(el('b', '', (g ? g.type : 'No shape') + ' '), fmtPos(firstPos(g)) + (g && g.type === 'Point' ? '  ' + mgrsOf(g.coordinates) : ''));
    if (locked()) {
      parts.push(el('div', 'lm-dn', label(f, sel)));
      if (p.kind) parts.push(kv('kind', p.kind));
      if (p.time) parts.push(kv('time', p.time));
      if (p.radius) parts.push(kv('radius', p.radius + ' m'));
      parts.push(where);
      const src = sourceLink(p.source);
      if (src) parts.push(sourceEl(src));
      if (p.note) parts.push(md(p.note));
    } else {
      const field = (lab, input) => { const l = el('label', '', lab); parts.push(l, input); return input; };
      const inp = (k, type = 'text') => { const i = el('input'); i.type = type; i.value = typeof raw[k] === 'string' || typeof raw[k] === 'number' ? String(raw[k]) : ''; i.dataset.k = k; i.setAttribute('aria-label', k); return i; };
      const nm = field('Name', inp('name'));
      nm.onchange = () => setProp('name', nm.value.trim() || undefined);
      const kd = field('Kind', inp('kind'));
      const dl = el('datalist');
      dl.id = 'lm-kinds-' + Math.random().toString(36).slice(2);
      for (const k of new Set(doc.features.map((x) => props(x).kind).filter(Boolean))) { const o = el('option'); o.value = k; dl.append(o); }
      kd.setAttribute('list', dl.id);
      parts.push(dl);
      kd.onchange = () => setProp('kind', kd.value.trim() || undefined);
      const tm = inp('time');
      tm.placeholder = 'YYYY-MM-DDTHH:MM:SSZ';
      const now = btn('Now', 'Set the time to now', () => { tm.value = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); tm.onchange(); });
      const trow = el('div', 'lm-row');
      trow.append(tm, now);
      parts.push(el('label', '', 'Time'), trow);
      tm.onchange = () => {
        const v = tm.value.trim();
        if (v && !Number.isFinite(Date.parse(v))) { ctl.say('That time is not a date lattice can read.'); return; }
        setProp('time', v || undefined);
      };
      const crow = el('div', 'lm-row');
      const col = el('input');
      col.type = 'color';
      col.value = p.color && p.color.length === 7 ? p.color : '#2e86c1';
      col.setAttribute('aria-label', 'color');
      col.dataset.k = 'color';
      col.onchange = () => setProp('color', col.value);
      const ic = el('select');
      ic.setAttribute('aria-label', 'icon');
      ic.dataset.k = 'icon';
      ic.append(Object.assign(el('option', '', 'No icon'), { value: '' }));
      for (const k of Object.keys(ICONS)) ic.append(Object.assign(el('option', '', ICONS[k] + ' ' + k), { value: k }));
      ic.value = p.icon;
      ic.onchange = () => setProp('icon', ic.value || undefined);
      crow.append(col, btn('No colour', 'Use the kind\'s colour', () => setProp('color', undefined)), ic);
      parts.push(el('label', '', 'Colour and icon'), crow);
      if (g && g.type === 'Point') {
        const rd = field('Ring radius, metres', inp('radius', 'number'));
        rd.min = '0';
        rd.onchange = () => { const v = Number(rd.value); setProp('radius', rd.value === '' || !(v > 0) ? undefined : Math.min(v, 2e7)); };
      }
      const sr = field('Source (a URL or a page)', inp('source'));
      sr.onchange = () => setProp('source', sr.value.trim() || undefined);
      const src = sourceLink(p.source);
      if (src) parts.push(sourceEl(src));
      const nt = el('textarea');
      nt.rows = 4;
      nt.value = typeof raw.note === 'string' ? raw.note : '';
      nt.dataset.k = 'note';
      nt.setAttribute('aria-label', 'note');
      parts.push(el('label', '', 'Note (markdown)'), nt);
      nt.onchange = () => setProp('note', nt.value || undefined);
      parts.push(el('label', '', 'Where'), where);
      const del = btn('Delete', 'Delete this feature', () => draw.remove(sel));
      del.className = 'lm-del';
      parts.push(el('div', 'lm-row'), del);
    }
    const others = Object.keys(raw).filter((k) => !KNOWN.includes(k));
    if (others.length) {
      parts.push(el('label', '', 'Other properties'));
      for (const k of others.slice(0, 100)) {
        let v;
        try { v = JSON.stringify(raw[k]); } catch { v = '?'; }
        parts.push(kv(k, v && v.length > 300 ? v.slice(0, 300) + '…' : v));
      }
    }
    detail.replaceChildren(...parts);
  }
  function kv(k, v) { const d = el('div', 'lm-kv'); d.append(el('b', '', k + ': '), String(v)); return d; }
  function sourceEl(src) {
    const d = el('div', 'lm-kv');
    d.append(el('b', '', 'source: '));
    const a = el('a', '', src.url || src.page);
    if (src.url) { a.href = src.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; } else {
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); if (opts.openPage) opts.openPage(src.page); };
    }
    d.append(a);
    return d;
  }
  function setProp(k, v) {
    if (sel < 0) return;
    const i = sel;
    write(() => {
      const f = doc.features[i];
      const p = {};
      const old = f.properties && typeof f.properties === 'object' ? f.properties : {};
      for (const key of Object.keys(old)) Object.defineProperty(p, key, { value: old[key], enumerable: true, writable: true, configurable: true });
      if (v === undefined) delete p[k]; else p[k] = v;
      doc.features[i] = { ...f, properties: p };
    });
    drawOne(i);
    paintLegend();
    paintList();
    if (k === 'radius' || k === 'kind') paintDetail();
  }
  function mgrsOf(c) { try { return toMgrs([c[0], c[1]], 5); } catch { return ''; } }

  // ── the time filter ────────────────────────────────────────────────────
  function paintTime() {
    timeBox.replaceChildren();
    if (!doc.features.some((f) => props(f).ms !== null)) return;
    const r = el('input');
    r.type = 'range'; r.min = '0'; r.max = String(AGES.length - 1); r.step = '1';
    r.value = String(Math.max(0, AGES.findIndex((a) => a[1] === maxAge)));
    r.setAttribute('aria-label', 'Hide features older than');
    const t = el('span', '', 'Showing: ' + (maxAge ? 'the last ' + AGES[r.value][0] : 'all times'));
    r.oninput = () => { maxAge = AGES[r.value][1]; t.textContent = 'Showing: ' + (maxAge ? 'the last ' + AGES[r.value][0] : 'all times'); refilter(); };
    timeBox.append(t, r);
  }

  // ── the pointer readout ────────────────────────────────────────────────
  map.on('mousemove', (e) => {
    const { lat, lng } = e.latlng.wrap();
    readout.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}  ${mgrsOf([lng, lat])}`;
  });

  // ── layers: other map pages underneath, dimmed, never written ──────────
  let layerSeq = 0;
  async function loadLayers() {
    const my = ++layerSeq;
    under.clearLayers();
    layerNotes.length = 0;
    const names = viewOf().layers;
    if (!names.length || !opts.layer) { paintLegend(); return; }
    for (const nm of names) {
      let t = null;
      try { t = await opts.layer(nm); } catch { t = null; }
      if (dead || my !== layerSeq) return;
      const r = t == null ? null : parse(t);
      if (!r || r.error) { layerNotes.push('Layer ' + nm + ' could not be read.'); continue; }
      //  a layer's own layers are not followed, so there is no cycle
      for (const f of r.doc.features) for (const l of layersOf(f.geometry, props(f), false, underRenderer, true)) under.addLayer(l);
      layerNotes.push('Layer: ' + nm + ' (' + r.doc.features.length + ')');
    }
    paintLegend();
  }

  // ── fitting the view ───────────────────────────────────────────────────
  function fitAll(force) {
    const v = viewOf();
    if (!force && v.center) { map.setView(ll(v.center), v.zoom ?? 10); return; }
    const b = bounds(doc.features);
    if (!b) { map.setView([20, 0], 2); return; }
    if (b[0] === b[2] && b[1] === b[3]) map.setView(ll([b[0], b[1]]), 13);
    else map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [30, 30], maxZoom: 16, animate: !!force });
  }

  // ── drawing (draw.js) ──────────────────────────────────────────────────
  const draw = attachDraw({
    L, map, mapEl, over, tools, ctl, opts,
    doc: () => doc,
    sel: () => sel,
    locked,
    visible,
    select,
    write,
    drawOne,
    redrawAll: () => { drawAll(); paintLegend(); paintList(); paintDetail(); paintTime(); },
  });

  // ── keys, drops, size ──────────────────────────────────────────────────
  host.addEventListener('keydown', (e) => {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !inField && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      e.preventDefault();
      if (locked()) return;
      if (e.key === 'y' || e.shiftKey) { if (opts.redo) opts.redo(); } else if (opts.undo) opts.undo();
      return;
    }
    if (inField) return;
    draw.key(e);
  });
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  host.addEventListener('dragover', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) stop(e); });
  host.addEventListener('drop', async (e) => {
    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    if (!files.length) return;
    stop(e);
    await ctl.importFiles(files);
  });
  //  import files (dropped, or handed in by the shell or a test)
  ctl.importFiles = async (files) => {
    if (locked()) { ctl.say('This map is read-only here, so nothing was imported.'); return false; }
    const added = [];
    const said = [];
    for (const file of files) {
      const k = fileKind(file.name);
      if (!k) { said.push(file.name + ': lattice reads .geojson, .json, .gpx and .kml'); continue; }
      const r = importText(k, await file.text(), typeof DOMParser !== 'undefined' ? DOMParser : null);
      if (r.error) { said.push(file.name + ': ' + r.error); continue; }
      added.push(...r.features);
      said.push(file.name + ': ' + r.features.length + ' features' + (r.before ? `, tracks simplified from ${r.before} to ${r.after} points` : ''));
    }
    if (added.length) {
      if (doc.features.length + added.length > 20000) { ctl.say('That would make more than 20000 features, so nothing was imported.'); return false; }
      const from = doc.features.length;
      write(() => { doc.features = doc.features.concat(added); });
      drawAll(); paintLegend(); paintList(); paintTime();
      const b = bounds(doc.features.slice(from));
      if (b) map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [30, 30], maxZoom: 16 });
    }
    if (said.length) ctl.say('Imported ' + said.join('. ') + '.');
    return added.length > 0;
  };
  const narrow = () => {
    const n = host.clientWidth > 0 && host.clientWidth < 640;
    if (n !== host.classList.contains('lm-narrow')) {
      host.classList.toggle('lm-narrow', n);
      if (n) side.dataset.shut = ''; else delete side.dataset.shut;
    }
  };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { narrow(); map.invalidateSize({ pan: false }); }) : null;
  if (ro) { ro.observe(host); ro.observe(mapEl); }
  narrow();

  // ── first paint: features, then tiles ──────────────────────────────────
  fitAll(false);
  drawAll();
  paintLegend();
  paintList();
  paintTime();
  draw.setEditable(!locked());
  const t0 = performance.now();
  //  Leaflet's canvas draws on the next frame. The tiles go on the frame
  //  after that, so the features are on screen first.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (dead) return;
    host.dataset.painted = String(Math.round(performance.now() - t0));
    addTiles();
  }));
  loadLayers();

  // ── the controller ─────────────────────────────────────────────────────
  ctl.base = () => base;
  ctl.update = (t) => {
    const r = parse(t);
    if (r.error) return false;
    const oldLayers = JSON.stringify(viewOf().layers);
    doc = r.doc;
    base = String(t);
    draw.cancel();
    if (sel >= doc.features.length) sel = -1;
    drawAll();
    draw.selected();
    paintLegend(); paintList(); paintDetail(); paintTime();
    const v = viewOf();
    if (v.base !== style) setStyle(v.base);
    if (JSON.stringify(v.layers) !== oldLayers) loadLayers();
    return true;
  };
  ctl.setEditable = (on) => {
    wanted = on !== false;
    draw.setEditable(!locked());
    paintDetail();
  };
  ctl.sync = () => true;
  ctl.destroy = () => {
    dead = true;
    if (ro) ro.disconnect();
    draw.cancel();
    map.remove();
    host.replaceChildren();
  };
  //  for tests: the map and the selected feature
  Object.defineProperty(ctl, '_t', { value: { map, sel: () => sel, select, doc: () => doc, tiles: () => tiles } });
  return ctl;
}
