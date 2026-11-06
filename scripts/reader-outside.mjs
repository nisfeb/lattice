// reader-outside.mjs: the shipless reader's publisher frame, in a real
// browser, loads nothing from another host until the reader asks.
//
// Driven by desktop's reader test `a_browser_loads_no_outside_content_until_asked`
// (cargo test -- --ignored), which serves the reader and an "outside"
// host that counts what reaches it. The page in the frame tries a fetch,
// an img, a CSS @import and a WebSocket to that host, and navigates its
// own frame there. Before the toggle none may arrive and the note must
// show; after it, the four loads arrive and the navigation still never
// does (the reader page's frame-src).
//
// Usage:  node scripts/reader-outside.mjs <boot-url> <outside-base>
// Env:    CHROME  browser binary (default /usr/bin/chromium)
import puppeteer from 'puppeteer-core';

const [boot, outside] = process.argv.slice(2);
if (!boot || !outside) {
  console.error('usage: reader-outside.mjs <boot-url> <outside-base>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = async () => (await (await fetch(`${outside}/__hits`)).text()).split('\n').filter(Boolean).sort();
const fail = (m) => { console.error(`FAIL ${m}`); process.exitCode = 1; };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium',
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check'],
});
try {
  const page = await browser.newPage();
  await page.goto(boot, { waitUntil: 'load' });
  const note = await page.waitForSelector('form.outside:not([hidden])', { timeout: 10000 }).catch(() => null);
  if (!note) fail('the note never showed');
  await sleep(1500);
  const before = await hits();
  if (before.length) fail(`outside loads before the toggle: ${before.join(' ')}`);
  else console.log('ok: nothing reached the outside host, and the note showed');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('form.outside button')]);
  await sleep(2000);
  const after = await hits();
  const want = ['/fetch', '/import.css', '/img.png', '/socket'];
  const missing = want.filter((w) => !after.includes(w));
  if (after.includes('/nav')) fail('the frame navigated itself to the outside host');
  if (missing.length) fail(`after the toggle, missing: ${missing.join(' ')} (got ${after.join(' ')})`);
  else console.log(`ok: after the toggle, ${after.join(' ')}`);
  if (await page.$('form.outside:not([hidden])')) fail('the note still shows after the toggle');
} finally {
  await browser.close();
}
