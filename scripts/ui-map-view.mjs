#!/usr/bin/env node
//  ui-map-view.mjs: the map editor in a real browser, with no ship. The
//  built map.js is loaded into a page on a stub origin, which also
//  answers the tile route with a blank tile, and mounted over map bodies.
//  The suite drives it as a person would and measures the two numbers the
//  plan asks for: a 500-feature map's first paint, and an edit's round
//  trip from the pointer to the body.
//
//      read mode has no tools, a click shows a feature's detail
//      features paint before the first tile is asked for
//      tiles are 512 px, asked one zoom down, from the style chosen
//      no token: a note with a link to the setting, and no tile requests
//      a point, a line, an area and a ring each write the body
//      a dragged point is a one-line diff, a dragged vertex moves
//      the detail panel edits properties and keeps the others
//      Delete removes, Ctrl+Z asks the shell to undo, update() redraws
//      GPX (5,000 points, simplified), KML and dropped files import
//      GeoJSON and GPX export
//      hostile names and notes are text, never markup
//      layers are drawn and a missing one is said
//      the time filter, refresh, the base map switch, a phone screen
//
//  The shell around the map (lazy load, tabs, save, offline, the tile
//  route itself) needs a ship and is ui-map.mjs.
//
//  Env:    CHROME   (as the other browser suites)
//  Usage:  node scripts/ui-map-view.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const js = readFileSync(join(root, 'code', 'nex', 'lattice', 'ui-app', 'map.js'), 'utf8');
const check = makeCheck({ detailOnPass: false });
const ORIGIN = 'http://lattice.test';

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--bg:#fafafa;--text:#1a1a1a;--border:#8886}'
  + 'html,body{margin:0;height:100%;font:15px system-ui}#h{position:absolute;inset:0}</style></head><body><lat-map id="h"></lat-map></body></html>';
//  a 1x1 transparent PNG: what the tile route answers here
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const pt = (lon, lat, p = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: p });
const body = (features, lattice = {}) => '{"type":"FeatureCollection","lattice":' + JSON.stringify(lattice) + ',"features":[\n'
  + (features.length ? features.map((f) => JSON.stringify(f)).join(',\n') + '\n' : '') + ']}\n';
const TILES = { token: true, max: 17, styles: ['streets', 'outdoors', 'satellite', 'dark'], url: '/apps/lattice/tile/{s}/{z}/{x}/{y}' };

