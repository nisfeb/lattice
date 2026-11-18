// Drives a page in headless Chromium with WebGPU, in a throwaway profile:
// the browser build is one canvas, so it is worked by where things are.
//   node scripts/web/drive.mjs URL STEPS.json
// Steps, in order: {"wait": ms} {"click": [x, y]} {"type": "text"} {"key": "Enter"}
// {"down": "Control"} {"up": "Control"} {"shot": "out.png"} {"storage": "name"}
// {"reload": true} {"goto": "url"} {"text": "css selector"} {"follow": "css selector of a link"} {"where": true}. What a step reads is printed as JSON lines.
// Needs puppeteer-core: PUPPETEER_MODULE names its folder when it is not beside this.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [,, url, stepsFile] = process.argv;
const mod = process.env.PUPPETEER_MODULE || 'puppeteer-core';
const loaded = await import(mod.startsWith('/') ? path.join(mod, 'lib/puppeteer/puppeteer-core.js') : mod);
const puppeteer = loaded.default || loaded;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-drive-'));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, userDataDir: profile,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--window-size=1100,700'],
  defaultViewport: { width: 1100, height: 700 },
});
let failed = false;
try {
  const page = await browser.newPage();
  const say = (o) => console.log(JSON.stringify(o));
  // NO_WEBGPU=1: the page is told there is no WebGPU, as an older browser would tell it
  if (process.env.NO_WEBGPU) await page.evaluateOnNewDocument(() => Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }));
  page.on('console', (m) => { const t = m.text(); if (!/Inter-|HTTP 404|Password field|favicon/.test(t)) say({ console: t.slice(0, 300) }); });
  page.on('pageerror', (e) => { failed = true; say({ pageerror: String(e).slice(0, 300) }); });
  page.on('request', (r) => { if (r.method() !== 'GET') say({ sent: r.method() + ' ' + new URL(r.url()).pathname + new URL(r.url()).search }); });
  // COOKIE_FILE holds a session cookie (name=value) to sign the browser in with, as a ship's login would
  if (process.env.COOKIE_FILE) {
    const [name, ...v] = fs.readFileSync(process.env.COOKIE_FILE, 'utf8').trim().split('=');
    await browser.setCookie({ name, value: v.join('='), domain: new URL(url).hostname, path: '/' });
  }
  for (const s of [{ goto: url }, ...JSON.parse(fs.readFileSync(stepsFile, 'utf8'))]) {
    if (s.goto) await page.goto(s.goto, { waitUntil: 'load' });
    if (s.reload) await page.reload({ waitUntil: 'load' });
    if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
    if (s.click) await page.mouse.click(s.click[0], s.click[1]);
    if (s.type) await page.keyboard.type(s.type, { delay: 20 });
    if (s.key) await page.keyboard.press(s.key);
    if (s.down) await page.keyboard.down(s.down);
    if (s.up) await page.keyboard.up(s.up);
    if (s.shot) await page.screenshot({ path: s.shot });
    if (s.storage) say({ storage: await page.evaluate((k) => localStorage.getItem(k), s.storage) });
    if (s.text) say({ text: await page.evaluate((q) => document.querySelector(q)?.textContent ?? null, s.text) });
    if (s.follow) await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(s.follow)]);
    if (s.where) say({ where: page.url() });
  }
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
