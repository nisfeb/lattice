#!/usr/bin/env node
//  ui-texpreview.mjs — the live LaTeX preview.
//
//  The renderer is a SUBPROCESS, so it cannot answer inside the synchronous
//  paint every other kind uses. That asymmetry is the whole design and the
//  whole risk: a wrong debounce spawns a pandoc per keystroke, a wrong cache
//  key loops forever, and a failed conversion could leave a stale document on
//  screen while the source no longer produces it. None of that throws, so it
//  needs a test that watches the calls.
//
//  __TAURI__ is stubbed, exactly as ui-deskmenu stubs it: this checks the
//  editor's side of the contract. Pandoc itself is covered by the Rust tests
//  in desktop/src/pandoc.rs.
//
//  Usage: LATTICE_UI=http://localhost:8081 node scripts/ui-texpreview.mjs
import { readFileSync } from 'fs';
import { homedir } from 'os';

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }

const BASE = (process.env.LATTICE_UI || 'http://localhost:8080').replace(/\/$/, '');
const CKF = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/nec-cookie';
const CHROME = process.env.CHROME || '/usr/bin/chromium';
const NAME = 'texpreview-probe-' + process.pid;
const TEX = '\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}';
const RENDERED = '<p>STUB RENDERED OUTPUT</p>';

let fails = 0;
const check = (n, ok, extra) => {
  console.log((ok ? '  ok   - ' : '  FAIL - ') + n + (ok ? '' : '  ' + (extra || '')));
  if (!ok) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cookie = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = cookie.split('=');
const browser = await puppeteer.launch({
  executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.setCookie({ name: cn, value: cr.join('='), domain: new URL(BASE).hostname, path: '/' });

//  a pandoc that counts its calls and can be told to fail
await page.evaluateOnNewDocument((out) => {
  window.__texCalls = [];
  window.__texFail = false;
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        window.__texCalls.push(cmd);
        //  an app built before LaTeX support rejects the call itself, which is
        //  a different thing from pandoc being absent
        if (window.__texNoCommand && /pandoc_probe|convert_tex/.test(cmd)) {
          throw new Error('Command ' + cmd + ' not found');
        }
        if (cmd === 'pandoc_probe') return { available: true, version: 'pandoc STUB', path: '/stub' };
        if (cmd === 'convert_tex') {
          if (window.__texFail) throw new Error('stub: undefined control sequence at line 3');
          return out + '<!--len:' + args.src.length + '-->';
        }
        return null;
      },
    },
  };
}, RENDERED);

try {
  await page.goto(BASE + '/apps/lattice/app', { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#treelist a.pg, #treelist .fld').length > 0,
    { timeout: 90000 });
  await sleep(2500);

  await page.evaluate(async (n, body) => {
    await fetch('/apps/lattice/page-save?name=' + n + '&type=tex&new=1',
      { method: 'POST', body, credentials: 'same-origin' });
  }, NAME, TEX);
  await page.reload({ waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(3500);
  await page.evaluate((n) => {
    const a = [...document.querySelectorAll('#treelist a.pg')]
      .find((x) => x.href.includes(encodeURIComponent(n)));
    if (a) a.click();
  }, NAME);
  await sleep(1200);

  const frameHtml = () => page.evaluate(() => document.getElementById('prev').srcdoc || '');

  //  before pandoc answers, the pane shows the SOURCE. A blank pane reads as
  //  broken; the source reads as honest.
  const early = await frameHtml();
  check('the source stands in before the first conversion',
    early.includes('documentclass') || early.includes(RENDERED), early.slice(0, 120));

  await sleep(2000);
  const rendered = await frameHtml();
  check('the conversion replaces it once it lands',
    rendered.includes('STUB RENDERED OUTPUT'), rendered.slice(0, 160));

  //  the property that matters most: a process per keystroke would be a fork
  //  bomb, so typing must coalesce into far fewer conversions than characters
  await page.evaluate(() => { window.__texCalls.length = 0; });
  for (const ch of 'abcdefghij') {
    await page.evaluate((c) => {
      const s = document.getElementById('src');
      s.value += c;
      s.dispatchEvent(new Event('input'));
    }, ch);
    await sleep(40);
  }
  await sleep(2500);
  const converts = await page.evaluate(() =>
    window.__texCalls.filter((c) => c === 'convert_tex').length);
  check('ten keystrokes coalesce into few conversions', converts > 0 && converts <= 3,
    'convert_tex calls: ' + converts);

  //  and it settles: no timer left spinning once typing stops
  await page.evaluate(() => { window.__texCalls.length = 0; });
  await sleep(2500);
  const idle = await page.evaluate(() =>
    window.__texCalls.filter((c) => c === 'convert_tex').length);
  check('an idle editor converts nothing', idle === 0, 'idle calls: ' + idle);

  //  a document that stops converting must SAY so, not keep showing the last
  //  good render of source that no longer produces it
  await page.evaluate(() => { window.__texFail = true; });
  await page.evaluate(() => {
    const s = document.getElementById('src');
    s.value += '\n\\broken{';
    s.dispatchEvent(new Event('input'));
  });
  await sleep(2500);
  const errHtml = await frameHtml();
  check('a failed conversion shows the reason', errHtml.includes('undefined control sequence'),
    errHtml.slice(0, 200));
  //  the failure that actually happened: the ship-served UI updated, the app
  //  binary did not, and the missing command was reported as a missing pandoc.
  //  That sent someone to reinstall software they already had.
  await page.evaluate(() => { window.__texNoCommand = true; });
  await page.evaluate(() => {
    const k = document.getElementById('pkind');
    k.value = 'md'; k.dispatchEvent(new Event('change'));
    k.value = 'tex'; k.dispatchEvent(new Event('change'));
  });
  await sleep(1200);
  const title = await page.evaluate(() => {
    const b = document.getElementById('texconv');
    return b ? b.title : '';
  });
  check('an app too old to convert says THAT, not "pandoc is missing"',
    /desktop build|predates/i.test(title) && !/needs pandoc installed/i.test(title),
    'button title: ' + JSON.stringify(title));
} catch (e) {
  check('threw: ' + String(e.message).slice(0, 140), false);
} finally {
  await page.evaluate((n) => fetch('/apps/lattice/page-del?name=' + n,
    { method: 'POST', credentials: 'same-origin' }).catch(() => {}), NAME).catch(() => {});
  await browser.close();
}
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