const browser = await launchBrowser();
const errors = [];
async function open(text, { editable = true, viewport = { width: 1100, height: 700 }, touch = false, tiles = TILES, layers = {} } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, hasTouch: touch, isMobile: touch });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|insecure connection/.test(m.text())) errors.push(m.text()); });
  const reqs = [];
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (u === ORIGIN + '/') return r.respond({ status: 200, contentType: 'text/html', body: PAGE });
    if (u.startsWith(ORIGIN + '/apps/lattice/tile/')) { reqs.push(u.slice(ORIGIN.length)); return r.respond({ status: 200, contentType: 'image/png', body: PNG }); }
    if (u.startsWith(ORIGIN)) return r.respond({ status: 404, body: '' });
    if (u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    reqs.push('OUTSIDE ' + u);
    return r.abort();
  });
  await page.goto(ORIGIN + '/');
  await page.addScriptTag({ content: js });
  const r = await page.evaluate((t, ed, tl, ly) => {
    window.buf = t;
    window.changes = 0;
    window.undos = 0;
    window.redos = 0;
    window.settings = 0;
    window.texts = [];
    const t0 = performance.now();
    window.ctl = window.LatMap.mount(document.getElementById('h'), {
      text: t, editable: ed, name: 'trips/map', cur: () => window.buf, tiles: tl,
      onText: (x) => { window.textAt = performance.now(); window.buf = x; window.texts.push(x); },
      onChange: () => { window.changes++; },
      undo: () => { window.undos++; }, redo: () => { window.redos++; },
      openSettings: () => { window.settings++; },
      md: (s) => s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'),
      layer: async (n) => (Object.prototype.hasOwnProperty.call(ly, n) ? ly[n] : null),
    });
    window.mountMs = performance.now() - t0;
    window.t0 = t0;
    return window.ctl.error || '';
  }, text, editable, tiles, layers);
  if (r) throw new Error(r);
  await page.waitForFunction(() => document.getElementById('h').dataset.painted !== undefined, { timeout: 5000 });
  const api = {
    page, reqs,
    //  the screen point of [lon, lat]
    at: (lon, lat) => page.evaluate((a, b) => {
      const m = window.ctl._t.map;
      const p = m.latLngToContainerPoint([b, a]);
      const q = m.getContainer().getBoundingClientRect();
      return [q.left + p.x, q.top + p.y];
    }, lon, lat),
    click: async (lon, lat, o) => { const [x, y] = await api.at(lon, lat); await page.mouse.click(x, y, o); await sleep(30); },
    tool: (label) => page.evaluate((l) => [...document.querySelectorAll('.lm-tools button')].find((b) => b.textContent === l).click(), label),
    doc: () => page.evaluate(() => JSON.parse(window.buf)),
    note: () => page.$$eval('.lm-note span', (e) => e.map((x) => x.textContent).join(' | ')),
    list: () => page.$$eval('.lm-list button', (e) => e.map((x) => x.querySelector('.lm-n').textContent)),
    sel: () => page.evaluate(() => window.ctl._t.sel()),
    close: () => page.close(),
  };
  return api;
}
const lineDiff = (a, b) => { const x = a.split('\n'), y = b.split('\n'); return x.length === y.length ? x.filter((l, i) => l !== y[i]).length : -1; };

console.log('==> read mode');
{
  const m = await open(body([pt(-71, 42, { name: 'Harbour', kind: 'place', note: 'a note', source: 'https://example.com/x' }), pt(-70.5, 42.2, { name: 'Light' })]), { editable: false });
  check('no drawing tools in read mode', await m.page.$eval('.lm-tools', (e) => e.hidden));
  check.eq('the list shows the features', (await m.list()).join(), 'Harbour,Light');
  check('the legend shows the kinds', (await m.page.$eval('.lm-legend', (e) => e.textContent)).includes('place (1)'));
  await m.click(-71, 42);
  check.eq('a click selects the feature', await m.sel(), 0);
  check('its detail shows, with no inputs', await m.page.$eval('.lm-detail', (e) => !e.hidden && e.textContent.includes('Harbour') && !e.querySelector('input,textarea')));
  check('a source URL is a safe link', await m.page.$eval('.lm-detail a', (a) => a.href === 'https://example.com/x' && a.rel === 'noopener noreferrer' && a.target === '_blank'));
  await m.page.click('.lm-list button:nth-child(2)');
  check.eq('a list row selects and flies to its feature', await m.sel(), 1);
  await sleep(400);
  const [x, y] = await m.at(-70.501, 42.201);
  await m.page.mouse.move(x, y);
  check('the readout shows lat/lon and MGRS', /^42\.20\d*, -70\.50\d*\s+19T/.test(await m.page.$eval('.lm-read', (e) => e.textContent)), await m.page.$eval('.lm-read', (e) => e.textContent));
  await m.page.keyboard.down('Control'); await m.page.keyboard.press('z'); await m.page.keyboard.up('Control');
  check.eq('Ctrl+Z does nothing in read mode', await m.page.evaluate(() => window.undos), 0);
  await m.close();
}

