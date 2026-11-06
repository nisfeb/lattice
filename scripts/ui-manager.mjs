//  ui-manager.mjs — leaving the desktop connection page.
//
//  manager.html is a PAGE in the single window, not a second window, so there
//  is no title bar to close and no back button from the shell. Whatever the
//  page itself offers is the only way out. That used to be an "open lattice →"
//  primary button three rows down in the ship panel, which does not read as
//  "leave this" and is not where anyone looks; it is now a plain "close" at
//  the end of the header, the wording and position the in-app panes use.
//
//  Worth a test because the failure mode is being stuck on the page with no
//  exit. The button is ALWAYS on screen — above all it must not wait for the
//  connection check, which is a real round-trip to the ship and the reason
//  the exit used to take seconds to appear. Where there is no ship behind
//  the page, go_home refuses cleanly and the refusal is shown.
//
//  It also covers the "use lattice anonymously" option: beside the connect
//  form with no node (the one first-run path, no competing card above it),
//  still offered with one, hidden without the engine, its copy, and that
//  choosing it opens the reader's start page.
//
//  No ship and no app needed: the page is loaded from file:// with a stubbed
//  Tauri backend, so this runs anywhere.
//
//  Usage:  node scripts/ui-manager.mjs
//  Setup:  npm i --no-save puppeteer-core
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { launchBrowser, makeCheck } from './lib/harness.mjs';

const ROOT = new globalThis.URL('..', import.meta.url).pathname;
const P = ROOT + 'desktop/ui/manager.html';
const check = makeCheck();

const browser = await launchBrowser();

const dir = mkdtempSync(join(tmpdir(), 'mgr-'));
const src = readFileSync(P, 'utf8');
//  the page's shared settings look and tabs, beside it as in the app
writeFileSync(join(dir, 'settings.js'), readFileSync(ROOT + 'desktop/ui/settings.js', 'utf8'));

