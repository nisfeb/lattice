#!/usr/bin/env node
//  ui-map.mjs: map pages (geojson) in the editor shell, in a browser
//  against a fake ship. The map on its own is ui-map-view.mjs, which
//  needs no ship. This is everything around it.
//
//    A  lazy loading: a cold boot and a markdown or spreadsheet open
//       never ask for map.js, the first map open asks once (as ?h=,
//       answered immutable), a second one not at all
//    B  a map of 500 features paints its features before any tile, and
//       the time from the open to the paint is printed
//    C  an edit is one changed line in the textarea, through its own undo
//       stack: a drawn point reaches the ship, and undo in the map takes
//       it out again and saves that too. The edit's round trip is printed
//    D  tiles: none without a token. With one (a stub tile server behind
//       a test build, see TESTING.md), the map's tiles come through the
//       ship and the worker keeps them in lattice-tiles. Seeing the same
//       area again fetches no tile at all. The ship strips the server's
//       headers and answers private for 30 days
//    E  Source shows the JSON, and the kind picker refuses a switch
//    F  the new-page dialog makes an empty map
//    H  a map opened once opens offline, with the tiles it had
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           [STUB_LOG=path] node scripts/ui-map.mjs
//  STUB_LOG: the stub tile server's request log. Without it D checks
//  only the no-token case, as a ship with no stub gets no tile back.
//  ONLY=A,C runs just those sections after the setup.
//  Never run against production. Everything it writes is under one folder
//  and deleted at the end.
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const RUN = 'uimap-' + process.pid;
const here = dirname(fileURLToPath(import.meta.url));
const check = makeCheck();
const on = (id) => !process.env.ONLY || process.env.ONLY.split(',').includes(id);
const STUB = process.env.STUB_LOG || '';
const stubHits = () => (STUB && existsSync(STUB) ? readFileSync(STUB, 'utf8').split('\n').filter(Boolean).length : 0);

const P = { md: RUN + '/notes', small: RUN + '/small', big: RUN + '/big', calc: RUN + '/calc', made: RUN + '/made', off: RUN + '/off' };
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, Origin: env.base, ...(init.headers || {}) } });
const put = (name, body, type = 'geojson') => api('page-save?type=' + type + '&new=1&name=' + encodeURIComponent(name),
  { method: 'POST', body });
const shipBody = async (name) => {
  const r = await api('page-source?name=' + encodeURIComponent(name));
  return r.ok ? r.json() : null;
};
const feat = (i, lon, lat) => JSON.stringify({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: 'site ' + i, kind: i % 3 ? 'place' : 'report' } });
const coll = (fs, view = {}) => '{"type":"FeatureCollection","lattice":' + JSON.stringify(view) + ',"features":[\n' + fs.join(',\n') + '\n]}\n';
const small = coll([feat(1, 7.65, 45.97), feat(2, 7.70, 46.0), feat(3, 7.6, 45.9)], { title: 'Small', center: [7.65, 45.97], zoom: 9 });
const big = coll(Array.from({ length: 500 }, (_, i) => feat(i, -10 + (i % 25) * 0.8, 40 + Math.floor(i / 25) * 0.5)), { title: 'Big' });
const fods = readFileSync(join(here, '..', 'tests', 'sheet', 'corpus', '01-values.fods'), 'utf8');

const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1300, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 120), false),
});
const mapLoads = () => page.evaluate(() => performance.getEntriesByType('resource')
  .filter((e) => e.initiatorType === 'script' && /\/app\/map\.js/.test(e.name)).map((e) => e.name));
//  leaving a page with an edit in flight asks first: say yes
page.on('dialog', (d) => d.accept().catch(() => {}));
let tileReqs = [];
page.on('request', (r) => { if (r.url().includes('/apps/lattice/tile/')) tileReqs.push(r.url()); });
const wait = (fn, ...a) => page.waitForFunction(fn, { timeout: 60000 }, ...a);
const srcVal = () => page.evaluate(() => document.getElementById('src').value);
const mounted = () => wait(() => { const h = document.querySelector('lat-map:not([hidden])'); return !!h && !!h.dataset.painted; });
async function open(name) {
  await page.evaluate((n) => window.latTabs.openIn('page', n), name);
  await wait((n) => document.getElementById('pname').value === n, name);
}
const tileCache = () => page.evaluate(async () => (await (await caches.open('lattice-tiles')).keys()).length);

