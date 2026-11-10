#!/usr/bin/env node
//  map-unit.mjs: the map page core, in pure node. No ship, no browser.
//
//    1. Layout.   The blank page, lattice's one-feature-per-line writer,
//                 a foreign layout rewritten, members and properties kept,
//                 a moved point as a one-line diff, rounding.
//    2. Refusals. Everything that is not a FeatureCollection lattice can
//                 draw, and the caps, refused fast and before allocation.
//    3. Reads.    The properties lattice shows, checked: colour, icon,
//                 radius, time, source links, the view member, the title,
//                 search text and the outline.
//    4. Hostile.  __proto__ keys, markup in names, deep nesting.
//    5. Tracks.   Douglas-Peucker and the simplify-on-import target.
//    6. Render.   The tile-free SVG and table, escaped and capped.
//    7. Files.    GeoJSON import and GPX export (GPX and KML import need a
//                 DOMParser and run in ui-map-view.mjs).
//
//  Usage: node scripts/map-unit.mjs
import { build } from 'esbuild';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';
import {
  parse, serialize, props, view, title, text, outline, render, renderBody, dp, simplify,
  sourceLink, depthOf, BLANK, BIG, MAX_FEATURES, MAX_POSITIONS, RENDER_MAX,
} from '../ui-src/map/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const check = makeCheck();

//  io.js imports @tmcw/togeojson from scripts/node_modules, which node
//  cannot find from ui-src/, so it is bundled here first
const io = await (async () => {
  const r = await build({
    entryPoints: [join(here, '..', 'ui-src', 'map', 'io.js')], bundle: true, format: 'esm', write: false,
    nodePaths: [join(here, 'node_modules')], logLevel: 'error', platform: 'neutral',
  });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
})();

const pt = (lon, lat, p = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: p });
const fc = (features, extra = {}) => JSON.stringify({ type: 'FeatureCollection', ...extra, features });
const refuses = (name, t, why) => {
  const r = parse(t);
  check(name, !!r.error && (!why || why.test(r.error)), r.error || 'parsed');
};
const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

console.log('1. layout');
{
  const r = parse(BLANK);
  check('the blank page parses', !r.error && r.doc.features.length === 0, r.error);
  check.eq('the blank page writes itself', serialize(r.doc), BLANK);
  const doc = { lattice: { title: 'T', center: [1, 2], zoom: 5 }, features: [pt(10, 20, { name: 'a' }), pt(11, 21)], extra: [] };
  const t = serialize(doc);
  check.eq('lattice member first, one feature per line', t,
    '{"type":"FeatureCollection","lattice":{"title":"T","center":[1,2],"zoom":5},"features":[\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[10,20]},"properties":{"name":"a"}},\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[11,21]},"properties":{}}\n]}\n');
  check.eq('lattice\'s own layout round-trips byte for byte', serialize(parse(t).doc), t);
  const foreign = JSON.stringify({ features: [{ properties: { z: 1, a: 2 }, id: 'x1', geometry: { coordinates: [1.123456789123, 2.5], type: 'Point' }, type: 'Feature', bbox: [1, 2, 1, 2] }], type: 'FeatureCollection', crs: { type: 'name' }, name: 'qgis' }, null, 2);
  const f = parse(foreign);
  check('a pretty-printed foreign body parses', !f.error, f.error);
  const w = serialize(f.doc);
  check('it is rewritten in lattice\'s layout', w.startsWith('{"type":"FeatureCollection","lattice":{},"crs":{"type":"name"},"name":"qgis","features":[\n'), w.slice(0, 120));
  check('feature keys: type, geometry, properties, id, then the rest', w.includes('{"type":"Feature","geometry":{"coordinates":[1.1234568,2.5],"type":"Point"},"properties":{"z":1,"a":2},"id":"x1","bbox":[1,2,1,2]}'), w);
  check('coordinates are rounded to 7 places', !w.includes('1.123456789'));
  const many = { lattice: {}, features: Array.from({ length: 50 }, (_, i) => pt(i, i, { name: 'p' + i })), extra: [] };
  const a = serialize(many);
  many.features[20] = { ...many.features[20], geometry: { type: 'Point', coordinates: [20.5, 20.25] } };
  const b = serialize(many);
  const al = a.split('\n'), bl = b.split('\n');
  check('a moved point is a one-line diff', al.length === bl.length && al.filter((l, i) => l !== bl[i]).length === 1);
  check('unknown properties survive an edit', serialize(parse(fc([pt(1, 2, { name: 'n', mine: { deep: [1, 2] } })])).doc).includes('"mine":{"deep":[1,2]}'));
}

