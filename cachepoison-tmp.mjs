// Does a stale upgrade response survive in pageCache/snapPage and come back
// to overwrite the editor on a later re-open?
import { readFileSync } from 'fs';
import { homedir } from 'os';
const pp = (await import('puppeteer-core')).default;
const ck = readFileSync(homedir() + '/.config/lattice-fs/nec-cookie', 'utf8').trim();
const [n, ...r] = ck.split('=');
const APP = 'http://localhost:8080/apps/lattice/app';
const b = await pp.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900 });
await p.setCookie({ name: n, value: r.join('='), domain: 'localhost', path: '/' });
await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });

//  two pages: the victim, and somewhere to navigate away to
await p.evaluate(async () => {
  await fetch('/apps/lattice/page-save?name=poisonA&type=md&new=1', { method: 'POST', body: '# before edit\n' });
  await fetch('/apps/lattice/page-save?name=poisonB&type=md&new=1', { method: 'POST', body: '# other\n' });
});
await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForFunction(() => [...document.querySelectorAll('#treelist a.pg')]
  .some((a) => a.href.includes('poisonA')), { timeout: 90000 });

//  hold the upgrade fetch for poisonA captive
let release = null;
await p.setRequestInterception(true);
const hold = (q) => {
  const u = q.url();
  if (u.includes('page-source') && u.includes('render=1') && u.includes('poisonA') && !release) {
    release = () => q.continue();
    return;
  }
  q.continue();
};
p.on('request', hold);

const click = (name) => p.evaluate((nm) => {
  [...document.querySelectorAll('#treelist a.pg')].find((a) => a.href.includes(nm)).click();
}, name);

await click('poisonA');
await p.waitForFunction(() => document.getElementById('src').value.includes('before edit'), { timeout: 60000 });

//  type while the upgrade is captive
await p.focus('#src');
await p.keyboard.down('Control'); await p.keyboard.press('KeyA'); await p.keyboard.up('Control');
await p.keyboard.type('# after edit POISONMARK\n', { delay: 10 });
console.log('  upgrade held      :', !!release);

//  let autosave land first, then release the stale response
await new Promise((z) => setTimeout(z, 5000));
if (release) release();
await new Promise((z) => setTimeout(z, 4000));
console.log('  editor right after:', await p.evaluate(() => document.getElementById('src').value.includes('POISONMARK')));

//  navigate away and back: does the cache serve the stale body?
await click('poisonB');
await p.waitForFunction(() => document.getElementById('src').value.includes('other'), { timeout: 60000 });
await click('poisonA');
await new Promise((z) => setTimeout(z, 4000));
const back = await p.evaluate(() => document.getElementById('src').value);
console.log('  after switch back :', back.includes('POISONMARK') ? 'edit SURVIVED' : 'edit LOST -> ' + JSON.stringify(back.slice(0, 40)));

const ship = await p.evaluate(async () => {
  const rr = await fetch('/apps/lattice/page-source?name=poisonA');
  return String((await rr.json()).body || '');
});
console.log('  ship holds        :', ship.includes('POISONMARK') ? 'the edit' : JSON.stringify(ship.slice(0, 40)));

p.off('request', hold);
await p.setRequestInterception(false);
await p.evaluate(async () => {
  await fetch('/apps/lattice/page-del?name=poisonA', { method: 'POST' });
  await fetch('/apps/lattice/page-del?name=poisonB', { method: 'POST' });
});
await b.close();
