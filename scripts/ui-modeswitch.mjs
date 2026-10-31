//  ui-modeswitch.mjs — pages and memories are tab kinds, not modes.
//
//  There used to be one listing under a pages/knowledge toggle, and the
//  toggle repainted it (reported on ricsul 2026-09-16 as multi-second: the
//  OTHER mode's listing sat under the heading until the round trip came
//  back). Now Files and Knowledge each keep their own listing in their own
//  left pane tab, and the editor's mode follows the front document tab:
//
//    opening a memory leaves the Files listing exactly as it was
//    opening a page leaves the Knowledge listing exactly as it was
//    switching between a page tab and a memory tab flips the editor's mode
//      with the click, with no listing round trip in the way
//    a reload with a memory tab in front still paints the Files tree
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-modeswitch.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, seed, swControlled, waitFor } from './lib/harness.mjs';

const env = shipEnv();
//  generous against a remote pier: the round trip is seconds; a paint is not
const BUDGET = +(process.env.BUDGET || 250);
//  a fixed key, restored and reused: know-delete is a soft delete with no
//  purge route, so a per-run key would leave one in the trash every run
const MEM = 'test/modeswitch-suite';
const leaf = MEM.split('/').pop();
const post = (path, body) => fetch(env.base + '/apps/lattice/' + path,
  { method: 'POST', headers: { Cookie: env.cookie }, body });

const check = makeCheck();
const browser = await launchBrowser();
const p = await openPage(browser, env, { viewport: { width: 1400, height: 800 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false) });
const files = () => p.evaluate(() => document.getElementById('treelist').textContent);
const memories = () => p.evaluate(() => document.getElementById('knowlist').textContent);
const inKnow = () => p.evaluate(() => document.getElementById('ws').classList.contains('know'));

try {
  await post('know-restore?key=' + encodeURIComponent(MEM)).catch(() => {});
  await post('know-save?key=' + encodeURIComponent(MEM), 'modeswitch memory');
  //  a fresh ship's vault is empty and its tree has no page rows to wait for
  await seed(env, [['uimodeswitch-fixture', '# a page for the tree\n']]);
  await p.goto(env.app + '/no-such-asset', { timeout: 30000 });
  await p.evaluate(() => { localStorage.removeItem('appTabs'); localStorage.removeItem('appLTab'); });
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });
  await swControlled(p);   // the SW has the page: no takeover reload to come
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });

  await p.evaluate(() => document.querySelector('#ltabs [data-pt=know]').click());
  await p.waitForFunction((l) => [...document.querySelectorAll('#knowlist a.pg')]
    .some((a) => a.textContent === l), { timeout: 30000 }, leaf);
  const pages0 = await files();
  const mem0 = await memories();

  // a memory opens in a tab of its own (Ctrl+click); Files never moves
  await p.evaluate((l) => {
    const a = [...document.querySelectorAll('#knowlist a.pg')].find((x) => x.textContent === l);
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }, leaf);
  await p.waitForFunction((k) => {
    const s = window.latTabs.state();
    return s.tabs[s.active].kind === 'know' && s.tabs[s.active].key === k && s.shows;
  }, { timeout: 30000 }, MEM);
  check('a memory opens as a know tab', await inKnow());
  check('...and the Files listing is untouched by it', (await files()) === pages0);

  // back to the page tab, and the Knowledge listing stays as it was
  const tabOf = (kind) => p.evaluate((k) => window.latTabs.state().tabs.findIndex((t) => t.kind === k), kind);
  const flip = async (kind, want) => {
    const i = await tabOf(kind);
    const t0 = Date.now();
    await p.evaluate((n) => document.querySelectorAll('#doctabs .dtab')[n].click(), i);
    await p.waitForFunction((w) => document.getElementById('ws').classList.contains('know') === w,
      { timeout: 30000 }, want);
    return Date.now() - t0;
  };
  let t = await flip('page', false);
  check('know tab -> page tab: the mode follows with the click', t <= BUDGET, t + 'ms');
  await sleep(500);
  check('...and the Knowledge listing is untouched by it', (await memories()) === mem0);
  check('...and Files is still the page tree', (await files()) === pages0);
  t = await flip('know', true);
  check('page tab -> know tab: the mode follows with the click', t <= BUDGET, t + 'ms');
  await sleep(500);
  check('...and both listings are still their own',
    (await memories()) === mem0 && (await files()) === pages0);

  // a reload with the memory tab in front: Files is painted, not blank or
  // left holding memories
  await waitFor(() => p.evaluate(() => !window.__latUnsaved || !window.__latUnsaved()), 10000);
  const dumped = p.waitForResponse((r) => r.url().includes('/page-dump'), { timeout: 60000 }).catch(() => null);
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction((k) => {
    const s = window.latTabs && window.latTabs.state();
    return s && s.tabs[s.active] && s.tabs[s.active].kind === 'know' && s.tabs[s.active].key === k && s.shows;
  }, { timeout: 60000 }, MEM);
  await dumped; await sleep(1000);   // past the page dump boot also loads, and its paint
  const after = await p.evaluate(() => ({
    pages: document.querySelectorAll('#treelist a.pg[href*="name="]').length,
    stray: document.querySelectorAll('#treelist a.pg:not([href*="name="])').length,
    sec: document.getElementById('treesec').textContent,
  }));
  check('a reload with a memory tab in front still paints the Files tree',
    after.pages > 0 && after.stray === 0 && after.sec === 'files', JSON.stringify(after));
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await p.evaluate(() => { localStorage.removeItem('appTabs'); localStorage.removeItem('appLTab'); })
    .catch(() => {});
  await browser.close();
  await post('know-delete?key=' + encodeURIComponent(MEM)).catch(() => {});
}
check.done();