console.log('2. refusals');
{
  refuses('not JSON', '{"type":', /not valid JSON/);
  refuses('empty', '  ', /empty/);
  refuses('a bare Feature', JSON.stringify(pt(1, 2)), /FeatureCollection/);
  refuses('a bare geometry', JSON.stringify({ type: 'Point', coordinates: [1, 2] }), /FeatureCollection/);
  refuses('an array', '[]', /FeatureCollection/);
  refuses('no features list', '{"type":"FeatureCollection"}', /features/);
  refuses('a feature that is not a Feature', fc([{ type: 'Point', coordinates: [1, 2] }]), /not a Feature/);
  refuses('a feature with no geometry member', fc([{ type: 'Feature', properties: {} }]), /no geometry/);
  refuses('an unknown geometry type', fc([{ type: 'Feature', geometry: { type: 'Circle', coordinates: [1, 2] } }]), /unknown geometry/);
  refuses('a string coordinate', fc([{ type: 'Feature', geometry: { type: 'Point', coordinates: ['1', 2] } }]), /number/);
  refuses('a longitude off the world', fc([pt(181, 0)]), /outside/);
  refuses('a latitude off the world', fc([pt(0, -91)]), /outside/);
  refuses('a one-position line', fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 2]] } }]), /too few/);
  refuses('a three-position ring', fc([{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] } }]), /too few/);
  refuses('a collection in a collection', fc([{ type: 'Feature', geometry: { type: 'GeometryCollection', geometries: [{ type: 'GeometryCollection', geometries: [] }] } }]), /inside another/);
  refuses('properties that are a list', fc([{ type: 'Feature', geometry: null, properties: [1] }]), /properties/);
  refuses('a lattice member that is a list', fc([], { lattice: [] }), /lattice member/);
  check('a null geometry is allowed', !parse(fc([{ type: 'Feature', geometry: null, properties: null }])).error);
  const tooMany = '{"type":"FeatureCollection","features":[' + Array(MAX_FEATURES + 1).fill('{"type":"Feature","geometry":null}').join(',') + ']}';
  refuses('more features than the cap', tooMany, /more than/);
  const longLine = fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: Array.from({ length: MAX_POSITIONS + 1 }, (_, i) => [i % 180, 0]) } }]);
  refuses('more positions than the cap', longLine, /positions/);
  const spread = fc(Array.from({ length: 30 }, () => ({ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: Array.from({ length: 7000 }, () => [1, 1]) } })));
  refuses('positions counted across features', spread, /positions/);
  const deep = '{"type":"FeatureCollection","features":[' + '['.repeat(1000000) + ']'.repeat(1000000) + ']}';
  let r;
  const ms = time(() => { r = parse(deep); });
  check('a million nested brackets is refused, fast', !!r.error && /nested/.test(r.error) && ms < 500, `${ms.toFixed(0)} ms, ${r.error}`);
  check('brackets inside strings do not count as depth', depthOf('{"a":"[[[[[[[[[[[[[[[[[[[[[[["}') === 1);
  const big = fc([pt(1, 2, { note: 'x'.repeat(BIG) })]);
  const bp = parse(big);
  check('a body over 2 MB opens, read-only', !bp.error && bp.doc.big === true);
  check('a small body is not big', parse(BLANK).doc.big === false);
}

