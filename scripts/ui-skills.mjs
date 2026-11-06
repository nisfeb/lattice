#!/usr/bin/env node
//  ui-skills.mjs: the Skills tool tab (ui-app/skills.js, opened from the
//  Knowledge toolbar by 95s-skills.js) drives the skills store end to end.
//
//    the tab opens and lazily loads skills.js; a skill made over HTTP is
//      listed with its description
//    New skill makes one through the dialog, and its first save lands
//    open, edit and save: the ship has the new text, the view shows it
//    Core: on tags core, Core: off untags it
//    Sensitive: on marks it sensitive on the ship
//    History lists the revisions, and an old one shows its own text
//    Delete moves it to the trash, and Trash > restore brings it back
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/ui-skills.mjs
import { shipEnv, launchBrowser, openPage, makeCheck, sleep, swControlled, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const A = 'ui-skills-a-' + process.pid;
const B = 'ui-skills-b-' + process.pid;
const browser = await launchBrowser();
const errors = [];
const page = await openPage(browser, env, { viewport: { width: 1400, height: 900 },
  onPageError: (e) => errors.push(String(e)) });

const H = { Cookie: env.cookie };
const api = (p) => env.base + '/apps/lattice/' + p;
const shipSkill = async (n) => {
  const r = await fetch(api('skill?name=' + encodeURIComponent(n)), { headers: H });
  return r.ok ? r.json() : { status: r.status };
};
const skillMd = (n, desc, body) => `---\nname: ${n}\ndescription: ${desc}\n---\n\n${body}\n`;
const click = (id) => page.evaluate((x) => { const b = document.getElementById(x); if (b) b.click(); return !!b; }, id);
const has = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const dlg = async (fill) => {
  await page.waitForFunction(() => !document.getElementById('dlg').hidden, { timeout: 30000 });
  await page.evaluate((v) => {
    if (v !== null) document.getElementById('dlginput').value = v;
    document.getElementById('dlgok').click();
  }, fill);
  await page.waitForFunction(() => document.getElementById('dlg').hidden, { timeout: 30000 });
};
//  the editor's skill in view is `n`, its fetch settled
const showing = (n) => waitFor(async () => (await text('#skname')) === n, 30000);
const edit = async (body) => {
  await click('skedit');
  await waitFor(() => has('#sktext'), 10000);
  await page.evaluate((v) => {
    const t = document.getElementById('sktext');
    t.value = v;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }, body);
  await click('sksave');
};

// the fixture, made over HTTP
{
  const r = await fetch(api('skill-save?name=' + A + '&path=SKILL.md'), { method: 'POST', headers: H,
    body: skillMd(A, 'Fixture skill for the browser suite', '# first body') });
  check('the fixture skill is made over HTTP', r.ok, String(r.status));
}

await page.goto(env.app, { waitUntil: 'domcontentloaded', timeout: 90000 });
await swControlled(page).catch(() => {});
await page.waitForFunction(() => !!document.getElementById('kskills') && !!window.latTabs, { timeout: 60000 });

// ── 1. the tab opens and lists ──────────────────────────────────────────
await click('kskills');
check('the Skills tab opens and skills.js loads',
  !!(await waitFor(() => page.evaluate(() => !!window.LatSkills && !!document.getElementById('sklist')), 30000)), '');
check('the tab is a tool tab in front', await page.evaluate(() => {
  const s = window.latTabs.state();
  return s.tabs[s.active] && s.tabs[s.active].kind === 'tool' && s.tabs[s.active].key === 'skills';
}), JSON.stringify(await page.evaluate(() => window.latTabs.state())));
check('the fixture is listed with its description',
  !!(await waitFor(async () => /Fixture skill for the browser suite/.test(
    (await text('#sklist [data-skill="' + A + '"]')) || ''), 30000)),
  await text('#sklist'));

// ── 2. New skill through the dialog ─────────────────────────────────────
await click('sknew');
await dlg(B);
check('New skill opens the new one, in edit', !!(await showing(B)) && !!(await waitFor(() => has('#sktext'), 15000)), '');
{
  const s = await shipSkill(B);
  check('the new skill is on the ship', s.name === B, JSON.stringify(s));
}
await edit(skillMd(B, 'Made in the browser suite', '# made here'));
check('its first edit saves',
  !!(await waitFor(async () => (await shipSkill(B)).description === 'Made in the browser suite', 30000)),
  JSON.stringify(await shipSkill(B)));
check('and it is listed', !!(await waitFor(() => has('#sklist [data-skill="' + B + '"]'), 15000)), '');

// ── 3. open, edit, save ─────────────────────────────────────────────────
await click('skrefresh');
await page.evaluate((n) => document.querySelector('#sklist [data-skill="' + n + '"]').click(), A);
check('a listed skill opens', !!(await showing(A)), await text('#skmain'));
check('its SKILL.md shows', /first body/.test((await text('#skview')) || ''), await text('#skview'));
const MARK = 'edited-' + Date.now();
await edit(skillMd(A, 'Fixture skill for the browser suite', '# ' + MARK));
check('the edit is on the ship',
  !!(await waitFor(async () => String((await shipSkill(A)).body || '').includes(MARK), 30000)),
  JSON.stringify(await shipSkill(A)));
check('and the view shows it', !!(await waitFor(async () => ((await text('#skview')) || '').includes(MARK), 15000)),
  await text('#skview'));

// ── 3b. an unsaved edit is guarded ──────────────────────────────────────
//  reload, window close and tab close used to drop it without a word
await click('skedit');
await waitFor(() => has('#sktext'), 10000);
await page.evaluate(() => {
  const t = document.getElementById('sktext');
  t.value += '\nunsaved line';
  t.dispatchEvent(new Event('input', { bubbles: true }));
});
check('an unsaved skill edit counts as unsaved work',
  await page.evaluate(() => window.__latUnsaved()), '');
check('and a reload or window close asks', await page.evaluate(() => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}), '');
await page.evaluate(() => document.querySelector('.dtw.on .dtx').click());
const skAsk = !!(await waitFor(() => page.evaluate(() => !document.getElementById('dlg').hidden), 5000));
await page.evaluate(() => document.getElementById('dlgcancel').click());
await sleep(500);
check('closing the Skills tab asks, and cancel keeps the edit', skAsk && await page.evaluate(() => {
  const s = window.latTabs.state();
  const t = document.getElementById('sktext');
  return s.tabs[s.active].key === 'skills' && !!t && t.value.includes('unsaved line');
}), String(skAsk));
await click('skcancel');
await dlg(null);   // discard
await sleep(300);
check('once cancelled, nothing is unsaved', !(await page.evaluate(() => window.__latUnsaved())), '');