async function load(status, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.evaluateOnNewDocument((s, o) => {
    window.__CALLS__ = [];
    window.__TAURI__ = {
      core: { invoke: (name, args) => { window.__CALLS__.push(name);
        (window.__ARGS__ = window.__ARGS__ || []).push([name, args]);
        if (name === 'reader_status') {
          if (o.noReader) return Promise.reject('this build has no shipless reader');
          return Promise.resolve(o.reader || { engine: 'off', our: null, error: null, step: null });
        }
        if (name === 'connection_status') {
          // statusDelayMs mimics the real thing: a round-trip to the ship
          return new Promise((res) => setTimeout(() => res(s), o.statusDelayMs || 0));
        }
        if (name === 'go_home' && o.rejectGoHome) return Promise.reject('connect to a ship first');
        if (name === 'status') return Promise.resolve({ fuse_available: true, hint: '', theme: o.theme || {} });
        return Promise.resolve(null); } },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  }, status, opts);
  const f = join(dir, 'm.html');
  writeFileSync(f, src);
  await page.goto('file://' + f + (opts.hash || ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__CALLS__.includes('connection_status'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 250));
  return page;
}

// connected: close is offered, sits right of the title, and calls go_home
const on = await load({ connected: true, ship: '~ricsul-bilwyt', url: 'https://s.example.com' });
const st = await on.evaluate(() => {
  const c = document.getElementById('close');
  const h1 = document.querySelector('.top h1');
  return { exists: !!c, hidden: c ? c.hidden : null, label: c ? c.textContent.trim() : null,
           rightOfTitle: c ? c.getBoundingClientRect().left > h1.getBoundingClientRect().right : null,
           openGone: !document.getElementById('open') };
});
check('connected: a close button exists and is shown', st.exists && st.hidden === false, JSON.stringify(st));
check('connected: it is labelled "close", like the in-app panes', st.label === 'close', st.label);
check('connected: it sits after the title, not buried in the ship panel', st.rightOfTitle === true);
check('the old "open lattice" button is gone', st.openGone);
//  the manager is the one home of the scheduled backups: only the user's
//  clicks on this local page can change them (Settings > Backup links here)
const bk = await on.evaluate(() => ({ section: !!document.getElementById('backups'),
  list: !!document.getElementById('backup-list'),
  asked: window.__CALLS__.includes('backup_schedules') }));
check('manager keeps the backups section', bk.section && bk.list && bk.asked, JSON.stringify(bk));
const clicked = await on.evaluate(() => { const n = window.__CALLS__.length;
  document.getElementById('close').click(); return window.__CALLS__.slice(n); });
check('clicking it calls go_home', JSON.stringify(clicked) === '["go_home"]', JSON.stringify(clicked));
const esc = await on.evaluate(() => { const n = window.__CALLS__.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return window.__CALLS__.slice(n); });
check('Escape closes too', JSON.stringify(esc) === '["go_home"]', JSON.stringify(esc));
await on.close();

// THE point: close must exist before the connection check answers. The check
// is a real round-trip to the ship — seconds on a slow pier — and the exit
// used to spend those seconds not existing.
const slow = await load({ connected: true, ship: '~x', url: 'https://s.example.com' },
  { statusDelayMs: 8000 });
check('close is on screen while the check is still in flight',
  await slow.evaluate(() => {
    const c = document.getElementById('close');
    return !!c && !c.hidden && c.offsetParent !== null;
  }));
await slow.close();

// never configured: close stays, and go_home's clean refusal is surfaced
// instead of navigating to a page that cannot load
const off = await load({ connected: false, ship: null, url: '', error: null },
  { rejectGoHome: true });
const st2 = await off.evaluate(async () => {
  const n = window.__CALLS__.length;
  document.getElementById('close').click();
  await new Promise((r) => setTimeout(r, 50));
  return { hidden: document.getElementById('close').hidden,
           called: window.__CALLS__.slice(n),
           statusText: document.getElementById('connect-status').textContent };
});
check('never configured: close is still offered', st2.hidden === false);
check('never configured: clicking it still calls go_home',
  JSON.stringify(st2.called) === '["go_home"]', JSON.stringify(st2.called));
check('and the refusal is shown, not swallowed',
  st2.statusText.includes('connect to a ship first'), JSON.stringify(st2.statusText));
await off.close();

// ── using the app anonymously ─────────────────────────────────────────
const order = (p) => p.evaluate(() => {
  const card = document.getElementById('reader'), form = document.getElementById('connect');
  const h = document.getElementById('ship-h');
  return { shown: !card.hidden,
    // right after the connect form, and nothing of it above the ship section
    beside: form.nextElementSibling === card,
    above: !!(card.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING),
    heading: h.textContent, anon: document.getElementById('anon-h').textContent };
});
const fresh = await load({ connected: false, ship: null, url: '', error: null });
const o1 = await order(fresh);
check('no node: the anonymous option is shown', o1.shown, JSON.stringify(o1));
check('no node: it sits right after the connect form', o1.beside && !o1.above, JSON.stringify(o1));
check('no node: the sections say what they are',
  o1.heading === 'Connect your node' && o1.anon === 'Or use lattice anonymously', JSON.stringify(o1));
const copy = await fresh.evaluate(() => document.getElementById('anon-copy').textContent.replace(/\s+/g, ' '));
check('the option says they can browse and comment but not host without a node',
  copy.includes('browse') && copy.includes('comment') && copy.includes("can't host pages without a node"), copy);
const details = await fresh.evaluate(() => document.getElementById('reader').textContent);
check('it says what network it uses', details.includes('UDP') && details.includes('roller.urbit.org'));
check('and that comments are signed by the reader identity', details.includes('your comments are signed with it'));
check('no address field or second card competes with it',
  await fresh.evaluate(() => !document.getElementById('read-url') && !document.getElementById('read-start')
    && document.querySelectorAll('.card').length === 1));
const opened = await fresh.evaluate(async () => {
  document.getElementById('anon').click();
  await new Promise((r) => setTimeout(r, 50));
  return window.__ARGS__.filter(([n]) => n === 'open_reader').map(([, a]) => a);
});
check('choosing it opens the reader on its start page', JSON.stringify(opened) === '[{"url":null}]',
  JSON.stringify(opened));
const cleared = await fresh.evaluate(async () => {
  document.getElementById('read-clear').click();
  await new Promise((r) => setTimeout(r, 50));
  return window.__CALLS__.includes('clear_reader_history');
});
check('clear reading history invokes clear_reader_history', cleared);
await fresh.close();

const booting = await load({ connected: false, ship: null, url: '', error: null },
  { reader: { engine: 'booting', our: null, error: null, step: 'Setting up this computer' } });
const bt = await booting.evaluate(() => document.getElementById('read-status').textContent);
check('while the engine boots the card says so, how long, and its step',
  bt.includes('Getting ready (about 10 seconds the first time).') && bt.includes('Setting up this computer'), bt);
await booting.close();

const ready = await load({ connected: false, ship: null, url: '', error: null },
  { reader: { engine: 'ready', our: '~doznec-sampel-palnet', error: null, step: null } });
const rd = await ready.evaluate(() => document.getElementById('read-status').textContent);
check('a ready reader says so without its identity\'s name', rd === 'Ready.', rd);
await ready.close();

const failed = await load({ connected: false, ship: null, url: '', error: null },
  { reader: { engine: 'failed', our: null, error: "lattice couldn't reach the internet to set up the reader.", step: null } });
const fd = await failed.evaluate(() => document.getElementById('read-status').textContent);
check('a failed start shows the reason as given', fd === "lattice couldn't reach the internet to set up the reader.", fd);
await failed.close();

const shipped = await load({ connected: true, ship: '~ricsul-bilwyt', url: 'https://s.example.com' });
const o2 = await order(shipped);
check('with a node: the option is still offered, after the ship section',
  o2.shown && !o2.above && o2.heading === 'Ship' && o2.anon === 'Use lattice anonymously', JSON.stringify(o2));

// ── one settings surface: the tabs ────────────────────────────────────
//  This computer's tabs are this page's panels; the Lattice tabs are the
//  ship page's Settings, offered once a ship is configured, and go there
//  through go_home with the tab named.
const tabsOf = (p) => p.evaluate(() => ({
  shown: [...document.querySelectorAll('.st-panel')].filter((x) => !x.hidden).map((x) => x.id),
  current: document.querySelector('.st-tab[aria-current]')?.getAttribute('href'),
  shipTabs: !document.getElementById('ship-tabs').hidden,
  styled: !!document.getElementById('st-css'),
}));
const t1 = await tabsOf(shipped);
check('tabs: the shared look is loaded and one panel shows, Connection first',
  t1.styled && JSON.stringify(t1.shown) === '["connection"]' && t1.current === '#connection', JSON.stringify(t1));
check('tabs: with a ship the Lattice tabs are offered', t1.shipTabs, JSON.stringify(t1));
const t2 = await shipped.evaluate(async () => {
  document.querySelector('.st-tab[href="#files"]').click();
  const files = [...document.querySelectorAll('.st-panel')].filter((x) => !x.hidden).map((x) => x.id);
  const n = window.__ARGS__.length;
  document.querySelector('.st-tab[data-go="keys"]').click();
  await new Promise((r) => setTimeout(r, 50));
  return { files, hash: location.hash, go: window.__ARGS__.slice(n) };
});
check('tabs: Files shows the mounts panel alone and keeps it in the address',
  JSON.stringify(t2.files) === '["files"]' && t2.hash === '#files', JSON.stringify(t2));
check('tabs: a Lattice tab calls go_home with that tab',
  JSON.stringify(t2.go) === '[["go_home",{"settings":"keys"}]]', JSON.stringify(t2.go));
await shipped.close();

const nonode = await load({ connected: false, ship: null, url: '', error: null });
check('tabs: with no node the Lattice tabs are not offered', !(await tabsOf(nonode)).shipTabs);
await nonode.close();

//  the Preferences menu's "scheduled backups" lands on its tab
const atBk = await load({ connected: true, ship: '~x', url: 'https://s.example.com' }, { hash: '#backups' });
const t3 = await tabsOf(atBk);
check('#backups opens the backups tab', JSON.stringify(t3.shown) === '["backups"]' && t3.current === '#backups',
  JSON.stringify(t3));
await atBk.close();

//  a malformed hash names nothing: the first tab still shows
const badHash = await load({ connected: true, ship: '~x', url: 'https://s.example.com' }, { hash: '#%E0%A4%A' });
const t4 = await tabsOf(badHash);
check('a malformed hash still opens the Connection tab',
  JSON.stringify(t4.shown) === '["connection"]' && t4.current === '#connection', JSON.stringify(t4));
await badHash.close();

//  the theme the ship page reported is worn here, and kept for next time
const themed = await load({ connected: true, ship: '~x', url: 'https://s.example.com' },
  { theme: { 'color-scheme': 'dark', '--bg': '#102030', '--accent': '#ff8800' } });
await new Promise((r) => setTimeout(r, 200));
const th = await themed.evaluate(() => ({
  bg: getComputedStyle(document.body).backgroundColor,
  accent: getComputedStyle(document.querySelector('.st-tab[aria-current]')).color,
  kept: localStorage.latThemeVars,
  told: (window.__ARGS__.filter(([n]) => n === 'set_theme').pop() || [])[1],
}));
check('theme: the ship page\'s colours are worn', th.bg === 'rgb(16, 32, 48)' && th.accent === 'rgb(255, 136, 0)',
  JSON.stringify(th));
check('theme: kept in this page\'s own storage', /#102030/.test(th.kept || ''), th.kept);
check('theme: the window is told it is dark, and no variables are sent back',
  !!th.told && th.told.dark === true && !('vars' in th.told), JSON.stringify(th.told));
await themed.close();

const nofeature = await load({ connected: false, ship: null, url: '', error: null }, { noReader: true });
check('a build without the engine hides the card',
  await nofeature.evaluate(() => document.getElementById('reader').hidden));
await nofeature.close();

await browser.close();
console.log(check.fails ? '\n' + check.fails + ' FAILED' : '\nall checks passed');
process.exit(check.fails ? 1 : 0);