console.log('3. reads');
{
  const p = props(pt(1, 2, { name: 'N', note: 'n', time: '2026-11-10T12:00:00Z', kind: ' report ', color: '#A0b', icon: 'star', radius: 250, source: 'https://e.x/a' }));
  check('the read properties', p.name === 'N' && p.note === 'n' && p.ms === Date.parse('2026-11-10T12:00:00Z') && p.kind === 'report' && p.color === '#A0b' && p.icon === 'star' && p.radius === 250, JSON.stringify(p));
  const bad = props(pt(1, 2, { name: 5, color: 'red; background:url(x)', icon: 'https://evil/x.png', radius: -3, time: 'yesterday', kind: 'k'.repeat(100) }));
  check('a bad colour, icon, radius and time are dropped', bad.name === '' && bad.color === '' && bad.icon === '' && bad.radius === 0 && bad.ms === null && bad.time === '' && bad.kind.length === 40, JSON.stringify(bad));
  check('props of a feature with null properties', props({ type: 'Feature', geometry: null, properties: null }).name === '');
  check('an infinite radius is dropped', props(pt(0, 0, { radius: 1e30 })).radius === 0);
  check('an http source is a link', sourceLink('https://example.com/a?b=1').url === 'https://example.com/a?b=1');
  check('a javascript: source is no link', sourceLink('javascript:alert(1)') === null);
  check('a data: source is no link', sourceLink('data:text/html,x') === null);
  check('a page name is a page link', sourceLink('[[notes/trip]]').page === 'notes/trip');
  check('a page name that climbs is no link', sourceLink('notes/../../x') === null);
  check('an empty source is none', sourceLink('') === null);
  const v = view({ title: 'T', center: [200, 0], zoom: 99, base: 'evil', layers: ['a', 5, '', 'b'] });
  check('the view member, checked', v.title === 'T' && v.center === null && v.zoom === null && v.base === 'streets' && v.layers.join() === 'a,b', JSON.stringify(v));
  check('a good view member', JSON.stringify(view({ center: [-70.5, 41.2], zoom: 9, base: 'satellite' })) === '{"title":"","center":[-70.5,41.2],"zoom":9,"base":"satellite","layers":[]}');
  check('layers are capped at 20', view({ layers: Array.from({ length: 50 }, (_, i) => 'l' + i) }).layers.length === 20);
  check.eq('title: the lattice title first', title(parse(fc([pt(0, 0, { name: 'first' })], { lattice: { title: 'Map' } })).doc), 'Map');
  check.eq('title: else the first named feature', title(parse(fc([pt(0, 0), pt(0, 0, { name: 'second' })])).doc), 'second');
  check.eq('title: else nothing', title(parse(BLANK).doc), '');
  const body = fc([pt(0, 0, { name: 'Alpha', note: 'a *note*', kind: 'report' }), pt(1, 1, { name: 'Beta' })], { lattice: { title: 'Trip' } });
  check.eq('search text: title, names, kinds and notes', text(body), 'Trip\nAlpha\nreport\na *note*\nBeta');
  check.eq('search text of a broken body is empty', text('{'), '');
  check.eq('the outline lists named features', JSON.stringify(outline(body)), '[{"level":1,"text":"Alpha"},{"level":1,"text":"Beta"}]');
}

console.log('4. hostile');
{
  const evil = '{"type":"FeatureCollection","features":[{"type":"Feature","__proto__":{"polluted":1},"geometry":{"type":"Point","coordinates":[1,2],"__proto__":{"p":2}},"properties":{"__proto__":{"isAdmin":true},"name":"x"}}]}';
  const r = parse(evil);
  check('__proto__ keys parse', !r.error, r.error);
  const out = serialize(r.doc);
  check('__proto__ keys are kept as data', out.includes('"__proto__":{"isAdmin":true}') && out.includes('"__proto__":{"polluted":1}') && out.includes('"__proto__":{"p":2}'), out);
  check('nothing reached Object.prototype', ({}).isAdmin === undefined && ({}).polluted === undefined && ({}).p === undefined);
  check('props ignores an inherited name', props({ properties: JSON.parse('{"__proto__":{"name":"evil"}}') }).name === '');
  const hostile = fc([pt(1, 2, { name: '<script>alert(1)</script>', kind: '"><img src=x onerror=alert(1)>', time: '2026-01-01T00:00:00Z' })], { lattice: { title: '</title><script>x</script>' } });
  const html = render(hostile);
  check('render escapes names, kinds and the title', !/<script|<img|onerror=/i.test(html.replace(/&lt;|&gt;|&quot;/g, '')) || (!html.includes('<script') && !html.includes('<img')), html.slice(0, 300));
  check('render has no live markup from the page', !html.includes('<script') && !html.includes('<img') && html.includes('&lt;script&gt;'));
  check('render takes nothing from outside', !/<[^>]*\s(src|href)\s*=/i.test(html));
}

