#!/usr/bin/env node
//  ui-createdialog.mjs — the desktop new-page dialog.
//
//  Four properties, each of which failed silently before:
//
//    the kind is pickable here, because the bar that carries that control is
//      hidden on desktop, so every file arrived as md
//    the caret sits after the seed, because selecting it meant the first
//      keystroke threw away the folder the + button had just filled in
//    the row appears immediately, because a pier round trip with an unchanged
//      tree reads as nothing having happened
//    the row pulses until the write lands, and is REMOVED if it fails, so a
//      page that does not exist is never left sitting in the tree
//
//  __TAURI__ is stubbed to reach the desktop path, as ui-deskmenu does.
//
//  Usage: LATTICE_UI=http://localhost:8081 node scripts/ui-createdialog.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const BASE = (process.env.LATTICE_UI || 'http://localhost:8080').replace(/\/$/, '');
const CKF = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/nec-cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const RUN = 'createdlg-' + process.pid;

let fails = 0;
const check = (n, ok, extra) => {
  console.log((ok ? '  ok   - ' : '  FAIL - ') + n + (ok ? '' : '\n         ' + (extra || '')));
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookie = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = cookie.split('=');
const browser = await puppeteer.launch({
  executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 700, height: 900 });   // <=820px: the dialog path
await page.setCookie({ name: cn, value: cr.join('='), domain: new URL(BASE).hostname, path: '/' });
await page.evaluateOnNewDocument(() => {
  window.__TAURI__ = { core: { invoke: async () => null } };
});

const made = [];
try {
  await page.goto(BASE + '/apps/lattice/app', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(2500);

  const folder = await page.evaluate(() => {
    const a = document.querySelector('#treelist .addf');
    if (!a) return null;
    a.click();
    return a.title.replace('new file in ', '');
  });
  await sleep(900);
  check('the folder + opens the dialog', !!folder, 'no .addf row found');

  // ── the kind picker is present and usable ──────────────────────────────
  const dlg = await page.evaluate(() => {
    const k = document.getElementById('dlgkind');
    return {
      kindShown: !!k && !k.hidden,
      kinds: k ? [...k.options].map((o) => o.value) : [],
      seed: document.getElementById('dlginput').value,
    };
  });
  check('the dialog offers a kind picker', dlg.kindShown, JSON.stringify(dlg));
  check('it offers the same kinds as the bar',
    dlg.kinds.includes('md') && dlg.kinds.includes('tex') && dlg.kinds.includes('hoon'),
    JSON.stringify(dlg.kinds));

  // ── the caret sits after the seed, with nothing selected ───────────────
  const caret = await page.evaluate(() => {
    const i = document.getElementById('dlginput');
    return { start: i.selectionStart, end: i.selectionEnd, len: i.value.length };
  });
  check('the caret is at the end of the seed',
    caret.start === caret.len && caret.end === caret.len, JSON.stringify(caret));
  check('the seed is NOT selected', caret.start === caret.end, JSON.stringify(caret));

  // ── create as a non-default kind, and watch the row appear pending ─────
  const name = folder + '/' + RUN;
  made.push(name);
  await page.evaluate((n) => {
    const i = document.getElementById('dlginput');
    i.value = n; i.dispatchEvent(new Event('input'));
    const k = document.getElementById('dlgkind');
    k.value = 'tex'; k.dispatchEvent(new Event('change'));
  }, name);
  await page.evaluate(() => document.getElementById('dlgok').click());

  //  the row must exist BEFORE the write returns. Poll briefly rather than
  //  sleeping a fixed amount, so this measures "immediately" not "eventually".
  let sawPending = false;
  for (let i = 0; i < 40; i++) {
    sawPending = await page.evaluate((n) =>
      [...document.querySelectorAll('#treelist a.pg.pend')]
        .some((a) => a.href.includes(encodeURIComponent(n))), name);
    if (sawPending) break;
    await sleep(50);
  }
  check('the row appears pending before the ship answers', sawPending,
    'no pulsing row for ' + name);

  await sleep(6000);
  const after = await page.evaluate((n) => {
    const rows = [...document.querySelectorAll('#treelist a.pg')]
      .filter((a) => a.href.includes(encodeURIComponent(n)));
    return {
      present: rows.length > 0,
      stillPending: rows.some((r) => r.classList.contains('pend')),
      label: rows[0] ? rows[0].textContent : '',
      kind: document.getElementById('pkind').value,
    };
  }, name);
  check('the row stays once the write lands', after.present, JSON.stringify(after));
  check('and stops pulsing', !after.stillPending, JSON.stringify(after));
  check('the picked kind is what got saved', after.kind === 'tex', JSON.stringify(after));
  check('the row is labelled with that kind', /\.tex$/.test(after.label),
    JSON.stringify(after.label));

  // ── a write that fails must not leave a row behind ─────────────────────
  await page.evaluate(() => {
    window.__realFetch = window.fetch;
    window.fetch = (u, o) => (String(u).includes('page-save')
      ? Promise.resolve(new Response('nope', { status: 500 }))
      : window.__realFetch(u, o));
  });
  const doomed = folder + '/' + RUN + '-doomed';
  await page.evaluate(() => { const a = document.querySelector('#treelist .addf'); a.click(); });
  await sleep(900);
  await page.evaluate((n) => {
    const i = document.getElementById('dlginput');
    i.value = n; i.dispatchEvent(new Event('input'));
    document.getElementById('dlgok').click();
  }, doomed);
  await sleep(6000);
  const ghost = await page.evaluate((n) =>
    [...document.querySelectorAll('#treelist a.pg')]
      .some((a) => a.href.includes(encodeURIComponent(n))), doomed);
  check('a failed write leaves no row behind', !ghost,
    'a row for ' + doomed + ' survived a 500');
  await page.evaluate(() => { window.fetch = window.__realFetch; });
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  for (const n of made) {
    await page.evaluate((x) => fetch('/apps/lattice/page-del?name=' + encodeURIComponent(x),
      { method: 'POST', credentials: 'same-origin' }).catch(() => {}), n).catch(() => {});
  }
  await browser.close();
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
