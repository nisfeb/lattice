#!/usr/bin/env node
//  ui-orrery-facts.mjs: the reader's live orrery facts block. On a ship with
//  no orrery (or a two-segment path that is not a body) no block appears and
//  nothing is logged to the console. On a ship with orrery, set BODY to a
//  real body id (person/<slug>) to assert the block carries its name.
//
//  Env:    LATTICE_URL, LATTICE_COOKIE, CHROME, BODY (optional), BODY_NAME
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, shipName, seed } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const SHIP = await shipName(env);
await seed(env, [['person/zzztest', '# not a body'], ['journal/2026.10.19', '# a day']], { share: 'shared' });
const browser = await launchBrowser();
const p = await openPage(browser, env);
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text() + ' ' + (m.location().url || '')); });
p.on('pageerror', (e) => errs.push(String(e)));
const open = async (path) => {
  await p.goto(env.base + '/apps/lattice?url=' + encodeURIComponent('urb://' + SHIP + '/' + path), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  return p.evaluate(() => document.getElementById('orfacts')?.textContent || null);
};
for (const path of ['person/zzztest', 'journal/2026.10.19']) {
  check(path + ' shows no facts block', (await open(path)) === null);
}
if (process.env.BODY) {
  const t = await open(process.env.BODY);
  check('body page shows its name', !!t && t.includes(process.env.BODY_NAME || ''), String(t));
}
// the browser itself logs a 404 for the one-per-session /api/version probe
// (existing behaviour) and for settings scries; those are not this block's
const mine = errs.filter((e) => /orrery\/api\/body|TypeError|ReferenceError/.test(e));
check('no console error from the facts block', mine.length === 0, mine.join(' | '));
await browser.close();
check.done?.();