console.log('5. tracks');
{
  //  a wandering 5,000 point track with a little noise
  let x = -71, y = 42;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const track = Array.from({ length: 5000 }, (_, i) => { x += 0.0002 + rnd() * 0.00005; y += Math.sin(i / 300) * 0.0002 + rnd() * 0.00005; return [x, y]; });
  let s;
  const ms = time(() => { s = simplify(track); });
  check('a 5,000 point track drops to a few hundred', s.length <= 500 && s.length >= 50, `${s.length} points in ${ms.toFixed(0)} ms`);
  check('its ends are kept', s[0] === track[0] && s[s.length - 1] === track[track.length - 1]);
  check('a short line is left alone', simplify(track.slice(0, 100)).length === 100);
  check('dp drops a straight line to its ends', dp([[0, 0], [1, 1], [2, 2], [3, 3]], 0.001).length === 2);
  check('dp keeps a corner', dp([[0, 0], [1, 0], [1, 1]], 0.001).length === 3);
  const huge = Array.from({ length: 100000 }, (_, i) => [i / 1000, Math.sin(i / 50)]);
  const hm = time(() => simplify(huge));
  check('100,000 points simplify without blowing the stack', hm < 3000, `${hm.toFixed(0)} ms`);
}

console.log('6. render');
{
  const body = fc([
    pt(-71, 42, { name: 'A', color: '#ff0000' }),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-71, 42], [-70, 43]] }, properties: { name: 'L' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-71, 42], [-70, 42], [-70, 43], [-71, 42]]] }, properties: {} },
  ]);
  const h = render(body);
  check('render gives a document with an SVG and a table', h.startsWith('<!doctype html>') && h.includes('<svg') && h.includes('<polyline') && h.includes('<path') && h.includes('<circle') && (h.match(/<tr>/g) || []).length === 4);
  check('a feature colour is used', h.includes('fill="#ff0000"'));
  check('render of a broken body is null', render('nope') === null);
  check('an empty map renders a note', render(BLANK).includes('No features yet'));
  const many = fc(Array.from({ length: RENDER_MAX + 5 }, (_, i) => pt((i % 360) - 180, 0, { name: 'n' + i })));
  const hm = renderBody(parse(many).doc);
  check('render is capped at 2,000 features', (hm.match(/<tr>/g) || []).length === RENDER_MAX + 1 && hm.includes('5 more features not shown'));
  const p500 = fc(Array.from({ length: 500 }, (_, i) => pt(-71 + i / 100, 42 + (i % 10) / 50, { name: 'p' + i, kind: 'k' + (i % 4) })));
  const t500 = time(() => { for (let i = 0; i < 10; i++) render(p500); }) / 10;
  check('500 features parse and render in well under 100 ms', t500 < 100, `${t500.toFixed(1)} ms`);
}

console.log('7. files');
{
  const one = io.importText('geojson', JSON.stringify(pt(1, 2, { name: 'one' })));
  check('a bare Feature file imports', one.features && one.features.length === 1 && one.features[0].properties.name === 'one');
  const g = io.importText('geojson', JSON.stringify({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }));
  check('a bare geometry file imports', g.features && g.features.length === 1);
  check('a file that is not GeoJSON is refused', !!io.importText('geojson', '{"a":1}').error);
  check('a broken file is refused', !!io.importText('geojson', '{').error);
  check('an out-of-world file is refused', !!io.importText('geojson', JSON.stringify(pt(500, 0))).error);
  check('GPX without a DOMParser is refused, not thrown', !!io.importText('gpx', '<gpx/>', null).error);
  check('an unknown extension is refused', !!io.importText('', 'x').error);
  const long = io.importText('geojson', fc([{ type: 'Feature', geometry: { type: 'LineString', coordinates: Array.from({ length: 3000 }, (_, i) => [i / 1000, Math.sin(i / 40) / 10]) }, properties: {} }]));
  check('a long line is simplified on import, with its counts', long.before === 3000 && long.after <= 500 && long.features[0].geometry.coordinates.length === long.after, `${long.before} -> ${long.after}`);
  check.eq('file kinds', ['a.GeoJSON', 'b.json', 'c.gpx', 'd.KML', 'e.txt', 'f'].map(io.fileKind).join(), 'geojson,geojson,gpx,kml,,');
  const doc = parse(fc([
    pt(1.5, 2.25, { name: 'a <b> & "c"', note: 'n', time: '2026-01-01T00:00:00Z' }),
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { name: 'trk' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} },
  ])).doc;
  const x = io.exportGpx(doc, 'my <map>');
  check('GPX export has a waypoint, tracks and escaped text', x.includes('<wpt lat="2.25" lon="1.5"><time>2026-01-01T00:00:00Z</time><name>a &lt;b&gt; &amp; &quot;c&quot;</name><desc>n</desc></wpt>')
    && (x.match(/<trk>/g) || []).length === 2 && x.includes('<name>my &lt;map&gt;</name>'), x);
}

check.done();