console.log('==> first paint and tiles');
{
  const feats = Array.from({ length: 500 }, (_, i) => (i % 5 === 4
    ? { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-71 + i / 200, 42], [-71 + i / 200, 42.1], [-70.9 + i / 200, 42.15]] }, properties: { name: 'l' + i, kind: 'route' } }
    : pt(-71 + (i % 50) / 50, 42 + Math.floor(i / 50) / 20, { name: 'p' + i, kind: ['report', 'place', 'zone'][i % 3], time: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString() })));
  const m = await open(body(feats));
  const t = await m.page.evaluate(() => ({ mount: window.mountMs, painted: Number(document.getElementById('h').dataset.painted) + window.mountMs }));
  check(`500 features paint well under 400 ms (mount ${t.mount.toFixed(0)} ms, painted ${t.painted.toFixed(0)} ms)`, t.painted < 400, JSON.stringify(t));
  const drawn = await m.page.evaluate(() => {
    const c = document.querySelector('.leaflet-overlay-pane canvas');
    const g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < g.length; i += 4) if (g[i]) n++;
    return n;
  });
  check('the features are on the canvas', drawn > 1000, String(drawn));
  await waitFor(() => m.reqs.length > 0, 3000);
  const first = await m.page.evaluate(() => {
    const e = performance.getEntriesByType('resource').filter((r) => r.name.includes('/apps/lattice/tile/'));
    return e.length ? Math.min(...e.map((r) => r.startTime)) - window.t0 : -1;
  });
  const painted = await m.page.evaluate(() => Number(document.getElementById('h').dataset.painted));
  check('no tile is asked for before the features paint', first >= painted, `first tile at ${first.toFixed(0)} ms, painted at ${painted} ms`);
  const z = await m.page.evaluate(() => window.ctl._t.map.getZoom());
  check('tiles come from the style\'s route, one zoom down', m.reqs.length > 0 && m.reqs.every((u) => new RegExp(`^/apps/lattice/tile/streets/${z - 1}/\\d+/\\d+$`).test(u)), m.reqs.slice(0, 3).join(' '));
  check('tiles are 512 px', await m.page.$$eval('.leaflet-tile-pane img.leaflet-tile', (e) => e.length > 0 && e.every((i) => i.style.width === '512px')));
  check('nothing is fetched from outside', !m.reqs.some((u) => u.startsWith('OUTSIDE')), m.reqs.filter((u) => u.startsWith('OUTSIDE')).join(' '));
  check('the time filter is shown for timed features', await m.page.$('.lm-time input[type=range]') !== null);
  const before = (await m.list()).length;
  await m.page.$eval('.lm-time input', (e) => { e.value = '7'; e.dispatchEvent(new Event('input')); });
  const after = (await m.list()).length;
  check('a one year filter keeps the year\'s features and the untimed lines', after === before, `${before} -> ${after}`);
  await m.page.$eval('.lm-time input', (e) => { e.value = '1'; e.dispatchEvent(new Event('input')); });
  check('a one hour filter leaves only the untimed lines', (await m.list()).length === 100, String((await m.list()).length));
  await m.page.$eval('.lm-time input', (e) => { e.value = '0'; e.dispatchEvent(new Event('input')); });
  await m.page.evaluate(() => [...document.querySelectorAll('.lm-legend button')].find((b) => b.textContent.startsWith('route')).click());
  check('a legend kind hides its features', (await m.list()).length === 400);
  m.reqs.length = 0;
  await m.page.click('button[title="Refresh this area"]');
  await waitFor(() => m.reqs.some((u) => /\?r=\d+$/.test(u)), 3000);
  check('Refresh this area asks again for the tiles in view, past the cache', m.reqs.some((u) => /\?r=\d+$/.test(u)) && m.reqs.filter((u) => /\?r=/.test(u)).every((u) => u.includes('/streets/' + (z - 1) + '/')), m.reqs.slice(0, 3).join(' '));
  m.reqs.length = 0;
  await m.page.select('.lm-bar select', 'satellite');
  await waitFor(() => m.reqs.some((u) => u.includes('/satellite/')), 3000);
  check('the base map switch asks for the new style', m.reqs.some((u) => u.includes('/satellite/')));
  check('and writes the page\'s base in Edit', (await m.doc()).lattice.base === 'satellite');
  await m.close();
}