let step = 'setup';
try {
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(async () => {
    localStorage.clear();
    indexedDB.deleteDatabase('lattice-offline');
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
  });
  await api('map-token', { method: 'POST', body: '' });
  const seeds = [[P.md, '# notes\n\nplain markdown', 'md'], [P.small, small], [P.big, big], [P.calc, fods, 'fods'], [P.off, small]];
  for (const [n, b, t] of seeds) {
    const r = await put(n, b, t);
    if (!r.ok) throw new Error('seed ' + n + ': ' + r.status + ' ' + (await r.text()).slice(0, 120));
  }
  await waitFor(async () => {
    const j = await (await api('page-dump', { cache: 'no-store' })).json();
    return seeds.every(([n]) => (j.nodes || []).some((x) => x.path === n));
  }, 30000, 1000);
  if (!on('A')) {
    await page.goto(APP + '?name=' + encodeURIComponent(P.md), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await wait(() => !!window.latTabs && document.getElementById('src').value.includes('plain markdown'));
  }

  // ------------------------------------------------------------ A: lazy loading
  if (on('A')) {
    step = 'A lazy loading';
    await page.goto(APP + '?name=' + encodeURIComponent(P.md), { waitUntil: 'networkidle2', timeout: 60000 });
    await wait((n) => document.getElementById('pname').value === n && document.getElementById('src').value.includes('plain markdown'), P.md);
    await sleep(1500);
    check('A: a cold boot on a markdown page never loads map.js', (await mapLoads()).length === 0);
    await open(P.calc);
    await wait(() => !!document.querySelector('lat-sheet:not([hidden]) .ls-c'));
    check('A: a spreadsheet never loads map.js', (await mapLoads()).length === 0);
    await open(P.small);
    await mounted();
    const first = await mapLoads();
    check('A: the first map open loads map.js once', first.length === 1, first.join(' '));
    check('A: as ?h=, the hash app.js was built with', first.length === 1 && /map\.js\?h=0v/.test(first[0]), first[0]);
    if (first[0]) {
      const cc = await page.evaluate(async (u) => (await fetch(u)).headers.get('cache-control'), first[0]);
      check('A: and the ship answers it immutable', /immutable/.test(cc || ''), cc);
    }
    check('A: the textarea is hidden under the map', await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility === 'hidden'));
    await open(P.big);
    await mounted();
    check('A: a second map open loads nothing more', (await mapLoads()).length === 1);
    await open(P.md);
    await wait(() => document.getElementById('src').value.includes('plain markdown'));
    check('A: back on markdown, the textarea shows and the map is gone',
      await page.evaluate(() => getComputedStyle(document.getElementById('src')).visibility !== 'hidden' && !document.querySelector('lat-map:not([hidden])')));
  }

  // ------------------------------------------------------------ B: first paint
  if (on('B')) {
    step = 'B paint';
    await open(P.md);
    const t = [];
    for (let i = 0; i < 3; i++) {
      const ms = await page.evaluate(async (n) => {
        const t0 = performance.now();
        window.latTabs.openIn('page', n);
        for (;;) {
          const h = document.querySelector('lat-map:not([hidden])');
          if (h && h.dataset.painted && document.getElementById('pname').value === n) return performance.now() - t0;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }, P.big);
      t.push(Math.round(ms));
      await open(P.md);
    }
    console.log('    B: open to features painted, 500 features: ' + t.join(', ') + ' ms');
    check('B: a 500-feature map paints within the Doherty threshold (400 ms)', Math.min(...t) < 400, t.join(','));
    await open(P.big);
    await mounted();
    const n = await page.evaluate(() => document.querySelectorAll('lat-map:not([hidden]) .lm-list [role=listitem]').length);
    check('B: the feature list shows the features', n > 0, String(n));
  }

  // ------------------------------------------------------------ C: edit, undo
  if (on('C')) {
    step = 'C edit';
    await open(P.small);
    await mounted();
    const before = await srcVal();
    await page.click('lat-map:not([hidden]) [data-tool="point"]');
    const box = await page.$eval('lat-map:not([hidden]) .lm-map', (e) => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2 + 40, r.y + r.height / 2 + 30]; });
    const t0 = Date.now();
    await page.mouse.click(box[0], box[1]);
    const after = await waitFor(async () => { const v = await srcVal(); return v !== before ? v : null; }, 5000, 5);
    const rt = Date.now() - t0;
    console.log('    C: a click to the new body in the textarea: ' + rt + ' ms (puppeteer round trip included)');
    check('C: a drawn point reaches the page buffer', !!after && after.split('\n').length === before.split('\n').length + 1);
    //  the new feature's line, and the comma JSON needs after the old last one
    const bl = before.split('\n'), al = after ? after.split('\n') : [];
    const added = al.filter((l) => !bl.includes(l)), gone = bl.filter((l) => !al.includes(l));
    check('C: as one new line (and the comma before it)', added.length === 2 && gone.length === 1 && added.includes(gone[0] + ',')
      && added.some((l) => /"Point"/.test(l) && !bl.includes(l.replace(/,$/, ''))), added.join(' | ').slice(0, 200));
    const saved = await waitFor(async () => { const d = await shipBody(P.small); return d && d.body === after ? d : null; }, 30000, 500);
    check('C: autosave puts it on the ship, still a map', !!saved && saved.kind === 'geojson');
    step = 'C undo';
    await page.click('lat-map:not([hidden]) [data-tool="select"]');
    await page.focus('lat-map:not([hidden]) .lm-map');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    const undone = await waitFor(async () => ((await srcVal()) === before ? true : null), 5000, 50);
    check('C: undo in the map takes the point out of the textarea', !!undone);
    const savedU = await waitFor(async () => { const d = await shipBody(P.small); return d && d.body === before ? d : null; }, 30000, 500);
    check('C: and the undo is saved too', !!savedU);
    await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z');
    await page.keyboard.up('Shift'); await page.keyboard.up('Control');
    check('C: redo puts it back', !!(await waitFor(async () => ((await srcVal()) === after ? true : null), 5000, 50)));
  }

  // ------------------------------------------------------------ D: tiles
  if (on('D')) {
    step = 'D no token';
    tileReqs = [];
    await page.goto(APP + '?name=' + encodeURIComponent(P.small), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await mounted();
    await sleep(1500);
    check('D: without a token the map asks for no tile', tileReqs.length === 0, String(tileReqs.length));
    //  the rest needs tiles to come back: a test build and its stub
    if (STUB) {
      step = 'D token';
      const r = await api('map-token', { method: 'POST', body: 'pk.ui-map-test' });
      check('D: the token saves', r.ok);
      const st = await (await api('tile-status')).json();
      check('D: the status says one is set, and not what it is', st.token === true && !JSON.stringify(st).includes('ui-map-test'));
      const h0 = stubHits();
      tileReqs = [];
      await page.goto(APP + '?name=' + encodeURIComponent(P.small), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await mounted();
      await waitFor(() => page.evaluate(() => [...document.querySelectorAll('lat-map:not([hidden]) img.leaflet-tile')].filter((i) => i.complete).length > 0), 20000, 250);
      await sleep(2000);
      const first = tileReqs.length;
      check('D: with a token the map asks the ship for tiles', first > 0, String(first));
      check('D: 512 px tiles, one zoom down', tileReqs.every((u) => /\/tile\/streets\/8\/\d+\/\d+$/.test(new URL(u).pathname)), tileReqs.slice(0, 2).join(' '));
      const h1 = stubHits();
      if (STUB) check('D: each reached the tile server once', h1 - h0 === new Set(tileReqs.map((u) => new URL(u).pathname)).size, `${h1 - h0} for ${first}`);
      const cached = await tileCache();
      check('D: the worker keeps them in lattice-tiles', cached >= new Set(tileReqs.map((u) => new URL(u).pathname)).size, String(cached));
      const hd = await page.evaluate(async (u) => { const r = await fetch(u); return [r.headers.get('cache-control'), r.headers.get('x-mapbox-secret'), r.headers.get('content-type')]; }, tileReqs[0]);
      check('D: a tile is private for 30 days and carries no server header', hd[0] === 'private, max-age=2592000' && hd[1] === null && hd[2] === 'image/png', JSON.stringify(hd));
      step = 'D again';
      tileReqs = [];
      await page.goto(APP + '?name=' + encodeURIComponent(P.small), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await mounted();
      await sleep(2500);
      if (STUB) check('D: the same area again fetches no tile from the server', stubHits() === h1, `${stubHits() - h1} fetched`);
      const offShip = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/apps\/lattice\/tile\//.test(e.name) && e.transferSize > 0 && e.workerStart === 0).length);
      check('D: and the worker answered them all', offShip === 0, String(offShip));
      step = 'D refresh';
      await page.evaluate(() => [...document.querySelectorAll('lat-map:not([hidden]) button')].find((b) => /refresh/i.test(b.title + b.textContent)).click());
      await sleep(2500);
      if (STUB) check('D: "Refresh this area" fetches the tiles in view again', stubHits() > h1, String(stubHits() - h1));
    }
  }

  // ------------------------------------------------------------ E: source, kind
  if (on('E')) {
    step = 'E source';
    await open(P.small);
    await mounted();
    await page.evaluate(() => { document.getElementById('tmenu').click(); document.querySelector('.tmenu [data-mi="source"]').click(); });
    await sleep(300);
    const sv = await page.evaluate(() => ({
      vis: getComputedStyle(document.getElementById('src')).visibility,
      map: !!document.querySelector('lat-map:not([hidden]) .lm-map'),
      json: document.getElementById('src').value.startsWith('{"type":"FeatureCollection"'),
    }));
    check('E: Source shows the JSON in the textarea', sv.vis !== 'hidden' && !sv.map && sv.json, JSON.stringify(sv));
    await page.evaluate(() => { document.getElementById('tmenu').click(); document.querySelector('.tmenu [data-mi="source"]').click(); });
    await mounted();
    step = 'E kind';
    await page.evaluate(() => {
      document.getElementById('tmenu').click();
      document.querySelector('.tmenu [data-mi="kind"]').click();
      document.querySelector('.tmenu [data-kind="md"]').click();
    });
    await sleep(300);
    check('E: the kind picker refuses geojson to md', await page.evaluate(() => document.getElementById('pkind').value) === 'geojson');
    await page.keyboard.press('Escape');
    await open(P.md);
    await page.evaluate(() => {
      document.getElementById('tmenu').click();
      document.querySelector('.tmenu [data-mi="kind"]').click();
      document.querySelector('.tmenu [data-kind="geojson"]').click();
    });
    await sleep(300);
    check('E: and markdown with text to geojson', await page.evaluate(() => document.getElementById('pkind').value) === 'md');
    await page.keyboard.press('Escape');
  }

  // ------------------------------------------------------------ F: create
  if (on('F')) {
    step = 'F create';
    await page.evaluate(() => document.getElementById('newfile').click());
    await wait(() => !!document.getElementById('dlginput'));
    const hasKind = await page.evaluate(() => [...document.getElementById('dlgkind').options].some((o) => o.value === 'geojson'));
    check('F: the new-page dialog offers the map kind', hasKind);
    await page.evaluate((n) => {
      const i = document.getElementById('dlginput');
      i.value = n; i.dispatchEvent(new Event('input'));
      const k = document.getElementById('dlgkind');
      k.value = 'geojson'; k.dispatchEvent(new Event('change'));
      document.getElementById('dlgok').click();
    }, P.made);
    await mounted();
    const made = await waitFor(async () => { const d = await shipBody(P.made); return d && d.kind === 'geojson' ? d : null; }, 20000, 500);
    check('F: a page made as a map is an empty collection on the ship',
      !!made && made.body === '{"type":"FeatureCollection","lattice":{},"features":[\n]}\n', JSON.stringify(made && made.body));
  }

  // ------------------------------------------------------------ H: offline
  if (on('H')) {
    step = 'H offline';
    await open(P.off);
    await mounted();
    await sleep(2500);
    check('H: the worker cached map.js on first use', await page.evaluate(async () => !!(await caches.match('/apps/lattice/app/map.js'))));
    const sw = await page.evaluate(async () => (await fetch('/apps/lattice/sw.js')).text());
    const shell = (sw.match(/var SHELL=\[[^\]]*\]/) || [''])[0];
    check('H: and it is not in the install precache list', shell.length > 0 && !shell.includes('map.js'));
    const had = await tileCache();
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const offOk = await waitFor(() => page.evaluate(() => { const h = document.querySelector('lat-map:not([hidden])'); return !!h && !!h.dataset.painted; }), 30000, 500);
    check('H: offline, the map opens from the worker', !!offOk);
    if (had) {
      const shown = await waitFor(() => page.evaluate(() => [...document.querySelectorAll('lat-map:not([hidden]) img.leaflet-tile')].filter((i) => i.complete && i.naturalWidth > 0).length), 15000, 500);
      const why = shown ? '' : await page.evaluate(() => JSON.stringify({ st: localStorage.latTiles,
        imgs: [...document.querySelectorAll('lat-map:not([hidden]) img.leaflet-tile')].slice(0, 3).map((i) => [i.src, i.complete, i.naturalWidth]) }));
      check('H: with the tiles it had', shown > 0, String(shown) + ' ' + why);
    }
    await page.setOfflineMode(false);
  }
} catch (e) {
  check('no exception (' + step + ')', false, String(e && e.stack || e).slice(0, 400));
} finally {
  await api('map-token', { method: 'POST', body: '' }).catch(() => {});
  for (const n of Object.values(P)) await api('page-del?name=' + encodeURIComponent(n), { method: 'POST' }).catch(() => {});
  await api('page-del?name=' + encodeURIComponent(RUN), { method: 'POST' }).catch(() => {});
  await browser.close().catch(() => {});
}
check.done();
