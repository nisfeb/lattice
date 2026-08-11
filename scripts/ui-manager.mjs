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
//  exit, and because the button must NOT appear in the states with no ship UI
//  behind it — closing to a page that cannot load is its own dead end.
//
//  No ship and no app needed: the page is loaded from file:// with a stubbed
//  Tauri backend, so this runs anywhere.
//
//  Usage:  node scripts/ui-manager.mjs
//  Setup:  npm i --no-save puppeteer-core
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = new globalThis.URL('..', import.meta.url).pathname;
const P = ROOT + 'desktop/ui/manager.html';
let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: 'new', args: ['--no-sandbox'],
});

const dir = mkdtempSync(join(tmpdir(), 'mgr-'));
const src = readFileSync(P, 'utf8');

async function load(status) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.evaluateOnNewDocument((s) => {
    window.__CALLS__ = [];
    window.__TAURI__ = {
      core: { invoke: (name) => { window.__CALLS__.push(name);
        return Promise.resolve(name === 'connection_status' ? s : null); } },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  }, status);
  const f = join(dir, 'm.html');
  writeFileSync(f, src);
  await page.goto('file://' + f, { waitUntil: 'domcontentloaded' });
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
const clicked = await on.evaluate(() => { const n = window.__CALLS__.length;
  document.getElementById('close').click(); return window.__CALLS__.slice(n); });
check('clicking it calls go_home', JSON.stringify(clicked) === '["go_home"]', JSON.stringify(clicked));
const esc = await on.evaluate(() => { const n = window.__CALLS__.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return window.__CALLS__.slice(n); });
check('Escape closes too', JSON.stringify(esc) === '["go_home"]', JSON.stringify(esc));
await on.close();

// never configured: nothing to go back to, so no close and Escape is inert
const off = await load({ connected: false, ship: null, url: '', error: null });
const st2 = await off.evaluate(() => {
  const n = window.__CALLS__.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  return { hidden: document.getElementById('close').hidden, after: window.__CALLS__.slice(n) };
});
check('never configured: close is hidden', st2.hidden === true);
check('never configured: Escape does not navigate to a UI that is not there',
  JSON.stringify(st2.after) === '[]', JSON.stringify(st2.after));
await off.close();

await browser.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