console.log('==> no token, and a big page');
{
  const m = await open(body([pt(0, 0)]), { tiles: { ...TILES, token: false } });
  check('no token: a note links to the setting', (await m.note()).includes('Set a Mapbox token in Settings'));
  await m.page.click('.lm-note a');
  check.eq('the link opens Settings', await m.page.evaluate(() => window.settings), 1);
  await sleep(300);
  check.eq('no tile is asked for', m.reqs.length, 0);
  check('the grid is still drawn', await m.page.$$eval('.lm-grid canvas', (e) => e.length > 0));
  await m.close();
  const big = await open(body([pt(1, 1, { note: 'x'.repeat(2.1 * 1024 * 1024) })]));
  check('a body over 2 MB is shown without tools', await big.page.$eval('.lm-tools', (e) => e.hidden) && (await big.note()).includes('large'));
  await big.close();
  const bad = await browser.newPage();
  await bad.goto('about:blank');
  await bad.addScriptTag({ content: js });
  const e = await bad.evaluate(() => {
    const h = document.createElement('lat-map');
    document.body.append(h);
    return [window.LatMap.mount(h, { text: '{"type":"Feature"}' }).error, window.LatMap.mount(h, { text: '<x>' }).error];
  });
  check('a body that is not a map is refused, so the shell shows source', e.every((x) => /cannot open this page/.test(x)), e.join(' | '));
  await bad.close();
}

