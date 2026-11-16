//  io.js: files in and out of a map page. Import reads GeoJSON, GPX and
//  KML into features (GPX and KML through @tmcw/togeojson), simplifying
//  long tracks. Export writes GeoJSON and GPX. Pure apart from the
//  DOMParser an import of XML needs, which the caller hands in.

import { gpx, kml } from '@tmcw/togeojson';
import { parse, check, simplifyFeature, props, esc, MAX_TEXT, depthOf, MAX_DEPTH } from './core.js';

//  the kind of a file, by its name: 'geojson', 'gpx', 'kml' or ''
export function fileKind(name) {
  const m = /\.([a-z]+)$/i.exec(String(name || ''));
  const e = m ? m[1].toLowerCase() : '';
  return e === 'geojson' || e === 'json' ? 'geojson' : e === 'gpx' ? 'gpx' : e === 'kml' ? 'kml' : '';
}

//  importText(kind, text, DOMParser) -> { features, before, after } | { error }
//    before, after: the positions in long lines before and after they were
//    simplified (both 0 when nothing was)
export function importText(kind, text, DP) {
  const t = String(text ?? '');
  if (t.length > MAX_TEXT) return { error: 'the file is too large' };
  let fc;
  if (kind === 'geojson') {
    if (depthOf(t) > MAX_DEPTH) return { error: 'the file is nested too deeply' };
    let j;
    try { j = JSON.parse(t); } catch { return { error: 'the file is not valid JSON' }; }
    if (j && j.type === 'Feature') fc = { type: 'FeatureCollection', features: [j] };
    else if (j && j.type === 'FeatureCollection') fc = j;
    else if (j && typeof j.type === 'string') fc = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: j, properties: {} }] };
    else return { error: 'the file is not GeoJSON' };
  } else if (kind === 'gpx' || kind === 'kml') {
    if (!DP) return { error: 'this browser cannot read XML files' };
    const xml = new DP().parseFromString(t, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) return { error: 'the file is not valid XML' };
    try { fc = (kind === 'gpx' ? gpx : kml)(xml); } catch { return { error: 'the file cannot be read' }; }
    //  togeojson writes empty geometries as null and extra styling members
    fc = { type: 'FeatureCollection', features: (fc.features || []).filter((f) => f && f.geometry) };
  } else return { error: 'lattice reads .geojson, .json, .gpx and .kml files' };
  //  check what came in the way a page is checked, before anything walks
  //  it. The positions are counted after the long lines are simplified.
  const why = check({ type: 'FeatureCollection', features: fc.features }, Infinity);
  if (why) return { error: why.replace('the page', 'the file') };
  let before = 0, after = 0;
  const feats = fc.features.map((f) => {
    const [g, b, a] = simplifyFeature(f);
    before += b; after += a;
    return g;
  });
  const r = parse(JSON.stringify({ type: 'FeatureCollection', features: feats }));
  if (r.error) return { error: r.error };
  const features = r.doc.features.map((f) => keepProps(f, kind));
  return { features, before: before !== after ? before : 0, after: before !== after ? after : 0 };
}
//  GPX and KML carry names as `name` and notes as `desc` or `description`
function keepProps(f, kind) {
  if (kind === 'geojson') return f;
  const p = f.properties && typeof f.properties === 'object' ? f.properties : {};
  const out = {};
  if (typeof p.name === 'string') out.name = p.name;
  const d = typeof p.desc === 'string' ? p.desc : typeof p.description === 'string' ? p.description : typeof p.description?.value === 'string' ? p.description.value : '';
  if (d) out.note = d;
  if (typeof p.time === 'string') out.time = p.time;
  else if (Array.isArray(p.coordinateProperties?.times) && typeof p.coordinateProperties.times[0] === 'string') out.time = p.coordinateProperties.times[0];
  if (typeof p.type === 'string' && p.type.length <= 40) out.kind = p.type;
  return { type: 'Feature', geometry: f.geometry, properties: out };
}

//  the body as a plain GeoJSON file (the page's own layout)
export const exportGeojson = (body) => String(body);

//  GPX 1.1: points as waypoints, lines and polygon outlines as tracks
export function exportGpx(doc, name = 'map') {
  const x = (s) => esc(s);
  const n7 = (v) => String(Math.round(v * 1e7) / 1e7);
  let wpt = '', trk = '';
  const meta = (p) => (p.name ? `<name>${x(p.name)}</name>` : '') + (p.note ? `<desc>${x(p.note)}</desc>` : '');
  const seg = (c) => '<trkseg>' + c.map((q) => `<trkpt lat="${n7(q[1])}" lon="${n7(q[0])}"/>`).join('') + '</trkseg>';
  const one = (g, p) => {
    if (!g) return;
    switch (g.type) {
      case 'Point': wpt += `<wpt lat="${n7(g.coordinates[1])}" lon="${n7(g.coordinates[0])}">${p.time ? `<time>${x(p.time)}</time>` : ''}${meta(p)}</wpt>`; break;
      case 'MultiPoint': for (const c of g.coordinates) one({ type: 'Point', coordinates: c }, p); break;
      case 'LineString': trk += `<trk>${meta(p)}${seg(g.coordinates)}</trk>`; break;
      case 'MultiLineString': trk += `<trk>${meta(p)}${g.coordinates.map(seg).join('')}</trk>`; break;
      case 'Polygon': trk += `<trk>${meta(p)}${seg(g.coordinates[0])}</trk>`; break;
      case 'MultiPolygon': for (const c of g.coordinates) one({ type: 'Polygon', coordinates: c }, p); break;
      case 'GeometryCollection': for (const h of g.geometries) one(h, p); break;
      default:
    }
  };
  for (const f of doc.features) one(f.geometry, props(f));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="lattice" xmlns="http://www.topografix.com/GPX/1/1">'
    + `<metadata><name>${x(name)}</name></metadata>` + wpt + trk + '</gpx>\n';
}
