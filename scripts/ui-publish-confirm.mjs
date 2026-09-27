#!/usr/bin/env node
// Publishing asks first. Once a peer has read a page, deletion is not
// assured, so private -> shared/clearweb opens a dialog with abort and
// publish, and a "don't ask again" box that only a publish remembers.
//
// Usage:  node scripts/ui-publish-confirm.mjs
// Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
// Never run against production: it publishes a throwaway page.

import { shipEnv, launchBrowser, openPage, makeCheck, sleep } from './lib/harness.mjs';

const env = shipEnv();
const APP = env.app;
const PAGE = 'pubconfirm' + (process.pid % 100000);

const check = makeCheck();
const browser = await launchBrowser();
const page = await openPage(browser, env, {
  onPageError: (e) => check('page threw: ' + e.message.slice(0, 90), false),
});
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const mode = () => page.evaluate(() =>
  (document.querySelector('.share button.on') || {}).dataset?.m);
const dlgOpen = () => page.evaluate(() => !document.getElementById('dlg').hidden);
//  DOM clicks: the share panel may be collapsed, and the handler is what is
//  under test, not the layout
const click = (m) => page.evaluate((m) =>
  document.querySelector(`.share button[data-m="${m}"]`).click(), m);
const tap = (id) => page.evaluate((id) => document.getElementById(id).click(), id);

let step = 'setup';
try {
  await page.goto(APP + '/no-such-asset', { timeout: 30000 });
  await page.evaluate(() => { localStorage.clear(); });
  await page.evaluate((n) => fetch('/apps/lattice/page-save?name=' + encodeURIComponent(n) +
    '&type=md&new=1', { method: 'POST', body: '# publish probe' }), PAGE);
  await sleep(4000);
  await page.goto(APP + '?name=' + encodeURIComponent(PAGE),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => document.querySelector('.share button.on'));
  check('starts private', (await mode()) === 'private');

  step = 'abort';
  await click('shared');
  await wait(() => !document.getElementById('dlg').hidden);
  const d = await page.evaluate(() => ({
    msg: document.getElementById('dlgmsg').textContent,
    no: document.getElementById('dlgcancel').textContent,
    ok: document.getElementById('dlgok').textContent,
    box: !document.getElementById('dlgchkrow').hidden,
  }));
  check('dialog warns deletion is not assured', /deletion is not assured/.test(d.msg));
  check('buttons are abort and publish', d.no === 'abort' && d.ok === 'publish');
  check('dialog offers "don\'t ask again"', d.box);
  await tap('dlgchk');          // ticked, then aborted: must not stick
  await tap('dlgcancel');
  await sleep(1500);
  check('abort leaves the page private', (await mode()) === 'private');

  step = 'publish';
  await click('shared');
  await wait(() => !document.getElementById('dlg').hidden);
  check('an aborted tick is not remembered', !(await page.evaluate(() =>
    document.getElementById('dlgchk').checked)));
  await tap('dlgchk');
  await tap('dlgok');
  await wait(() => document.querySelector('.share button.on')?.dataset.m === 'shared');
  check.ok('publish shares the page');

  step = 'public to public';
  await click('clearweb');
  await sleep(300);
  check('shared -> clearweb does not ask', !(await dlgOpen()));
  await wait(() => document.querySelector('.share button.on')?.dataset.m === 'clearweb');

  step = 'remembered';
  await click('private');
  await wait(() => document.querySelector('.share button.on')?.dataset.m === 'private');
  await click('shared');
  await sleep(300);
  check('"don\'t ask again" skips the dialog', !(await dlgOpen()));
  await wait(() => document.querySelector('.share button.on')?.dataset.m === 'shared');
} catch (e) {
  check('step ' + step + ': ' + e.message.slice(0, 120), false);
} finally {
  await page.evaluate(async (n) => {
    await fetch('/apps/lattice/page-share?name=' + encodeURIComponent(n) + '&mode=private',
      { method: 'POST' });
    await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(n), { method: 'POST' });
  }, PAGE).catch(() => {});
  await browser.close();
}
console.log(check.fails ? '\n' + check.fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(check.fails ? 1 : 0);