console.log('==> drawing');
{
  const m = await open(body([pt(-71, 42, { name: 'A' })], { center: [-71, 42], zoom: 10 }));
  check('Edit mode has the tools', await m.page.$eval('.lm-tools', (e) => !e.hidden));
  await m.tool('Point');
  await m.click(-70.9, 42.05);
  let d = await m.doc();
  check('the point tool adds a point', d.features.length === 2 && d.features[1].geometry.type === 'Point' && Math.abs(d.features[1].geometry.coordinates[0] + 70.9) < 2e-3, JSON.stringify(d.features[1]));
  check('the shell heard about it', await m.page.evaluate(() => window.changes) >= 1);
  check('the body is in lattice\'s layout', await m.page.evaluate(() => window.buf.split('\n').length) === 5);
  await m.page.keyboard.press('Escape');
  await m.tool('Line');
  await m.click(-71.1, 41.95); await m.click(-71.05, 41.97); await m.click(-71.0, 41.95);
  await m.page.keyboard.press('Enter');
  d = await m.doc();
  check('the line tool adds a line on Enter', d.features.length === 3 && d.features[2].geometry.type === 'LineString' && d.features[2].geometry.coordinates.length === 3, JSON.stringify(d.features[2] && d.features[2].geometry));
  await m.tool('Area');
  await m.click(-71.2, 42.1); await m.click(-71.1, 42.1);
  await m.click(-71.15, 42.15, { clickCount: 1 });
  const [ax, ay] = await m.at(-71.15, 42.15);
  await m.page.mouse.click(ax, ay, { count: 2 });
  await sleep(50);
  d = await m.doc();
  const poly = d.features[3];
  check('the area tool closes a polygon on a double click', poly && poly.geometry.type === 'Polygon' && poly.geometry.coordinates[0].length === 4
    && JSON.stringify(poly.geometry.coordinates[0][0]) === JSON.stringify(poly.geometry.coordinates[0][3]), JSON.stringify(d.features.map((f) => f.geometry.type)) + ' zoom ' + await m.page.evaluate(() => window.ctl._t.map.getZoom()));
  await m.tool('Ring');
  await m.click(-70.8, 41.9); await m.click(-70.8, 41.91);
  d = await m.doc();
  const ring = d.features[4];
  check('the ring tool adds a point with a radius', ring && ring.geometry.type === 'Point' && Math.abs(ring.properties.radius - 1112) < 250, JSON.stringify(ring));
  await m.tool('Line');
  await m.click(-71.3, 42); await m.page.keyboard.press('Escape');
  check.eq('Escape drops a half-drawn line', (await m.doc()).features.length, 5);
  await m.page.keyboard.press('Escape');

  //  drag a point: one line changes, and the round trip is timed
  await m.click(-71, 42);
  check.eq('a click on a point selects it', await m.sel(), 0);
  const was = await m.page.evaluate(() => window.buf);
  const [px, py] = await m.at(-71, 42);
  await m.page.evaluate(() => { window.upAt = 0; addEventListener('pointerup', () => { window.upAt = performance.now(); }, { capture: true, once: true }); });
  await m.page.mouse.move(px, py);
  await m.page.mouse.down();
  for (let i = 1; i <= 5; i++) { await m.page.mouse.move(px + i * 8, py + i * 4); await sleep(16); }
  await m.page.mouse.up();
  await sleep(30);
  const now = await m.page.evaluate(() => window.buf);
  check.eq('a dragged point is a one-line diff', lineDiff(was, now), 1);
  const rt = await m.page.evaluate(() => window.textAt - window.upAt);
  check(`an edit reaches the body within the Doherty threshold (${rt.toFixed(1)} ms from pointer up)`, rt >= 0 && rt < 400, String(rt));
  check('the map did not pan while dragging', Math.abs((await m.page.evaluate(() => window.ctl._t.map.getCenter().lng)) + 71) < 0.01);
  const moved = (await m.doc()).features[0].geometry.coordinates;
  check('the point moved', moved[0] > -71 && moved[1] < 42, JSON.stringify(moved));

  //  a vertex of the line
  await m.click(-71.05, 41.97);
  check.eq('a click on a line selects it', await m.sel(), 2);
  check('the selected line shows its vertices', await m.page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane canvas').length >= 1));
  const [vx, vy] = await m.at(-71.05, 41.97);
  await m.page.mouse.move(vx, vy); await m.page.mouse.down();
  await m.page.mouse.move(vx, vy - 30, { steps: 4 }); await m.page.mouse.up();
  await sleep(30);
  const line = (await m.doc()).features[2].geometry.coordinates;
  check('a dragged vertex moves only that vertex', line[1][1] > 41.975 && Math.abs(line[0][1] - 41.95) < 0.003 && Math.abs(line[2][1] - 41.95) < 0.003 && Math.abs(line[1][0] + 71.05) < 0.003, JSON.stringify(line));

  //  the detail panel
  await m.click(-70.9, 42.05);
  check.eq('the new point selects', await m.sel(), 1);
  const setField = (k, v) => m.page.$eval(`.lm-detail [data-k="${k}"]`, (e, val) => { e.value = val; e.dispatchEvent(new Event('change')); }, v);
  await setField('name', 'Camp');
  await setField('kind', 'place');
  await setField('note', 'meet *here*');
  await setField('icon', 'tent');
  await setField('color', '#ff8800');
  await setField('radius', '300');
  await setField('source', 'https://example.org/c');
  let p = (await m.doc()).features[1].properties;
  check('the detail panel writes each property', p.name === 'Camp' && p.kind === 'place' && p.note === 'meet *here*' && p.icon === 'tent' && p.color === '#ff8800' && p.radius === 300 && p.source === 'https://example.org/c', JSON.stringify(p));
  await setField('time', 'not a date');
  check('a bad time is refused with a note', !(await m.doc()).features[1].properties.time && (await m.note()).includes('not a date'));
  await setField('radius', '');
  check('an empty radius removes it', !('radius' in (await m.doc()).features[1].properties));
  check.eq('the list shows the new name', (await m.list())[1], 'Camp');

  //  undo goes to the shell, and update() redraws in place
  await m.page.focus('.lm-map');
  await m.page.keyboard.down('Control'); await m.page.keyboard.press('z'); await m.page.keyboard.up('Control');
  check.eq('Ctrl+Z asks the shell to undo', await m.page.evaluate(() => window.undos), 1);
  await m.page.keyboard.down('Control'); await m.page.keyboard.down('Shift'); await m.page.keyboard.press('Z'); await m.page.keyboard.up('Shift'); await m.page.keyboard.up('Control');
  check.eq('Ctrl+Shift+Z asks it to redo', await m.page.evaluate(() => window.redos), 1);
  const view0 = await m.page.evaluate(() => [window.ctl._t.map.getCenter(), window.ctl._t.map.getZoom()]);
  const ok = await m.page.evaluate(() => window.ctl.update(window.texts[0]));
  check('update() takes an outside text and redraws it', ok && (await m.list()).length === 2);
  check('it keeps the view', JSON.stringify(view0) === JSON.stringify(await m.page.evaluate(() => [window.ctl._t.map.getCenter(), window.ctl._t.map.getZoom()])));
  check('update() refuses a broken text', await m.page.evaluate(() => window.ctl.update('{') === false));
  check.eq('base() is the text it was handed', await m.page.evaluate(() => window.ctl.base() === window.texts[0]), true);
  await m.page.evaluate(() => { window.buf = window.ctl.base(); });

  //  delete
  await m.click(-71, 42);
  await m.page.focus('.lm-map');
  await m.page.keyboard.press('Delete');
  check.eq('Delete removes the selected feature', (await m.doc()).features.length, 1);
  await m.page.evaluate(() => window.ctl.setEditable(false));
  check('setEditable(false) hides the tools', await m.page.$eval('.lm-tools', (e) => e.hidden));
  await m.close();
}

console.log('==> files');
{
  const m = await open(body([]));
  let gpx = '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="42.5" lon="-71.5"><name>Start &amp; end</name><desc>a desc</desc></wpt><trk><name>Long walk</name><trkseg>';
  for (let i = 0; i < 5000; i++) gpx += `<trkpt lat="${(42 + Math.sin(i / 200) * 0.05 + (i % 7) * 1e-5).toFixed(6)}" lon="${(-71.5 + i * 0.0001).toFixed(6)}"><time>2026-06-01T10:${String(Math.floor(i / 100) % 60).padStart(2, '0')}:00Z</time></trkpt>`;
  gpx += '</trkseg></trk></gpx>';
  const r = await m.page.evaluate((t) => window.ctl.importFiles([new File([t], 'walk.gpx')]), gpx);
  let d = await m.doc();
  const trk = d.features.find((f) => f.geometry.type === 'LineString');
  check('a 5,000 point GPX track imports, simplified', r && trk && trk.geometry.coordinates.length <= 500 && trk.properties.name === 'Long walk', trk ? String(trk.geometry.coordinates.length) : 'none');
  check('the note gives the point counts', /simplified from 5000 to \d+ points/.test(await m.note()), await m.note());
  check('a waypoint imports with its name and note', d.features.some((f) => f.geometry.type === 'Point' && f.properties.name === 'Start & end' && f.properties.note === 'a desc'));
  const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Hill</name><description>&lt;b&gt;steep&lt;/b&gt;</description><Point><coordinates>-71.2,42.3,0</coordinates></Point></Placemark></Document></kml>';
  await m.page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'hill.kml'));
    document.getElementById('h').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, kml);
  await waitFor(async () => (await m.doc()).features.length === 3, 2000);
  d = await m.doc();
  check('a dropped KML file imports', d.features.some((f) => f.properties.name === 'Hill' && f.geometry.coordinates[0] === -71.2));
  await m.page.evaluate(() => window.ctl.importFiles([new File(['x'], 'notes.txt')]));
  check('a file of another kind is refused with a note', (await m.note()).includes('lattice reads'));
  await m.page.evaluate(() => {
    window.blobs = [];
    const o = URL.createObjectURL;
    URL.createObjectURL = (b) => { window.blobs.push(b); return o.call(URL, b); };
  });
  await m.page.click('button[title="Download as GeoJSON"]');
  await m.page.click('button[title="Download as GPX"]');
  const out = await m.page.evaluate(async () => Promise.all(window.blobs.map((b) => b.text())));
  check('GeoJSON export is the page body', out[0] === await m.page.evaluate(() => window.buf));
  check('GPX export is GPX with the waypoints and the track', out[1] && out[1].startsWith('<?xml') && (out[1].match(/<wpt /g) || []).length === 2 && out[1].includes('<trk><name>Long walk</name>'));
  await m.page.evaluate(() => window.ctl.setEditable(false));
  check('a read-only map imports nothing', !(await m.page.evaluate((t) => window.ctl.importFiles([new File([t], 'h.kml')]), kml)));
  await m.close();
}

