//  ui-modeswitch.mjs — the pages/knowledge toggle paints from memory first.
//
//  Reported on ricsul (2026-09-16): toggling took multi-second. The heading
//  flipped at once, but the listing under it was the OTHER mode's until the
//  round trip (know-list or page-dump) returned. Both listings were already
//  in memory; setMode just never painted them. Now it paints what it has
//  and lets the fetch correct it, so the listing changes with the click.
//
//  Usage: node scripts/ui-modeswitch.mjs      (defaults to the harness on :8080)
import { shipEnv, launchBrowser, openPage, makeCheck } from './lib/harness.mjs';

const env = shipEnv();
//  generous against a remote pier: the round trip is seconds; a paint is not
const BUDGET = +(process.env.BUDGET || 250);

const check = makeCheck();
const browser = await launchBrowser();
const p = await openPage(browser, env, { viewport: { width: 1400, height: 800 } });
await p.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 9000));   // the SW takes over and reloads within seconds of a fresh load

const listing = () => p.evaluate(() => document.getElementById('treelist').textContent);
const pages = await listing();

// ms from the click until the listing is no longer what it was
const flip = async () => {
  const before = await listing();
  const t0 = Date.now();
  await p.evaluate(() => document.getElementById('modet').click());
  await p.waitForFunction((b) => document.getElementById('treelist').textContent !== b, { timeout: 30000 }, before);
  return Date.now() - t0;
};
// and settle: the fetch has landed once a memory row (or the empty note) shows
const settled = () => p.waitForFunction(() => /no memories yet|loading/.test(document.getElementById('treelist').textContent) === false
  && document.querySelector('#treelist a.pg, #treelist .fld'), { timeout: 30000 });

// first visit: nothing cached, so the honest paint is a placeholder, never
// the pages listing wearing the "memories" heading
let t = await flip();
check('pages -> know, first visit: the pages listing leaves with the click', t <= BUDGET, t + 'ms');
check('...and what shows is not the pages listing', (await listing()) !== pages);
await settled();
const memories = await listing();

t = await flip();
check('know -> pages: the page tree is back with the click (it was in memory)', t <= BUDGET, t + 'ms');
check('...and it is the page tree', (await listing()) === pages);

t = await flip();
check('pages -> know, second visit: the memory listing is back with the click', t <= BUDGET, t + 'ms');
check('...and it is the memory listing', (await listing()) === memories);

await browser.close();
check.done();
