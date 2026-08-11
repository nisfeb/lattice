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

async function load(status, opts = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  await page.evaluateOnNewDocument((s, o) => {
    window.__CALLS__ = [];
    window.__TAURI__ = {
      core: { invoke: (name) => { window.__CALLS__.push(name);
        if (name === 'connection_status') {
          // statusDelayMs mimics the real thing: a round-trip to the ship
          return new Promise((res) => setTimeout(() => res(s), o.statusDelayMs || 0));
        }
        if (name === 'go_home' && o.rejectGoHome) return Promise.reject('connect to a ship first');
        return Promise.resolve(null); } },
      event: { listen: () => Promise.resolve(() => {}) },
    };
  }, status, opts);
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

await browser.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