console.log('==> hostile text');
{
  const evil = pt(10, 10, { name: '<img src=x onerror="window.pwned=1">', note: '<script>window.pwned=2</script><img src=y onerror="window.pwned=3">', kind: '<b>k</b>', source: 'javascript:window.pwned=4', icon: 'https://evil.example/i.png', color: 'red;background:url(https://evil.example/)' });
  const m = await open(body([evil], { title: '<svg onload="window.pwned=5">' }), { editable: false });
  await m.click(10, 10);
  await sleep(100);
  check('no markup from the page is live', await m.page.evaluate(() => !document.querySelector('#h img:not(.leaflet-tile), #h script, #h [onerror], #h [onload]') && ![...document.querySelectorAll('#h b')].some((b) => b.textContent === 'k') && window.pwned === undefined));
  check('a name is shown as its text', (await m.list())[0] === '<img src=x onerror="window.pwned=1">');
  check('a javascript: source is not a link', await m.page.$$eval('.lm-detail a', (a) => a.length === 0));
  check('nothing was fetched from outside', !m.reqs.some((u) => u.startsWith('OUTSIDE')), m.reqs.join(' '));
  const shown = await m.page.evaluate((t) => window.LatMap.show(t), body([evil]));
  check('show() escapes everything', !shown.includes('<img') && !shown.includes('<script') && shown.includes('&lt;img'));
  await m.close();
}

