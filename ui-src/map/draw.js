//  draw.js: lattice's own drawing tools on Leaflet's layers. No Geoman,
//  no Leaflet.draw: points, lines, areas and rings, a dragged point or
//  shape, dragged vertices of the selected shape, and delete.
//
//  Hits are found here, in screen pixels, rather than by Leaflet's
//  interactive layers, so the map spends nothing on pointer moves and
//  touch and mouse take the same path (pointer events). Every finished
//  edit goes through the view's write(), which writes the whole body.

import { props } from './core.js';

const TOL = 10;          // px: how near a click must be to hit a shape
const HANDLE_TOL = 12;   // px: to grab a vertex
const MAX_HANDLES = 1000;

const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
const clampLat = (y) => Math.max(-89.9999999, Math.min(89.9999999, y));
const pos = (latlng) => { const w = latlng.wrap(); return [w.lng, clampLat(w.lat)]; };

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const u = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
}
function inside(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
//  a deep copy of a geometry's coordinates
const copyGeom = (g) => JSON.parse(JSON.stringify(g));

export function attachDraw(x) {
  const { L, map, mapEl, over, tools } = x;
  let tool = 'select';
  let verts = [];            // the shape being drawn: [lon, lat]
  let centre = null;         // a ring's centre
  let editable = false;
  let preview = [];
  let handles = [];          // [{ path, pt }] of the selected shape
  let drag = null;
  let justDragged = false;   // the next click ends a drag, and is not one
  let cursor = null;

  const proj = (p) => map.latLngToContainerPoint([p[1], p[0]]);

  // ── the tools ──────────────────────────────────────────────────────────
  const B = {};
  const mk = (id, label, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.dataset.tool = id;
    b.onclick = () => setTool(id);
    B[id] = b;
    return b;
  };
  const done = document.createElement('button');
  done.type = 'button';
  done.textContent = 'Done';
  done.title = 'Finish the shape (Enter)';
  done.hidden = true;
  done.onclick = () => finish();
  const del = document.createElement('button');
  del.type = 'button';
  del.textContent = 'Delete';
  del.title = 'Delete the selected feature (Delete)';
  del.onclick = () => { if (x.sel() >= 0) remove(x.sel()); };
  tools.append(mk('select', 'Select', 'Select and move'), mk('point', 'Point', 'Draw a point'),
    mk('line', 'Line', 'Draw a line'), mk('area', 'Area', 'Draw an area'),
    mk('ring', 'Ring', 'Draw a ring: the centre, then its edge'), done, del);

  function setTool(t) {
    cancel();
    tool = t;
    for (const k of Object.keys(B)) B[k].classList.toggle('on', k === tool);
    mapEl.classList.toggle('lm-drawing', tool !== 'select');
    if (tool === 'select') map.doubleClickZoom.enable(); else map.doubleClickZoom.disable();
    paintHandles();
  }
  function setEditable(on) {
    editable = on;
    tools.hidden = !on;
    if (!on) setTool('select');
    paintHandles();
    del.disabled = x.sel() < 0;
  }

  // ── what is under a point ──────────────────────────────────────────────
  function distOf(g, p, radius) {
    if (!g) return Infinity;
    switch (g.type) {
      case 'Point': {
        const c = proj(g.coordinates);
        const d = Math.hypot(c.x - p.x, c.y - p.y) * 0.5;   // points win
        if (!radius) return d;
        const edge = proj([g.coordinates[0], clampLat(g.coordinates[1] + radius / 111320)]);
        const r = Math.abs(edge.y - c.y);
        const dc = Math.hypot(c.x - p.x, c.y - p.y);
        return Math.min(d, dc <= r ? TOL * 0.8 : Math.abs(dc - r));
      }
      case 'MultiPoint': return Math.min(...g.coordinates.map((c) => distOf({ type: 'Point', coordinates: c }, p, radius)));
      case 'LineString': {
        let best = Infinity, prev = null;
        for (const c of g.coordinates) { const q = proj(c); if (prev) best = Math.min(best, segDist(p, prev, q)); prev = q; }
        return best;
      }
      case 'MultiLineString': return Math.min(...g.coordinates.map((l) => distOf({ type: 'LineString', coordinates: l }, p)));
      case 'Polygon': {
        const rings = g.coordinates.map((r) => r.map(proj));
        let inn = false, best = Infinity;
        rings.forEach((r) => { if (inside(p, r)) inn = !inn; for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(p, r[i - 1], r[i])); });
        return inn ? Math.min(best, TOL * 0.9) : best;
      }
      case 'MultiPolygon': return Math.min(...g.coordinates.map((c) => distOf({ type: 'Polygon', coordinates: c }, p)));
      case 'GeometryCollection': return Math.min(Infinity, ...g.geometries.map((h) => distOf(h, p, radius)));
      default: return Infinity;
    }
  }
  function hit(p) {
    const fs = x.doc().features;
    let best = -1, bd = TOL;
    for (let i = fs.length - 1; i >= 0; i--) {
      if (!x.visible(i)) continue;
      const d = distOf(fs[i].geometry, p, props(fs[i]).radius);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ── handles of the selected shape ──────────────────────────────────────
  function handlePaths(g) {
    const out = [];
    const add = (c, path) => out.push({ path, c });
    if (!g) return out;
    switch (g.type) {
      case 'LineString': g.coordinates.forEach((c, i) => add(c, [i])); break;
      case 'MultiLineString': g.coordinates.forEach((l, j) => l.forEach((c, i) => add(c, [j, i]))); break;
      case 'Polygon': g.coordinates.forEach((r, j) => r.slice(0, -1).forEach((c, i) => add(c, [j, i]))); break;
      case 'MultiPolygon': g.coordinates.forEach((pg, k) => pg.forEach((r, j) => r.slice(0, -1).forEach((c, i) => add(c, [k, j, i])))); break;
      default:
    }
    return out.length > MAX_HANDLES ? [] : out;
  }
  function paintHandles() {
    for (const h of handles) over.removeLayer(h.layer);
    handles = [];
    del.disabled = x.sel() < 0;
    const i = x.sel();
    if (!editable || tool !== 'select' || i < 0 || x.locked()) return;
    const g = x.doc().features[i].geometry;
    for (const h of handlePaths(g)) {
      const layer = L.circleMarker([h.c[1], h.c[0]], { radius: 5, color: '#111', weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(over);
      handles.push({ ...h, layer });
    }
  }

  // ── dragging: a vertex, or the whole selected feature ──────────────────
  function setAt(g, path, c) {
    const t = g.type;
    if (t === 'LineString') g.coordinates[path[0]] = c;
    else if (t === 'MultiLineString') g.coordinates[path[0]][path[1]] = c;
    else if (t === 'Polygon') {
      const r = g.coordinates[path[0]];
      r[path[1]] = c;
      if (path[1] === 0) r[r.length - 1] = c;
    } else if (t === 'MultiPolygon') {
      const r = g.coordinates[path[0]][path[1]];
      r[path[2]] = c;
      if (path[2] === 0) r[r.length - 1] = c;
    }
  }
  function shift(g, dlon, dlat) {
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        c[0] = Math.max(-180, Math.min(180, c[0] + dlon));
        c[1] = clampLat(c[1] + dlat);
        return;
      }
      for (const y of c) walk(y);
    };
    if (g.type === 'GeometryCollection') for (const h of g.geometries) shift(h, dlon, dlat);
    else walk(g.coordinates);
  }
  mapEl.addEventListener('pointerdown', (e) => {
    justDragged = false;
    if (!editable || x.locked() || tool !== 'select' || e.button > 0) return;
    const i = x.sel();
    if (i < 0) return;
    const r = mapEl.getBoundingClientRect();
    const p = L.point(e.clientX - r.left, e.clientY - r.top);
    let vh = null;
    for (const h of handles) {
      const q = proj(h.c);
      if (Math.hypot(q.x - p.x, q.y - p.y) <= HANDLE_TOL) { vh = h; break; }
    }
    if (!vh && hit(p) !== i) return;
    const f = x.doc().features[i];
    if (!f.geometry) return;
    e.preventDefault();
    e.stopPropagation();
    map.dragging.disable();
    try { mapEl.setPointerCapture(e.pointerId); } catch { /* fine without */ }
    drag = { i, vh, start: map.containerPointToLatLng(p), orig: copyGeom(f.geometry), moved: false, id: e.pointerId, raf: 0 };
  }, true);
  mapEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopPropagation();
    const r = mapEl.getBoundingClientRect();
    const at = map.containerPointToLatLng(L.point(e.clientX - r.left, e.clientY - r.top));
    const f = x.doc().features[drag.i];
    const g = copyGeom(drag.orig);
    if (drag.vh) setAt(g, drag.vh.path, pos(at));
    else shift(g, at.lng - drag.start.lng, at.lat - drag.start.lat);
    x.doc().features[drag.i] = { ...f, geometry: g };
    drag.moved = true;
    if (!drag.raf) drag.raf = requestAnimationFrame(() => { if (drag) { drag.raf = 0; x.drawOne(drag.i); paintHandles(); } });
  }, true);
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const d = drag;
    drag = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    map.dragging.enable();
    if (!d.moved) return;
    justDragged = true;
    if (e.type === 'pointercancel') {
      const f = x.doc().features[d.i];
      x.doc().features[d.i] = { ...f, geometry: d.orig };
    } else x.write(() => {});
    x.drawOne(d.i);
    paintHandles();
  };
  mapEl.addEventListener('pointerup', endDrag, true);
  mapEl.addEventListener('pointercancel', endDrag, true);

  // ── clicks: select, or draw ────────────────────────────────────────────
  map.on('click', (e) => {
    if (justDragged) { justDragged = false; return; }
    if (tool === 'select' || !editable || x.locked()) { x.select(hit(e.containerPoint)); return; }
    const c = pos(e.latlng);
    if (tool === 'point') { add({ type: 'Point', coordinates: c }, {}); return; }
    if (tool === 'ring') {
      if (!centre) { centre = c; paintPreview(); return; }
      const rad = Math.round(map.distance([centre[1], centre[0]], e.latlng));
      if (rad > 0) add({ type: 'Point', coordinates: centre }, { radius: rad });
      centre = null;
      paintPreview();
      setTool('select');
      return;
    }
    //  a line or an area: one vertex per click, a near repeat dropped
    const last = verts[verts.length - 1];
    if (last) { const a = proj(last), b = e.containerPoint; if (Math.hypot(a.x - b.x, a.y - b.y) < 3) return; }
    verts.push(c);
    done.hidden = false;
    paintPreview();
  });
  map.on('dblclick', () => { if (tool === 'line' || tool === 'area') finish(); });
  map.on('mousemove', (e) => { if (tool !== 'select' && (verts.length || centre)) { cursor = pos(e.latlng); paintPreview(); } });

  function paintPreview() {
    for (const l of preview) over.removeLayer(l);
    preview = [];
    const st = { color: '#e67e22', weight: 2, dashArray: '5 5', interactive: false };
    if (centre) {
      preview.push(L.circleMarker([centre[1], centre[0]], { ...st, radius: 4, dashArray: null }));
      if (cursor) preview.push(L.circle([centre[1], centre[0]], { ...st, radius: map.distance([centre[1], centre[0]], [cursor[1], cursor[0]]), fillOpacity: 0.05 }));
    }
    if (verts.length) {
      const pts = verts.concat(cursor ? [cursor] : []).map((c) => [c[1], c[0]]);
      preview.push(tool === 'area' && pts.length > 2 ? L.polygon(pts, { ...st, fillOpacity: 0.1 }) : L.polyline(pts, st));
      for (const c of verts) preview.push(L.circleMarker([c[1], c[0]], { ...st, radius: 3, dashArray: null }));
    }
    for (const l of preview) over.addLayer(l);
  }
  function finish() {
    const v = verts;
    if (tool === 'line' && v.length >= 2) add({ type: 'LineString', coordinates: v }, {});
    else if (tool === 'area' && v.length >= 3) add({ type: 'Polygon', coordinates: [v.concat([v[0]])] }, {});
    else { cancel(); return; }
    setTool('select');
  }
  function cancel() {
    verts = [];
    centre = null;
    cursor = null;
    done.hidden = true;
    paintPreview();
  }
  function add(geometry, properties) {
    let i = -1;
    const ok = x.write(() => { const fs = x.doc().features; fs.push({ type: 'Feature', geometry, properties }); i = fs.length - 1; });
    cancel();
    if (!ok) return;
    x.redrawAll();
    x.select(i, false);
  }
  function remove(i) {
    if (i < 0) return;
    const ok = x.write(() => { x.doc().features.splice(i, 1); });
    if (!ok) return;
    x.select(-1);
    x.redrawAll();
  }

  function key(e) {
    if (e.key === 'Escape') {
      if (verts.length || centre) cancel(); else if (tool !== 'select') setTool('select'); else x.select(-1);
      e.preventDefault();
    } else if (e.key === 'Enter' && (tool === 'line' || tool === 'area')) { finish(); e.preventDefault(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && editable && !x.locked() && x.sel() >= 0 && tool === 'select') { remove(x.sel()); e.preventDefault(); }
  }

  setTool('select');
  return { setEditable, cancel: () => { cancel(); drag = null; map.dragging.enable(); }, key, remove, selected: paintHandles, tool: () => tool, setTool };
}

