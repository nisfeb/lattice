#!/usr/bin/env node
// Checks for the typography preferences and the access-control pane.
//
// Usage:  node scripts/ui-acl-prefs.mjs
// Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
// Needs puppeteer-core:  npm i --no-save puppeteer-core
// Never run against production — it creates and deletes a probe usergroup.

import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const COOKIE_FILE = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const APP = URL + '/apps/lattice/app';
const SETTINGS = URL + '/apps/lattice/settings';
const GROUP = 'uiprobe' + (process.pid % 100000);

const cookie = readFileSync(COOKIE_FILE, 'utf8').trim();
const [ckName, ...ckRest] = cookie.split('=');
const host = new globalThis.URL(URL).hostname;

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  ok   - ' + name);
  else { console.log('  FAIL - ' + name + (detail ? ' (' + detail + ')' : '')); fails++; }
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', (e) => check('page threw: ' + e.message.slice(0, 90), false));
await page.setCookie({ name: ckName, value: ckRest.join('='), domain: host, path: '/' });
const wait = (fn, ...args) => page.waitForFunction(fn, { timeout: 90000 }, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 'settings';
try {
  // desktop viewport: below 820px the shell applies its mobile floor of 16px
  // to the editor (iOS zooms a smaller textarea font), which is correct but
  // masks the configured size.
  await page.setViewport({ width: 1400, height: 900 });
  // ── 1. settings page: the controls exist and persist ─────────────────────
  await page.goto(SETTINGS, { waitUntil: 'domcontentloaded', timeout: 60000 });
  check('settings: font selector present', await page.$('#fontsel') !== null);
  check('settings: size control present', await page.$('#fontsize') !== null);

  await page.select('#fontsel', 'serif');
  await page.evaluate(() => {
    const s = document.getElementById('fontsize');
    s.value = '21'; s.dispatchEvent(new Event('input'));
  });
  const stored = await page.evaluate(() => [localStorage.latFont, localStorage.latFontSize]);
  check('settings: choice persists to localStorage', stored[0] === 'serif' && stored[1] === '21',
    JSON.stringify(stored));
  const sample = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById('fontsample'));
    return [c.fontFamily, c.fontSize];
  });
  check('settings: live sample reflects the choice',
    /Georgia/i.test(sample[0]) && sample[1] === '21px', JSON.stringify(sample));

  // ── 2. the editor honours it, and the two layers stay in lockstep ────────
  step = 'editor typography';
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !!document.getElementById('src'));
  const ed = await page.evaluate(() => {
    const a = getComputedStyle(document.getElementById('src'));
    const b = getComputedStyle(document.getElementById('hl'));
    return { af: a.fontFamily, as: a.fontSize, bf: b.fontFamily, bs: b.fontSize };
  });
  check('editor: applies the chosen family', /Georgia/i.test(ed.af), ed.af);
  check('editor: applies the chosen size', ed.as === '21px', ed.as);
  // THE invariant: textarea and highlight overlay must have identical metrics
  // or the caret drifts off its line on wrapped text.
  check('editor: #src and #hl fonts are identical (caret alignment)',
    ed.af === ed.bf && ed.as === ed.bs, JSON.stringify(ed));

  // reset must fall back to the default, not write undefined into CSS
  step = 'typography reset';
  await page.goto(SETTINGS, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.click('#fontreset');
  const cleared = await page.evaluate(() =>
    [localStorage.latFont === undefined, localStorage.latFontSize === undefined]);
  check('settings: reset clears the stored preference', cleared[0] && cleared[1]);
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(() => !!document.getElementById('src'));
  const back = await page.evaluate(() => {
    const a = getComputedStyle(document.getElementById('src'));
    const b = getComputedStyle(document.getElementById('hl'));
    return { af: a.fontFamily, as: a.fontSize, bf: b.fontFamily, bs: b.fontSize };
  });
  check('editor: falls back to the monospace default after reset',
    /mono/i.test(back.af) && back.as === '13px', JSON.stringify(back));
  check('editor: layers still identical after reset',
    back.af === back.bf && back.as === back.bs, JSON.stringify(back));

  // ── 3. the access-control pane ───────────────────────────────────────────
  step = 'acl pane';
  check('acl: bar button present', await page.$('#aclt') !== null);
  check('acl: pane starts hidden', await page.evaluate(() => document.getElementById('aclwrap').hidden));
  await page.click('#aclt');
  check('acl: opens', await page.evaluate(() => !document.getElementById('aclwrap').hidden));
  await wait(() => document.querySelectorAll('#aclgrid .aclcard').length > 0
    || /No groups yet/.test(document.getElementById('aclgrid').textContent));

  step = 'acl create';
  await page.evaluate((g) => { document.getElementById('aclnew').value = g; }, GROUP);
  await page.click('#aclnewbtn');
  await wait((g) => [...document.querySelectorAll('#aclcard, #aclgrid .aclcard header b')]
    .some((b) => b.textContent === g), GROUP);
  check('acl: creates a group', true);

  step = 'acl add ship';
  await page.evaluate((g) => {
    const card = [...document.querySelectorAll('#aclgrid .aclcard')]
      .find((c) => c.querySelector('header b').textContent === g);
    const inp = card.querySelector('input[placeholder="~ship"]');
    inp.value = '~zod';
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'add ship').click();
  }, GROUP);
  await wait((g) => {
    const card = [...document.querySelectorAll('#aclgrid .aclcard')]
      .find((c) => c.querySelector('header b').textContent === g);
    return card && /~zod/.test(card.textContent);
  }, GROUP);
  check('acl: adds a ship and it round-trips through the ship', true);

  // the narrow editor panel reads the same permGroups — it must agree
  step = 'acl consistency';
  const inNarrow = await page.evaluate((g) =>
    document.getElementById('permlist').textContent.includes(g), GROUP);
  check('acl: narrow peers panel shows the same group', inNarrow);
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 140), false);
} finally {
  try {
    await page.evaluate(async (g) => {
      await fetch('/apps/lattice/share-group-del?name=' + encodeURIComponent(g), { method: 'POST' });
      localStorage.removeItem('latFont'); localStorage.removeItem('latFontSize');
    }, GROUP);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
