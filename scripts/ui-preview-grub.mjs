//  ui-preview-grub.mjs: a grub opened in a Read tab takes over the pane.
//
//  Found by scripts/fuzz-preview.mjs: [["open",0],["read",0],["grub",14]].
//  A grub (a shared-with-me page, or any file in the ball) opened in place
//  in a tab that is in Read left the page before it in the preview, since
//  neither openGrub (40-grub.js) nor the grub tab's restore (21-tabs.js)
//  repainted the pane. A grub of a kind with no client renderer now says
//  it has no preview instead.
//
//  The checks read the frame's own document (puppeteer reaches into the
//  sandbox), so they see what is on screen, not what the app wrote.
//
//  Usage: LATTICE_URL=http://localhost:8205 LATTICE_COOKIE=/tmp/cookie \
//           node scripts/ui-preview-grub.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, seed, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'pgrub' + (process.pid % 100000);
const A = RUN + '/a', B = RUN + '/b', C = RUN + '/c', H = RUN + '/h';
const BUDGET = 4000;
const NONE = 'No preview for this file';

const b = await launchBrowser();
const p = await openPage(b, env, { viewport: { width: 1400, height: 900 },
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false) });
p.on('dialog', (d) => d.accept().catch(() => {}));
//  a peer's shared page: ~nec answers browse-file with the page's prose
//  and its builder, as a host does, from this ship's own copy
await p.setRequestInterception(true);
p.on('request', async (q) => {
  const u = q.url();
  if (!u.includes('/browse-file?')) { q.continue().catch(() => {}); return; }
  try {
    const n = (/\/page\/(.+)\/code$/.exec(new URL(u).searchParams.get('path')) || [])[1];
    const d = await (await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(n),
      { headers: { Cookie: env.cookie } })).json();
    await q.respond({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ body: d.body, builder: d.kind, mark: '/lattice/page', editable: true, rev: d.rev }) });
  } catch { q.respond({ status: 404, body: '' }).catch(() => {}); }
});
const boot = async () => {
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => window.latTabs && document.querySelectorAll('#treelist a.pg').length > 0,
    { timeout: 90000 });
};
const shown = async () => {
  const h = await p.$('#prev');
  const f = h && await h.contentFrame();
  return f ? f.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '') : '';
};
//  `word` shows, and `gone` (the page before) does not
const shows = async (word, gone) => {
  for (const t0 = Date.now(); Date.now() - t0 < BUDGET; await sleep(200)) {
    const t = await shown();
    if (t.includes(word) && !(gone && t.includes(gone))) return true;
  }
  return false;
};
//  a computed page's preview: the frame loads the page's /f/ document,
//  which a cold ship builds first, so it gets longer than BUDGET
const computed = async (n) => {
  for (const t0 = Date.now(); Date.now() - t0 < 20000; await sleep(200)) {
    const h = await p.$('#prev');
    const f = h && await h.contentFrame();
    if (f && f.url().includes('/f/' + n) && !(await shown()).includes(NONE)) return true;
  }
  return false;
};
const holds = async () => 'pane holds ' + JSON.stringify((await shown()).slice(0, 60));
const front = (kind, key) => p.waitForFunction((k, y) => {
  const s = window.latTabs.state();
  return s.active >= 0 && s.tabs[s.active].kind === y && s.tabs[s.active].key === k && s.shows;
}, { timeout: 30000 }, key, kind);
const grubOf = async (n, ship) => p.evaluate(async (n, ship) => {
  let base = localStorage.latBase;
  if (!base) base = (await (await fetch('/apps/lattice/streams')).json()).base;
  return (ship ? '/apps/lattice.lattice_app' : base) + '/page/' + n + '/code';
}, n, ship);
const openGrub = async (n, ship, newTab = false) => {
  const k = await grubOf(n, ship);
  await p.evaluate((k, ship, newTab) => window.latTabs.openIn('grub', k, { ship, newTab }), k, ship, newTab);
  await front('grub', k);
  await p.waitForFunction(() => !/^loading /.test(document.getElementById('status')?.textContent || ''),
    { timeout: 30000 }).catch(() => {});
  return k;
};
const openPageRead = async (n) => {
  await p.evaluate((k) => window.latTabs.openIn('page', k), n);
  await front('page', n);
  await p.evaluate(() => window.latSetRead(true));
};

