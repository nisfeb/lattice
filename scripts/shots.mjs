// Rendered-verification shots: dark + light desktop, dark mobile.
import { readFileSync } from 'fs';
import { homedir } from 'os';
const puppeteer = (await import('puppeteer-core')).default;

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const APP = URL + '/apps/lattice/app';
const cookie = readFileSync(homedir() + '/.config/lattice-fs/cookie', 'utf8').trim();
const [ckName, ...ckRest] = cookie.split('=');
const host = new globalThis.URL(URL).hostname;
const out = process.env.SHOT_DIR || '/tmp';

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium',
  headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setCookie({ name: ckName, value: ckRest.join('='), domain: host, path: '/' });
page.on('pageerror', (e) => { console.error('PAGE ERROR: ' + e.message); process.exitCode = 1; });

const wait = (fn) => page.waitForFunction(fn, { timeout: 60000 });
const shots = [
  ['desktop-dark',  { width: 1400, height: 900 }, 'dark'  ],
  ['desktop-light', { width: 1400, height: 900 }, 'light' ],
  ['mobile-dark',   { width: 400,  height: 850 }, 'dark'  ],
];
for (const [name, vp, scheme] of shots) {
  await page.setViewport(vp);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto(APP, { waitUntil: 'networkidle2', timeout: 60000 });
  await wait(() => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot: ${name}.png`);
}
// knowledge mode, dark desktop
await page.setViewport({ width: 1400, height: 900 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
await page.goto(APP + '?view=know', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/know-dark.png` });
console.log('shot: know-dark.png');
await browser.close();
