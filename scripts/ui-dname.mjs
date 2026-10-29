// Display names in the real UI: type a name with capitals and spaces into
// the new-page dialog, create, and the tree shows the typed name over the
// slug path.
//   LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-dname.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'uidn' + Date.now().toString(36);
const browser = await launchBrowser();
const errors = [];
const page = await openPage(browser, env, { viewport: { width: 1280, height: 900 }, onPageError: (e) => errors.push(String(e)) });
await page.goto(env.app, { waitUntil: 'domcontentloaded' });
// the service worker takes control and reloads the shell once on a fresh
// profile; anything typed before that reload is lost
await sleep(8000);
await page.waitForSelector('#treelist', { timeout: 30000 });
await sleep(1000);

const wait = async (fn, arg, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(fn, arg)) return true;
    await sleep(500);
  }
  return false;
};

// + file asks for the name and kind and writes the page at once
const create = async (name) => {
  await page.evaluate(() => document.getElementById('newfile').click());
  await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 30000 });
  await page.evaluate((n) => {
    document.getElementById('dlginput').value = n;
    document.getElementById('dlgkind').value = 'md';
    document.getElementById('dlgok').click();
  }, name);
  await page.waitForFunction(() => document.getElementById('dlg').hidden, { timeout: 30000 });
};

// a page typed with capitals and a space
await create(RUN + '/My Page');
const shown = await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.textContent === 'My Page.md' && a.href.includes(encodeURIComponent(n + '/my-page'))), RUN);
check('the tree shows "My Page.md" for the page saved at my-page', shown);
const pnameVal = await page.evaluate(() => document.getElementById('pname').value);
check('the name field shows the real path', pnameVal === RUN + '/my-page', pnameVal);
const tip = await page.evaluate((n) => {
  const a = [...document.querySelectorAll('#treelist a.pg')].find((x) => x.textContent === 'My Page.md');
  return a ? a.title : null;
}, RUN);
check('the row tooltip is the real path', tip === RUN + '/my-page', tip);
await wait(() => /shown as My Page/.test(document.getElementById('status').textContent));
const status = await page.evaluate(() => document.getElementById('status').textContent);
check('the status says what happened', /shown as My Page/.test(status), status);

// a valid name shows as itself and carries no display name
await create(RUN + '/plain');
check('a valid name shows as itself', await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.textContent === 'plain.md' && a.href.includes(encodeURIComponent(n + '/plain'))), RUN));

// a nested typed name names the folder it creates as well
await create(RUN + '/Sub Folder/Deep Page');
check('the page shows as "Deep Page.md" at sub-folder/deep-page', await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.textContent === 'Deep Page.md' && a.href.includes(encodeURIComponent(n + '/sub-folder/deep-page'))), RUN));
check('the folder the save made shows as "Sub Folder"', await wait((n) => [...document.querySelectorAll('#treelist .fld')]
  .some((f) => f.textContent.includes('Sub Folder') && f.querySelector('[title="' + n + '/sub-folder"]')), RUN));

// the ship agrees: dump carries dname for one and not the other
const dump = await page.evaluate(async () => (await (await fetch('/apps/lattice/page-dump')).json()).nodes);
const sf = dump.find((n) => n.path === RUN + '/sub-folder');
check('page-dump carries the folder dname', sf && sf.dname === 'Sub Folder', JSON.stringify(sf));
const mp = dump.find((n) => n.path === RUN + '/my-page');
const pl = dump.find((n) => n.path === RUN + '/plain');
check('page-dump carries dname for the slugged page', mp && mp.dname === 'My Page', JSON.stringify(mp));
check('page-dump carries no dname for the valid one', pl && !('dname' in pl), JSON.stringify(pl));

// a fresh load renders from the dump the same way
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#treelist', { timeout: 30000 });
check('after reload the tree still shows "My Page.md"', await wait((n) => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.textContent === 'My Page.md' && a.href.includes(encodeURIComponent(n + '/my-page'))), RUN));

// two creates back to back, no wait between them: both pages land under
// their own names, and what is typed after the second goes into the second
const TA = RUN + '/twin-a', TB = RUN + '/twin-b';
const src = async (n) => {
  const r = await fetch(env.base + '/apps/lattice/page-source?name=' + encodeURIComponent(n),
    { headers: { Cookie: env.cookie } });
  return r.ok ? ((await r.json()).body || '') : null;
};
await create(TA);
await create(TB);
//  type only once the first create has landed: that landing is what used
//  to take the second page's blank buffer for its own
for (let i = 0; i < 60 && (await src(TA)) === null; i++) await sleep(500);
await sleep(1500);
await page.evaluate(() => {
  const s = document.getElementById('src');
  s.value = 'TWINB typed'; s.dispatchEvent(new Event('input'));
});
let twins = null;
for (let i = 0; i < 60; i++) {
  twins = { a: await src(TA), b: await src(TB) };
  if (twins.a !== null && twins.b !== null && twins.b.includes('TWINB')) break;
  await sleep(1000);
}
check('back-to-back creates: both pages exist on the ship', twins.a !== null && twins.b !== null,
  JSON.stringify(twins));
check('and the typing went into the second, not the first',
  (twins.b || '').includes('TWINB') && !(twins.a || '').includes('TWINB'), JSON.stringify(twins));
const front = await page.evaluate(() => {
  const s = window.latTabs.state();
  return [s.tabs[s.active].key, document.getElementById('pname').value];
});
check('and the editor names the second', front[0] === TB && front[1] === TB, JSON.stringify(front));

check('no uncaught exceptions in the app', errors.length === 0, errors.join(' | '));
await page.evaluate(async (n) => { await fetch('/apps/lattice/page-del?name=' + n, { method: 'POST' }); }, RUN);
await browser.close();
console.log(check.fails ? 'ui-dname FAILED (' + check.fails + ')' : 'ui-dname PASSED');
process.exit(check.fails ? 1 : 0);
