// Rendered-verification shots: dark + light desktop, dark mobile.
// Env: LATTICE_URL, LATTICE_COOKIE, CHROME (as ui-matrix.mjs), SHOT_DIR
import { shipEnv, launchBrowser, openPage } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const out = process.env.SHOT_DIR || '/tmp';

const browser = await launchBrowser();
const page = await openPage(browser, env, {
  onPageError: (e) => { console.error('PAGE ERROR: ' + e.message); process.exitCode = 1; },
});

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
