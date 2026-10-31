#!/usr/bin/env node
//  ui-sensflag.mjs: the Page tab's sensitive box never shows a page as
//  protected when the ship says it is not.
//
//  The editor keeps each page's own sensitive flag (sensKnown, 20-state.js)
//  so an open costs one request. A move or a delete culls the marker on
//  the ship, so a page made later under the old name is NOT sensitive, and
//  an agent key without clearance can read it. Checked through the real
//  UI, so the writes are this client's own (their beacon echo is
//  suppressed, and no refreshAll forgets the flags for us):
//
//    mark A sensitive, rename A to B, create a new A: A's box is clear,
//      and the ship agrees
//    mark that A sensitive, delete A, create A again: the same
//    B, the renamed page: its box shows what the ship has for it
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-sensflag.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep, swControlled } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'sens-' + process.pid;
const A = RUN + '/a', B = RUN + '/b', C = RUN + '/c';
const browser = await launchBrowser();
const errors = [];
const page = await openPage(browser, env, { viewport: { width: 1400, height: 900 },
  onPageError: (e) => errors.push(String(e)) });
page.on('dialog', (d) => d.accept().catch(() => {}));

const shipSens = async (n) => {
  const r = await fetch(env.base + '/apps/lattice/page-sensitive?name=' + encodeURIComponent(n),
    { headers: { Cookie: env.cookie } });
  return r.ok ? (await r.json()).on === true : null;
};
const until = async (f, ms = 30000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await sleep(250); }
  return false;
};
const box = () => page.evaluate(() => {
  const b = document.getElementById('shsens');
  return { on: b.checked, off: b.disabled, at: document.getElementById('pname').value };
});
//  the page in front, its open settled: no page-source in flight
const shows = (n) => until(() => page.evaluate((x) => {
  const s = document.getElementById('src');
  return document.getElementById('pname').value === x && !!s && !s.readOnly;
}, n));
const openIn = async (n) => {
  await page.evaluate((x) => window.latTabs.openIn('page', x, {}), n);
  await shows(n);
  await sleep(2500);       // the render=1 read lands and the box settles
};
const dlg = async (fill) => {
  await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 30000 });
  await page.evaluate((v) => {
    if (v !== null) document.getElementById('dlginput').value = v;
    if (document.getElementById('dlgkind') && !document.getElementById('dlgkind').hidden)
      document.getElementById('dlgkind').value = 'md';
    document.getElementById('dlgok').click();
  }, fill);
  await page.waitForFunction(() => document.getElementById('dlg').hidden, { timeout: 30000 });
};
const markSensitive = async (n) => {
  await page.evaluate(() => { window.latShell.paneOpen('r', true); window.latShell.paneTab('r', 'page'); });
  await until(() => page.evaluate(() => !document.getElementById('shsens').disabled));
  if (!(await box()).on) await page.click('#shsens');
  return until(async () => (await shipSens(n)) === true && (await box()).on && !(await box()).off);
};
const create = async (n) => {
  await page.evaluate(() => document.getElementById('newfile').click());
  await dlg(n);
  await shows(n);
};
//  the box for the page in front, once the ship's answer can have landed:
//  it must match the ship, and a stale "sensitive" must not linger
const boxMatchesShip = async (n, label) => {
  await openIn(C);
  await openIn(n);
  const ship = await shipSens(n);
  const ok = await until(async () => (await box()).on === ship, 8000);
  await sleep(1500);
  const b = await box();
  check(label, ship === false && ok && b.on === false && b.at === n, JSON.stringify({ ship, b }));
};

await seed(env, [[A, '# a\n\nfirst\n'], [C, '# c\n']]);
await page.goto(env.app + '?name=' + encodeURIComponent(A), { waitUntil: 'domcontentloaded', timeout: 90000 });
await swControlled(page).catch(() => {});
await shows(A);
await sleep(2000);

// ── 1. rename ───────────────────────────────────────────────────────────
check('A can be marked sensitive from the box', await markSensitive(A), JSON.stringify(await box()));
await page.evaluate(() => document.getElementById('mv').click());
await dlg(B);
check('A is renamed to B', await shows(B), JSON.stringify(await box()));
await create(A);
await boxMatchesShip(A, 'after a rename, a new page under the old name is not shown sensitive');
{
  await openIn(B);
  const ship = await shipSens(B);
  const ok = await until(async () => (await box()).on === ship, 8000);
  check('the renamed page\'s box shows what the ship has', ok, JSON.stringify({ ship, b: await box() }));
}

// ── 2. delete ───────────────────────────────────────────────────────────
await openIn(A);
check('the new A can be marked sensitive', await markSensitive(A), JSON.stringify(await box()));
await page.evaluate(() => document.getElementById('del').click());
await dlg(null);
check('A is deleted', await until(async () => (await shipSens(A)) !== true
  && !(await page.evaluate((x) => [...document.querySelectorAll('#treelist a.pg')]
    .some((a) => decodeURIComponent(a.getAttribute('href') || '').endsWith('name=' + x)), A))), '');
await create(A);
await boxMatchesShip(A, 'after a delete, a page made again under the name is not shown sensitive');

check('no uncaught exceptions in the app', errors.length === 0, errors.join(' | '));
await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(RUN),
  { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
await browser.close();
console.log(check.fails ? check.fails + ' check(s) FAILED' : 'all checks passed');
process.exit(check.fails ? 1 : 0);