console.log('==> layers');
{
  const other = body([pt(-71, 42, { name: 'under' }), pt(-71.1, 42.1)], { layers: ['self'] });
  const m = await open(body([pt(-71, 42.05, { name: 'top' })], { layers: ['maps/other', 'maps/missing'] }), { layers: { 'maps/other': other } });
  await waitFor(async () => (await m.page.$eval('.lm-legend', (e) => e.textContent)).includes('could not'), 2000);
  const leg = await m.page.$eval('.lm-legend', (e) => e.textContent);
  check('a layer is drawn and listed in the legend', leg.includes('Layer: maps/other (2)'), leg);
  check('a missing layer is said', leg.includes('Layer maps/missing could not be read.'), leg);
  check('the layer is drawn on its own pane underneath', await m.page.$eval('.leaflet-lm-under-pane canvas', (c) => !!c).catch(() => false));
  check.eq('a layer\'s features are never the page\'s', (await m.list()).join(), 'top');
  await m.close();
}

console.log('==> phone');
{
  const m = await open(body([pt(0, 0, { name: 'p' })]), { viewport: { width: 390, height: 760 }, touch: true });
  check('a narrow screen hides the side panel behind a button', await m.page.evaluate(() => document.getElementById('h').classList.contains('lm-narrow') && getComputedStyle(document.querySelector('.lm-side')).display === 'none'));
  await m.page.click('.lm-sidebtn');
  check('the List button shows it', await m.page.evaluate(() => getComputedStyle(document.querySelector('.lm-side')).display !== 'none'));
  await m.page.click('.lm-sidebtn');
  await m.tool('Point');
  const [x, y] = await m.at(0.001, 0.001);
  await m.page.touchscreen.tap(x, y);
  await sleep(100);
  check('a tap with the point tool adds a point', (await m.doc()).features.length === 2);
  await m.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
check.done();
