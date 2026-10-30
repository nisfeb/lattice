#!/usr/bin/env node
//  ui-since.mjs: a change elsewhere costs an open tab a since-dump, not
//  the whole tree.
//
//  Release 75 answered every /beacon/rev bump in every other open tab with
//  a full /page-dump (every page body, ~800 KB on a 300-page ship) plus
//  page-source and page-sensitive for its open page. A tab now hands back
//  the dump's `since` token and gets only the bodies written since, keeps
//  the bodies it holds, and re-reads its open page only when the dump says
//  that page moved. Checked here, with the writes made from outside the tab
//  (another tab's saves, as the ship sees them):
//
//    a save of another page: one page-dump?since=, far smaller than the
//      boot dump, and no page-source
//    a save of the open page: its new text shows (live refresh)
//    the tree keeps every page's body (the IndexedDB snapshot), and holds
//      the new body of the page that changed
//    a delete and a move elsewhere reach the tree
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-since.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const RUN = 'since-' + process.pid;
const A = RUN + '/a', B = RUN + '/b', C = RUN + '/c', D = RUN + '/d', E = RUN + '/e';
const check = makeCheck({ detailOnPass: true });
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
const page = await openPage(browser, env, {
  viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
page.on('dialog', (d) => d.accept().catch(() => {}));

//  every page-dump and page-source the tab asks for, with its size
const got = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/\/apps\/lattice\/(page-dump|page-source|page-sensitive)/.test(u)) return;
  let n = 0;
  try { n = (await r.buffer()).length; } catch {}
  got.push({ u, n });
});
const post = (path, body) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie }, body });
const tree = () => page.evaluate(() => new Promise((res) => {
  const rq = indexedDB.open('lattice-offline');
  rq.onsuccess = () => {
    try {
      const g = rq.result.transaction('kv', 'readonly').objectStore('kv').get('tree');
      g.onsuccess = () => res((g.result && g.result.v) || []);
      g.onerror = () => res([]);
    } catch { res([]); }
  };
  rq.onerror = () => res([]);
}));
const node = async (p) => (await tree()).find((n) => n.path === p) || null;
const until = async (f, ms = 60000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(500); }
  return false;
};
const since = () => got.filter((g) => /page-dump\?since=/.test(g.u));

try {
  //  bodies the since-dump must leave home: a near-empty ship's whole dump
  //  would be no bigger than a since-dump's node list
  const fill = 'lorem ipsum '.repeat(2000);
  await seed(env, [[A, '# a\n\nfirst'], [B, '# b\n\nfirst'], [C, '# c'], [D, '# d'],
    ...[1, 2, 3, 4, 5, 6].map((i) => [RUN + '/fill/f' + i, '# fill ' + i + '\n\n' + fill])]);
  await page.goto(env.app + '?name=' + encodeURIComponent(A),
    { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0,
    { timeout: 90000 });
  await until(async () => (await page.$eval('#src', (e) => e.value)).includes('first'));
  await sleep(4000);
  const boot = got.filter((g) => /page-dump($|\?)/.test(g.u) && !/since=/.test(g.u));
  const full = boot.length ? boot[boot.length - 1].n : 0;
  check('the tab booted on a whole dump', full > 0, full + ' bytes');

  //  another page saved elsewhere
  got.length = 0;
  await post('page-save?type=md&name=' + encodeURIComponent(B), '# b\n\nsecond');
  const one = await until(() => since().length > 0);
  check('a save elsewhere: the tab fetched a since-dump', one,
    JSON.stringify(got.map((g) => g.u.replace(/.*lattice\//, ''))));
  await sleep(3000);
  const s1 = since()[0];
  check('  ...far smaller than the whole dump', !!s1 && s1.n * 4 < full,
    (s1 ? s1.n : '-') + ' vs ' + full + ' bytes');
  check('  ...and no whole dump', !got.some((g) => /page-dump$/.test(g.u)));
  check('  ...and no page-source of the open page',
    !got.some((g) => /page-source/.test(g.u)), JSON.stringify(got.map((g) => g.u.slice(-50))));
  const nb = await node(B);
  check('  ...the tree holds the new body', !!nb && nb.body === '# b\n\nsecond',
    JSON.stringify(nb && nb.body));
  const na = await node(A), nc = await node(C);
  check('  ...and keeps the bodies it had', !!na && na.body === '# a\n\nfirst' &&
    !!nc && nc.body === '# c', JSON.stringify([na && na.body, nc && nc.body]));

  //  the open page saved elsewhere: live refresh
  got.length = 0;
  await post('page-save?type=md&name=' + encodeURIComponent(A), '# a\n\nsecond');
  const live = await until(async () =>
    (await page.$eval('#src', (e) => e.value)) === '# a\n\nsecond');
  check('the open page saved elsewhere: its new text shows', live);
  check('  ...over a since-dump', since().length > 0 && !got.some((g) => /page-dump$/.test(g.u)));

  //  a delete and a move elsewhere
  await post('page-del?name=' + encodeURIComponent(C));
  check('a delete elsewhere leaves the tree', await until(async () => !(await node(C))));
  await post('page-move?from=' + encodeURIComponent(D) + '&to=' + encodeURIComponent(E));
  check('a move elsewhere reaches the tree', await until(async () =>
    !(await node(D)) && (await node(E)) !== null));
  const ne = await node(E);
  check('  ...the moved page has its body', !!ne && ne.body === '# d', JSON.stringify(ne && ne.body));
} finally {
  await post('page-del?name=' + encodeURIComponent(RUN));
  await browser.close();
}
check.done();