// ── 4. core ─────────────────────────────────────────────────────────────
await click('skcore');
check('Core: on tags core',
  !!(await waitFor(async () => ((await shipSkill(A)).tags || []).includes('core'), 30000)),
  JSON.stringify((await shipSkill(A)).tags));
check('the button says so', !!(await waitFor(() => page.evaluate(() =>
  document.getElementById('skcore').getAttribute('aria-pressed') === 'true'), 10000)), '');
await click('skcore');
check('Core: off untags it',
  !!(await waitFor(async () => !((await shipSkill(A)).tags || []).includes('core'), 30000)),
  JSON.stringify((await shipSkill(A)).tags));
await waitFor(() => page.evaluate(() =>
  document.getElementById('skcore').getAttribute('aria-pressed') === 'false'), 10000);
await click('skcore');
check('and core again, for the rest of the run',
  !!(await waitFor(async () => ((await shipSkill(A)).tags || []).includes('core'), 30000)), '');

// ── 5. sensitive ────────────────────────────────────────────────────────
await waitFor(() => page.evaluate(() => !document.getElementById('sksens').disabled), 10000);
await click('sksens');
check('Sensitive: on marks it on the ship',
  !!(await waitFor(async () => (await shipSkill(A)).sensitive === true, 30000)),
  JSON.stringify(await shipSkill(A)));

// ── 6. history ──────────────────────────────────────────────────────────
await waitFor(() => has('#skhist'), 10000);
await click('skhist');
check('History lists at least two revisions',
  !!(await waitFor(() => page.evaluate(() => document.querySelectorAll('#skhistlist [data-rev]').length >= 2), 30000)),
  await text('#skmain'));
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#skhistlist [data-rev]')];
  rows.sort((a, b) => a.dataset.rev - b.dataset.rev)[0].querySelector('button').click();
});
check('an old revision shows its own text',
  !!(await waitFor(async () => (await has('#skrevbar'))
    && /first body/.test((await text('#skview')) || '') && !((await text('#skview')) || '').includes(MARK), 30000)),
  await text('#skview'));
await click('skrevback');
check('Back to current shows the edit again',
  !!(await waitFor(async () => !(await has('#skrevbar')) && ((await text('#skview')) || '').includes(MARK), 10000)), '');

// ── 7. delete and restore ───────────────────────────────────────────────
await click('skdel');
await dlg(null);
check('Delete takes it off the ship',
  !!(await waitFor(async () => (await shipSkill(A)).status === 404, 30000)), '');
check('and off the list', !!(await waitFor(async () => !(await has('#sklist [data-skill="' + A + '"]')), 15000)), '');
await click('sktrash');
check('Trash lists it', !!(await waitFor(() => has('#sktrashlist [data-skill="' + A + '"] button'), 30000)),
  await text('#sktrashlist'));
await page.evaluate((n) => document.querySelector('#sktrashlist [data-skill="' + n + '"] button').click(), A);
check('restore brings it back',
  !!(await waitFor(async () => String((await shipSkill(A)).body || '').includes(MARK), 30000)), '');
check('and it is listed again', !!(await waitFor(() => has('#sklist [data-skill="' + A + '"]'), 15000)), '');

check('no uncaught exceptions in the app', errors.length === 0, errors.join(' | '));
for (const n of [A, B])
  await fetch(api('skill-delete?name=' + n), { method: 'POST', headers: H }).catch(() => {});
await sleep(200);
await browser.close();
console.log(check.fails ? check.fails + ' check(s) FAILED' : 'all checks passed');
process.exit(check.fails ? 1 : 0);
