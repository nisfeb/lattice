#!/usr/bin/env node
// Checks for the typography preferences and the access-control pane.
//
// Usage:  node scripts/ui-acl-prefs.mjs
// Env:    LATTICE_URL, LATTICE_COOKIE, CHROME   (as ui-matrix.mjs)
// Needs puppeteer-core:  npm i --no-save puppeteer-core
// Never run against production. It creates and deletes a probe usergroup.

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

  // With no page open there is nothing to grant ON, so the panel must say so
  // rather than offer toggles that would have no target. (That the list shows
  // the group once a page IS open is asserted by the per-file test below.)
  step = 'share panel with no page open';
  await page.evaluate(() => document.getElementById('aclclose').click());
  const idle = await page.evaluate(() =>
    document.getElementById('grouplist').textContent);
  check('share panel asks for a page before offering group toggles',
    /open a page/.test(idle), JSON.stringify(idle).slice(0, 60));

  // ── per-file group access: grant read on the open page, via the group ────
  step = 'per-file group grant';
  await page.evaluate(async (n, b) => fetch('/apps/lattice/page-save?name=' +
    encodeURIComponent(n) + '&type=md&new=1', { method: 'POST', body: b }),
    GROUP + '/target', '# grant probe');
  await sleep(5000);
  await page.goto(APP + '?name=' + encodeURIComponent(GROUP + '/target'),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction((g) =>
    document.getElementById('grouplist').textContent.includes(g),
    { timeout: 90000 }, GROUP);
  // click that group's "read" toggle
  await page.evaluate((g) => {
    const row = [...document.querySelectorAll('#grouplist .grow-row')]
      .find((r) => r.querySelector('.gname').textContent === g);
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'read').click();
  }, GROUP);
  await sleep(6000);
  const granted = await page.evaluate(async (g, path) => {
    const gs = await (await fetch('/apps/lattice/share-groups')).json();
    const me = gs.find((x) => x.name === g);
    return !!me && me.peek.includes(path);
  }, GROUP, '/apps/lattice.lattice_app/page/' + GROUP + '/target');
  check('per-file group grant reaches the ship as a read rule', granted);
  const lit = await page.evaluate((g) => {
    const row = [...document.querySelectorAll('#grouplist .grow-row')]
      .find((r) => r.querySelector('.gname').textContent === g);
    return [...row.querySelectorAll('button')].find((b) => b.textContent === 'read').className;
  }, GROUP);
  check('and the toggle reads back as on', /on/.test(lit), lit);
  // ── short paths: grants show a tail, not the whole ball path ────────────
  step = 'short paths';
  await page.evaluate(() => document.getElementById('aclt').click());
  await page.waitForFunction(() => !document.getElementById('aclwrap').hidden, { timeout: 30000 });
  const fullPath = '/apps/lattice.lattice_app/page/' + GROUP + '/target';
  const chip = await page.evaluate((full) => {
    const a = [...document.querySelectorAll('#aclgrid .chips a')]
      .find((x) => x.title === 'remove ' + full);
    return a ? a.textContent : null;
  }, fullPath);
  // leftovers from a crashed run can force disambiguation ('…/x/target'), so
  // assert SHORTENED + right tail rather than one exact string
  check('acl: grant paths are shortened to an unambiguous tail',
    !!chip && !chip.includes('lattice_app') && /target ×$/.test(chip),
    JSON.stringify(chip));
  await page.evaluate(() => document.getElementById('aclclose').click());

  // ── pane resize: drag a boundary, persist, double-click reset ───────────
  step = 'pane resize';
  const ph1 = await page.$('#ph1');
  check('pane handle present', !!ph1);
  let hb = await ph1.boundingBox();
  await page.mouse.move(hb.x + 4, hb.y + 200);
  await page.mouse.down();
  await page.mouse.move(360, hb.y + 200, { steps: 4 });
  await page.mouse.up();
  const rz = await page.evaluate(() => ({
    tw: Math.round(document.querySelector('.tree').getBoundingClientRect().width),
    ls: (() => { try { return JSON.parse(localStorage.appPanes || '{}').tree || 0; } catch { return 0; } })(),
  }));
  check('dragging the tree boundary resizes the pane', rz.tw > 300, JSON.stringify(rz));
  check('the dragged width persists', rz.ls > 300, JSON.stringify(rz));
  hb = await ph1.boundingBox();
  await page.mouse.click(hb.x + 4, hb.y + 200);
  await page.mouse.click(hb.x + 4, hb.y + 200);
  const rz2 = await page.evaluate(() =>
    (() => { try { return JSON.parse(localStorage.appPanes || '{}').tree || 0; } catch { return -1; } })());
  check('double-click resets the boundary', rz2 === 0, String(rz2));

  // ── banlist: deny, which a weir cannot express ──────────────────────────
  // Banning must REVOKE, not just record. Membership in a group is access, so
  // a ban that left the ship in its groups would be a label rather than a ban.
  step = 'banlist';
  const BANNED = '~zod';
  const api = (p, o) => page.evaluate(async (p, o) => {
    const r = await fetch('/apps/lattice' + p, o || { method: 'POST' });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }, p, o);
  await api('/share-group-save?name=' + GROUP + '-ban', {
    method: 'POST',
    body: JSON.stringify({ ships: [BANNED, '~bus'], peek: [], make: [] }),
  });
  await sleep(4000);
  const banRes = await api('/ban?ship=' + encodeURIComponent(BANNED));
  check('ban: reports how many groups it revoked from',
    banRes.status === 200 && banRes.body && banRes.body.revoked >= 1, JSON.stringify(banRes));
  await sleep(4000);
  const groups = await api('/share-groups', { method: 'GET' });
  const g = (groups.body || []).find((x) => x.name === GROUP + '-ban');
  check('ban: revokes the banned ship from its groups',
    !!g && !g.ships.includes(BANNED), JSON.stringify(g && g.ships));
  check('ban: leaves other members alone', !!g && g.ships.includes('~bus'),
    JSON.stringify(g && g.ships));
  const shareBanned = await api('/share-file?name=' + encodeURIComponent(GROUP + '/target') +
    '&ship=' + encodeURIComponent(BANNED) + '&mode=read');
  check('ban: per-ship share to a banned ship is refused', shareBanned.status === 403,
    JSON.stringify(shareBanned));
  const saveBanned = await api('/share-group-save?name=' + GROUP + '-ban', {
    method: 'POST', body: JSON.stringify({ ships: [BANNED], peek: [], make: [] }),
  });
  check('ban: a group naming a banned ship is refused', saveBanned.status === 403,
    JSON.stringify(saveBanned));
  await api('/unban?ship=' + encodeURIComponent(BANNED));
  await sleep(3000);
  const after = await api('/banlist', { method: 'GET' });
  check('unban: clears the list', Array.isArray(after.body) && !after.body.includes(BANNED),
    JSON.stringify(after.body));
  const g2 = ((await api('/share-groups', { method: 'GET' })).body || [])
    .find((x) => x.name === GROUP + '-ban');
  check('unban: does NOT silently restore the revoked grant',
    !!g2 && !g2.ships.includes(BANNED), JSON.stringify(g2 && g2.ships));
} catch (e) {
  check('step "' + step + '" threw: ' + String(e.message).slice(0, 140), false);
} finally {
  try {
    await page.evaluate(async (g) => {
      await fetch('/apps/lattice/unban?ship=' + encodeURIComponent('~zod'), { method: 'POST' });
      await fetch('/apps/lattice/share-group-del?name=' + encodeURIComponent(g + '-ban'), { method: 'POST' });
      await fetch('/apps/lattice/share-group-del?name=' + encodeURIComponent(g), { method: 'POST' });
      await fetch('/apps/lattice/page-del?name=' + encodeURIComponent(g + '/target'), { method: 'POST' });
      localStorage.removeItem('latFont'); localStorage.removeItem('latFontSize');
      localStorage.removeItem('appPanes');
    }, GROUP);
  } catch {}
  await browser.close();
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
