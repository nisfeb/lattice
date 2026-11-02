// A move or rename leaves nothing behind at the old path. A folder move
// copies the folder and then deletes it, so any write of an old name that
// lands after it used to make the old folder again with that one page in
// it: a save typed during the move, a queued edit, or a sync client
// (Seafile on a lattice-fs mount) writing back the copy it held. The ship
// now refuses those (+move-guard), and the editor holds its saves while
// its own move runs and renames itself in place after.
//   LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-foldermove.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, swControlled, seed, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uifm' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const body = async (n) => {
  const r = await api('page-source?name=' + encodeURIComponent(n));
  return r.ok ? ((await r.json()).body || '') : null;
};
const under = async (p) => {
  const t = await (await api('page-tree')).json();
  return t.nodes.map((n) => n.path).filter((x) => x === p || x.startsWith(p + '/')).sort();
};

await seed(env, [[RUN + '/src/a', '# a\n'], [RUN + '/src/b', '# b\n'], [RUN + '/src/c', '# c\n']]);

const browser = await launchBrowser();
const errors = [];
const page = await openPage(browser, env, { viewport: { width: 1280, height: 900 }, onPageError: (e) => errors.push(String(e)) });
const wait = (fn, arg, ms = 30000) => waitFor(() => page.evaluate(fn, arg), ms, 250);
const dialog = async (value) => {
  await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 30000 });
  await page.evaluate((v) => { document.getElementById('dlginput').value = v; }, value);
  await page.click('#dlgok');
};
const type = (t) => page.evaluate((v) => {
  const s = document.getElementById('src');
  s.value = v; s.dispatchEvent(new Event('input'));
}, t);

try {
  // ── a page renamed while its text is still being typed ──────────────────
  await page.goto(env.app + '?name=' + encodeURIComponent(RUN + '/src/a'), { waitUntil: 'domcontentloaded' });
  await swControlled(page);
  await wait(() => document.getElementById('src').value.includes('# a'));
  await type('# a\nbefore the move\n');
  await page.evaluate(() => document.getElementById('mv').click());
  await dialog(RUN + '/src/a2');
  // typed while the move is on the wire: autosave waits it out
  await sleep(150);
  await type('# a\nbefore the move\nduring the move\n');
  const renamed = await wait((n) => document.getElementById('pname').value === n, RUN + '/src/a2');
  check('the editor names the page by its new path', renamed,
    await page.evaluate(() => document.getElementById('pname').value));
  const landed = await waitFor(async () => /during the move/.test((await body(RUN + '/src/a2')) || ''), 30000, 500);
  check('text typed before and during the move lands under the new name', landed,
    JSON.stringify(await body(RUN + '/src/a2')));
  // a late save of the old name would show up within autosave's debounce
  await sleep(4000);
  check('and the old page is not made again', (await body(RUN + '/src/a')) === null,
    JSON.stringify(await body(RUN + '/src/a')));

  // ── the whole folder, from its path ─────────────────────────────────────
  await page.evaluate((n) => {
    const r = [...document.querySelectorAll('#treelist .fld')]
      .find((f) => f.querySelector('.fln') && f.querySelector('.fln').textContent.trim() === 'src'
        && f.getAttribute('data-tk') === 'f:' + n);
    r.click();
  }, RUN + '/src');
  await wait(() => document.getElementById('del').textContent === 'delete folder');
  await page.evaluate(() => document.getElementById('tpath').click());
  await dialog(RUN + '/dst');
  const moved = await waitFor(async () =>
    JSON.stringify(await under(RUN)) === JSON.stringify([RUN, RUN + '/dst', RUN + '/dst/a2', RUN + '/dst/b', RUN + '/dst/c']),
  60000, 500);
  check('the folder moves whole, nothing left at the old path', moved, JSON.stringify(await under(RUN)));

  // ── a stale writer: the copy a sync client held, written back ───────────
  const r = await api('page-save?type=md&name=' + encodeURIComponent(RUN + '/src/b'), { method: 'POST', body: '# b\n' });
  const why = await r.text();
  check('a write of a page that moved away is refused, saying where it went',
    r.status === 409 && why.includes(RUN + '/dst/b'), r.status + ' ' + why);
  check('and does not make the old folder again', !(await under(RUN + '/src')).length,
    JSON.stringify(await under(RUN + '/src')));
  const nw = await api('page-save?type=md&new=1&name=' + encodeURIComponent(RUN + '/src/fresh'), { method: 'POST', body: '# new\n' });
  check('a create at the old path is a new page and lands', nw.ok, String(nw.status));
  await api('page-del?name=' + encodeURIComponent(RUN + '/src'), { method: 'POST' });

  // ── writes into a move while it runs ─────────────────────────────────────
  // The old folder's pages are refused while the move is under way, or
  // land before it starts and move with it. Either way nothing is left.
  let done = false;
  const mv = api('page-move?from=' + encodeURIComponent(RUN + '/dst') + '&to=' + encodeURIComponent(RUN + '/dst2'),
    { method: 'POST' }).then((x) => { done = true; return x; });
  const seen = [];
  while (!done) {
    const s = await api('page-save?type=md&name=' + encodeURIComponent(RUN + '/dst/c'), { method: 'POST', body: '# c late\n' });
    seen.push(s.status);
    await sleep(200);
  }
  const mr = await mv;
  check('the move under writes lands', mr.ok, String(mr.status));
  await sleep(1500);
  const left = await under(RUN + '/dst');
  check('writes into a moving folder leave no old folder behind', !left.length,
    JSON.stringify({ left, seen }));
  check('the moved copy is whole', (await body(RUN + '/dst2/c')) !== null && (await body(RUN + '/dst2/b')) !== null);
} catch (e) {
  check('suite ran to the end', false, String(e && e.stack || e));
}

check('no uncaught exceptions in the app', errors.length === 0, errors.join(' | '));
await api('page-del?name=' + RUN, { method: 'POST' });
await browser.close();
check.done();
