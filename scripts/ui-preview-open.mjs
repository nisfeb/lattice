//  ui-preview-open.mjs — the preview must not wait on the pier when you OPEN
//  a page, only when you type into one.
//
//  The local renderer landed wired to the `input` event alone, so typing was
//  instant while every other path still sat on a round trip. The common open
//  is worse than it looks: the tree dump already carries the body, so applyPage
//  runs `quiet` (no refreshPreview, to avoid a duplicate render) and the pane
//  kept showing the PREVIOUS document until the render=1 fetch landed. The
//  editor was never slow. The pane beside it was, which is what gets reported.
//
//  So: delay the ship's two render paths and assert the pane still shows the
//  document you just opened. If it only paints when the ship answers, this
//  fails — which is precisely the regression.
//
//  Usage: node scripts/ui-preview-open.mjs      (defaults to ~nec on :8080)
import { readFileSync } from 'fs';
import { homedir } from 'os';

const pp = (await import('puppeteer-core')).default;
const BASE = process.env.LATTICE_UI || 'http://localhost:8080';
const CKF = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/nec-cookie';
const APP = BASE + '/apps/lattice/app';
//  how long the ship is made to take. Longer than the budget below, so a pass
//  cannot be a fast server answer wearing a local paint's clothes.
const SHIP_DELAY = 9000;
const BUDGET = 2000;

const ck = readFileSync(CKF, 'utf8').trim();
const [cn, ...cr] = ck.split('=');
const RUN = 'prevopen' + (process.pid % 100000);
let fails = 0;
const check = (m, c, d) => {
  console.log((c ? '  ok   - ' : '  FAIL - ') + m + (c || !d ? '' : ' (' + d + ')'));
  if (!c) fails++;
};

const b = await pp.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 900 });
await p.setCookie({ name: cn, value: cr.join('='), domain: new URL(BASE).hostname, path: '/' });
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const goto = async () => {
  await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.querySelectorAll('#treelist a.pg').length > 0, { timeout: 90000 });
};
const srcdoc = () => p.evaluate(() => document.getElementById('prev').getAttribute('srcdoc') || '');

await goto();

//  Drive this with pages that ALREADY exist. Creating two and waiting for them
//  is a worse test: the tree is painted from a cached dump, so a fresh page can
//  be minutes behind its own 200, and the probe then fails for a reason that
//  has nothing to do with the preview. What matters here is the switch between
//  two documents the dump already carries — which is the `quiet` path anyway.
const pair = await p.evaluate(async () => {
  const j = await (await fetch('/apps/lattice/page-dump')).json();
  const md = (j.nodes || []).filter((n) => n.page && n.kind === 'md'
    && typeof n.body === 'string' && n.body.trim().length > 15);
  //  a marker is a longish word present in one body and absent from the other,
  //  so "the pane shows the new document" cannot pass on shared boilerplate
  const word = (s) => (s.match(/[A-Za-z]{6,}/g) || []);
  for (let i = 0; i < md.length; i++) {
    for (let k = i + 1; k < md.length; k++) {
      const wa = word(md[i].body).find((w) => !md[k].body.includes(w));
      const wb = word(md[k].body).find((w) => !md[i].body.includes(w));
      if (wa && wb) {
        return { a: md[i].path, b: md[k].path, wa, wb };
      }
    }
  }
  return null;
});
check('found two existing pages with distinguishable text', !!pair,
  pair ? '' : 'no suitable pair in the dump');
if (!pair) { await b.close(); console.log('\n' + fails + ' FAILED'); process.exit(1); }
console.log('    using ' + pair.a + ' ("' + pair.wa + '") and ' + pair.b + ' ("' + pair.wb + '")');
const A = pair.a;
const B = pair.b;

//  make the ship slow on exactly the two paths that can fill the preview
await p.setRequestInterception(true);
//  continue() resolves asynchronously, and a held request is still in flight
//  when the run ends — so every call swallows its own rejection. A sync
//  try/catch does not cover it, which is how this first blew up.
const hold = (q) => {
  const u = q.url();
  const go = () => q.continue().catch(() => {});
  if (u.includes('render=1') || u.includes('/page-preview')) { setTimeout(go, SHIP_DELAY); return; }
  go();
};
p.on('request', hold);

const open = async (name) => {
  const r = await p.evaluate((n) => {
    const all = [...document.querySelectorAll('#treelist a.pg')];
    //  the tree shows the LEAF label, not the full path, so match on contains
    const a = all.find((x) => x.textContent.trim() === n)
      || all.find((x) => x.textContent.trim().includes(n))
      || all.find((x) => (x.getAttribute('href') || '').includes(encodeURIComponent(n)));
    if (!a) return { ok: false, saw: all.slice(0, 6).map((x) => x.textContent.trim()) };
    a.click();
    return { ok: true };
  }, name);
  if (!r.ok) console.log('    (no tree row for ' + name + '; first rows: ' + JSON.stringify(r.saw) + ')');
  return r.ok;
};

check('the tree lists both pages', await open(A));
await p.waitForFunction((w) => (document.getElementById('prev').getAttribute('srcdoc') || '').includes(w),
  { timeout: BUDGET }, pair.wa).catch(() => {});
check('opening the first page paints it without the ship', (await srcdoc()).includes(pair.wa),
  (await srcdoc()).slice(0, 80));

//  the real test: with the previous document on screen, open another one
const t0 = Date.now();
await open(B);
let painted = false;
try {
  await p.waitForFunction((w) => (document.getElementById('prev').getAttribute('srcdoc') || '').includes(w),
    { timeout: BUDGET }, pair.wb);
  painted = true;
} catch {}
const dt = Date.now() - t0;
check('switching documents repaints the preview locally (' + dt + 'ms, ship held ' + SHIP_DELAY + 'ms)', painted,
  'pane still showed: ' + (await srcdoc()).slice(0, 80));
check('and it is the NEW document, not the one left behind', !(await srcdoc()).includes(pair.wa));

//  typing must still be instant — the path that already worked
await p.evaluate(() => {
  const s = document.getElementById('src');
  s.value = '# TYPEDMARKER\n'; s.dispatchEvent(new Event('input'));
});
let typed = false;
try {
  await p.waitForFunction(() => (document.getElementById('prev').getAttribute('srcdoc') || '').includes('TYPEDMARKER'),
    { timeout: BUDGET });
  typed = true;
} catch {}
check('typing still paints locally', typed);

p.off('request', hold);
await p.setRequestInterception(false);
//  nothing to clean up: this drives existing pages and never writes. The typing
//  check edits the textarea only, and no save is issued.
await b.close();
console.log(fails ? '\n' + fails + ' FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