try {
  await seed(env, [[A, '# Alpha\n\nPelican harbour lighthouse\n'], [B, '# Bravo\n\nGranite observatory dome\n'],
    [C, '# Charlie\n\nWalrus tundra expedition\n']]);
  //  seed makes md pages only
  await fetch(env.base + '/apps/lattice/page-save?type=hoon&new=1&name=' + encodeURIComponent(H),
    { method: 'POST', headers: { Cookie: env.cookie }, body: '[%hotel %quasar]\n' });
  await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.evaluate(() => { for (const k of ['appTabs', 'appPage']) localStorage.removeItem(k); });
  await boot();

  //  the fuzzer's walk: a page in Read, then a shared page in place
  await openPageRead(A);
  check('Read shows the page', await shows('harbour'), await holds());
  await openGrub(C, '~nec');
  check("a shared page opened in place in Read shows its own text", await shows('tundra', 'harbour'), await holds());

  //  a kind with no client renderer says so, never the page before: a
  //  shared hoon page, and a local page's grub, which is its hoon source
  await openPageRead(A);
  await shows('harbour');
  await openGrub(H, '~nec');
  check('a shared hoon page in Read says it has no preview', await shows(NONE, 'harbour'), await holds());
  await openPageRead(A);
  await shows('harbour');
  await openGrub(B);
  check("a local page's grub (hoon source) in Read says it has no preview", await shows(NONE, 'harbour'), await holds());

  //  a grub tab's unsaved buffer comes back into Read: the restore path
  const g = await openGrub(B, '~nec', true);
  await p.evaluate(() => window.latSetRead(false));
  await p.focus('#src');
  await p.evaluate(() => { const s = document.getElementById('src'); s.setSelectionRange(s.value.length, s.value.length); });
  await p.keyboard.type('Zeppelin');
  await p.evaluate(() => window.latSetRead(true));
  check('the edited grub previews its buffer', await shows('Zeppelin'), await holds());
  const gid = await p.evaluate((k) => window.latTabs.list().find((t) => t.kind === 'grub' && t.key === k).id, g);
  await p.evaluate(() => window.latTabs.openIn('page', '', { newTab: true }));
  await openPageRead(A);
  check('another tab in Read shows its page', await shows('harbour', 'Zeppelin'), await holds());
  await p.evaluate((id) => window.latTabs.switchTab(id), gid);
  await front('grub', g);
  check("back on the grub tab, the pane shows its unsaved buffer", await shows('Zeppelin', 'harbour'), await holds());

  //  fuzz-preview seed 7027: a hoon page in Read, a split, and a grub in
  //  the new group (in Edit). Closing that group brought the page back
  //  through its tab's restore, which painted no computed preview, so the
  //  pane kept the "no preview" the grub's state had just painted on it.
  //  Leaving the group for the page's group did the same.
  for (const how of ['close', 'focus']) {
    await p.evaluate(() => { for (const k of ['appTabs', 'appPage']) localStorage.removeItem(k); });
    await boot();
    await openPageRead(H);
    check(how + ': the hoon page in Read shows its preview', await computed(H), await holds());
    await p.keyboard.down('Control'); await p.keyboard.press('Backslash'); await p.keyboard.up('Control');
    await p.waitForFunction(() => window.latTabs.groups().length === 2, { timeout: 30000 });
    await openGrub(B);
    if (how === 'close') {
      const gs = await p.evaluate(() => window.latTabs.groups());
      for (const t of gs[1].tabs) await p.evaluate((id) => window.latTabs.closeTab(id), t.id);
      await p.waitForFunction(() => window.latTabs.groups().length === 1, { timeout: 30000 });
    } else {
      await p.evaluate(() => window.latTabs.focus(0));
    }
    await front('page', H);
    check(how + ': back on the hoon page, the pane shows its preview, not "no preview"',
      await computed(H), await holds());
  }
} catch (e) {
  check('suite crashed: ' + e.message, false);
} finally {
  await p.evaluate(() => { window.latSetRead(false); }).catch(() => {});
  await b.close();
  for (const n of [A, B, C, H, RUN])
    await fetch(env.base + '/apps/lattice/page-del?name=' + encodeURIComponent(n),
      { method: 'POST', headers: { Cookie: env.cookie } }).catch(() => {});
}
check.done();
