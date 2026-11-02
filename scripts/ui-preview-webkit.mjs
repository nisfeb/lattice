//  ui-preview-webkit.mjs: on WebKitGTK, a tab in Read brought to the
//  front shows its own page, not the one before it.
//
//  Found by scripts/fuzz-preview.mjs --webkit, seed 7002, shrunk to
//  15 steps whose last one, from a tab in Edit, opens a page that already
//  has a tab in Read. Switching to that tab runs showPreview (Edit to
//  Read), which paints the text still in the editor (the page leaving),
//  and the tab's own text is painted a few ms later. WebKit drops a
//  srcdoc written while the last one is still loading: one load fires
//  with the first document on screen while the attribute holds the
//  second. 10-shell.js (prevBusy) writes it again.
//
//  The race is a few ms wide. The suite goes from a tab in Edit to a tab
//  in Read and back ROUNDS times and checks every arrival. Without the
//  fix about half the arrivals stuck (9 and 10 of 20 in two runs); with
//  it, none in 60.
//
//  It drives WebKitGTK through WebKitWebDriver (lib/wd-page.mjs). With WD
//  unset it starts its own under xvfb-run on a free port, and skips when
//  WebKitWebDriver or xvfb-run is missing.
//
//  Usage: LATTICE_URL=http://localhost:8205 LATTICE_COOKIE=/tmp/cookie \
//           [WD=http://localhost:4455] node scripts/ui-preview-webkit.mjs
import { spawn, execFileSync } from 'child_process';
import { createServer } from 'net';
import { shipEnv, makeCheck, sleep } from './lib/harness.mjs';
import { wdSession } from './lib/wd-page.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'pwk' + (process.pid % 100000);
const PAGES = [['gmi', RUN + '/charlie', '# Charlie\n\nWalrus tundra expedition\n', 'tundra'],
  ['text', RUN + '/echo', 'Echo\nMarmalade orchard ladder\n', 'orchard']];
const ROUNDS = Number(process.env.ROUNDS || 20);
const BUDGET = 4000;

const have = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
});

let wd = process.env.WD, drv = null;
if (!wd) {
  if (!have('WebKitWebDriver') || !have('xvfb-run')) {
    console.log('  skip - no WebKitWebDriver or xvfb-run here');
    process.exit(0);
  }
  const port = await freePort();
  //  its own process group, so the driver, its MiniBrowser and the Xvfb
  //  all go with one kill
  drv = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1200x24', 'WebKitWebDriver', '--port=' + port],
    { detached: true, stdio: 'ignore' });
  wd = 'http://localhost:' + port;
  for (let i = 0; i < 40; i++) {
    if (await fetch(wd + '/status').then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
}
const stopDriver = () => { if (drv) try { process.kill(-drv.pid, 'SIGTERM'); } catch {} };

let p;
const shown = async () => {
  const h = await p.$('#prev');
  return (await h.contentFrame()).evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
};
//  the frame's own document, polled: a slow paint is fine, a stuck one is not
const shows = async (word) => {
  let t = '';
  for (const t0 = Date.now(); Date.now() - t0 < BUDGET; await sleep(200)) {
    t = await shown();
    if (t.includes(word)) return [true, t];
  }
  return [false, t];
};
const front = (key) => p.waitForFunction((k) => {
  const s = window.latTabs.state();
  return s.active >= 0 && s.tabs[s.active].key === k && s.shows;
}, { timeout: 30000 }, key);

try {
  for (const [kind, n, b] of PAGES) {
    await fetch(env.base + '/apps/lattice/page-save?type=' + kind + '&new=1&name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie }, body: b });
  }
  p = await wdSession(wd);
  await p.goto(env.base + '/~/host');
  await p.setCookie({ name: env.cookieName, value: env.cookieValue, path: '/' });
  await p.setViewport({ width: 1400, height: 900 });
  await p.goto(env.app);
  await p.evaluate(() => { for (const k of ['appTabs', 'appPage']) localStorage.removeItem(k); });
  await p.goto(env.app);
  await p.waitForFunction(() => window.latTabs && document.querySelectorAll('#treelist a.pg').length > 0,
    { timeout: 90000 });

  //  two tabs, the first left in Edit, the second in Read
  const ids = [];
  for (const [i, [, n, , w]] of PAGES.entries()) {
    await p.evaluate((k, nt) => window.latTabs.openIn('page', k, { newTab: nt }), n, i > 0);
    await front(n);
    await p.evaluate(() => window.latSetRead(true));
    const [ok, t] = await shows(w);
    check('Read shows ' + n, ok, 'pane holds ' + JSON.stringify(t.slice(0, 60)));
    if (i === 0) await p.evaluate(() => window.latSetRead(false));
    ids.push(await p.evaluate(() => { const s = window.latTabs.state(); return s.tabs[s.active].id; }));
  }
  let stuck = 0, first = '';
  for (let r = 0; r < ROUNDS; r++) {
    await p.evaluate((id) => window.latTabs.switchTab(id), ids[0]);
    await front(PAGES[0][1]);
    await sleep(300);
    await p.evaluate((id) => window.latTabs.switchTab(id), ids[1]);
    await front(PAGES[1][1]);
    const [ok, t] = await shows(PAGES[1][3]);
    if (!ok) { stuck++; if (!first) first = `switch ${r + 1}: pane holds ${JSON.stringify(t.slice(0, 60))}`; }
  }
  check(`a tab in Read, switched to from one in Edit, shows its page (${ROUNDS} switches)`, !stuck,
    `${stuck} stuck, first: ${first}`);
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  if (p) await p.close();
  stopDriver();
  for (const [, n] of PAGES)
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
  await fetch(env.base + '/apps/lattice/page-del?name=' + RUN,
    { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
