#!/usr/bin/env node
//  Hostile-input fuzzer for the lattice HTTP API. Throws path traversal,
//  absurd lengths, unicode abuse, HTML/JS injection, malformed JSON, numeric
//  abuse, malformed urb:// addresses and wrong HTTP methods at every route
//  family, and asserts the ship never 5xxes, never hangs, never wedges, never
//  reflects a payload unescaped, and never stores a name it just rejected.
//
//  Usage:  node scripts/fuzz-api.mjs [--quick] [--verbose]
//  Env:    LATTICE_URL     ship base (default http://localhost:8081 — the nec
//                          harness). Refuses any non-loopback host: this
//                          hammers a ship and must never touch production.
//          LATTICE_COOKIE  cookie file (default ~/.config/lattice-fs/nec-cookie)
//
//  Cost: the pier serialises requests, and the render-heavy routes (the
//  reader, /marks, the explorer) dominate — measured ~3s/request against the
//  nec harness, well above the ~0.45s floor a bare page-tree costs.
//    full    ~560 requests -> ~20m wall clock (observed 652 req / 20m56s
//                             before trimming; includes 2x the deliberate
//                             30s unreachable-peer probes)
//    --quick ~120 requests -> ~7m  wall clock (nightly CI shape)
//  Budget the full run under ~600 requests; prefer adversarial cases to volume.
//
//  Everything it creates is namespaced under a per-run prefix (fzz<pid>) and
//  torn down at the end, like scripts/api-matrix.sh. The run prints a residue
//  report comparing page-tree / bookmarks / know-list before and after.
//
//  Findings are printed with the exact method, URL and (truncated) body so a
//  failure can be replayed by hand with curl.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const QUICK = process.argv.includes('--quick');
const VERBOSE = process.argv.includes('--verbose');
const TIMEOUT_MS = 30_000;
//  a route that peeks another ship waits +remote-timeout (~s30) before it can
//  answer 504. Deadlining the client at the same 30s made the abort race the
//  answer, so an unreachable peer scored LOW or CRITICAL at random. Give those
//  requests headroom so the outcome is the server's, not the stopwatch's.
const REMOTE_TIMEOUT_MS = 45_000;

const URL_BASE = (process.env.LATTICE_URL || 'http://localhost:8081').replace(/\/+$/, '');
const CKF = process.env.LATTICE_COOKIE || `${homedir()}/.config/lattice-fs/nec-cookie`;

//  Guard rail: this script generates load and writes garbage. Loopback only.
{
  const h = new URL(URL_BASE).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(h)) {
    console.error(`refusing to fuzz a non-loopback host: ${h}`);
    process.exit(2);
  }
}

const COOKIE = readFileSync(CKF, 'utf8').trim();
const B = `${URL_BASE}/apps/lattice`;

const P = `fzz${process.pid}`;          //  page namespace  (a valid @ta knot)
const K = `fzz${process.pid}`;          //  know-key namespace
const BM = `urb://~zod/${P}-mark`;      //  bookmark namespace

//  ── payload corpora ──────────────────────────────────────────────────────

const TRAVERSAL = [
  '../etc',
  '../../../../etc/passwd',
  `${P}/../../escape`,
  '..%2f..%2fetc',
  '%2e%2e%2f%2e%2e%2fetc',
  '/absolute/path',
  `${P}//double`,
  `${P}/./dot`,
  `${P}/..`,
  '.',
  '..',
  `${P}/a/../../../b`,
];

const UNICODE = [
  `${P}-astral-\u{1D54F}\u{1F4A9}`,        //  astral plane
  `${P}-max-\u{10FFFF}`,                    //  highest code point
  `${P}-rtl-\u202Egnp.exe`,                 //  RTL override
  `${P}-comb-a${'\u0301'.repeat(8)}`,       //  combining-mark stack
  `${P}-nul-\u0000-tail`,                   //  NUL
  `${P}-c0-\u0001\u0002\u0007\u001B`,      //  other C0 control bytes
  `${P}-nbsp-\u00A0\u2028\u2029`,           //  nbsp + line/para separators
];

//  Unique markers so a reflection check can never false-positive on the app's
//  own inline <script> tags.
//  A probe MUST contain a character that correct escaping would have changed,
//  otherwise it matches safe output and reports a phantom hole. `onerror=MARK`
//  has no metacharacters at all, so it survives entity-escaping verbatim: it
//  scored four CRITICALs against surfaces that were escaping correctly
//  (value="&quot;&gt;&lt;img src=x onerror=MARK&gt;"). Every probe here now
//  carries a raw '<' opening a tag, or a sink that is dangerous even when the
//  value itself is inert (javascript: in an href).
const XSS = [
  { tag: 'script', payload: '<script>FUZZMARKA</script>', probe: '<script>FUZZMARKA' },
  { tag: 'imgattr', payload: '"><img src=x onerror=FUZZMARKB>', probe: '<img src=x onerror=FUZZMARKB' },
  { tag: 'textarea', payload: '</textarea><b>FUZZMARKC</b>', probe: '</textarea><b>FUZZMARKC' },
  { tag: 'jsurl', payload: 'javascript:FUZZMARKD//', probe: 'href="javascript:FUZZMARKD' },
  { tag: 'svgload', payload: "'><svg onload=FUZZMARKE>", probe: '<svg onload=FUZZMARKE' },
];

const NUMERIC = ['-1', '0', '99999999999999999999', 'abc', '007', '1.024', '', ' ', '0x10', '1e9', '-0'];

const URB = [
  'urb://~notaship/x',
  'urb:///x',
  'urb://~nec//x/',
  'urb://~nec/%01%02',
  'urb://',
  'urb:/~nec/x',
  'urb://~zod/../../etc',
  `urb://~${'a'.repeat(300)}/x`,
  'not-a-url-at-all',
  '<script>FUZZMARKA</script>',
];

const BAD_JSON = [
  { label: 'truncated', body: '[{"name":"x","type":"md","bo' },
  { label: 'not-json', body: 'hello world' },
  { label: 'empty', body: '' },
  { label: 'null', body: 'null' },
  { label: 'object-not-array', body: '{"name":"x"}' },
  { label: 'wrong-types', body: '[{"name":123,"type":true,"body":null}]' },
  { label: 'missing-keys', body: '[{"name":"x"}]' },
  { label: 'lone-surrogate', body: '[{"name":"x","type":"md","body":"\\ud800"}]' },
  { label: 'deep-nest', body: `${'['.repeat(400)}${']'.repeat(400)}` },
  { label: 'nul-in-string', body: '[{"name":"x","type":"md","body":"a\\u0000b"}]' },
];

const big = (n) => 'A'.repeat(n);

//  What this run actually created, so cleanup undoes exactly that instead of
//  blind-firing a fixed list (which in --quick cost more requests than the
//  fuzzing did). Families register as they go.
const made = { marks: new Set(), ships: new Set(), groups: new Set() };
const track = (kind, v) => { if (v) made[kind].add(v); return v; };

//  ── plumbing ─────────────────────────────────────────────────────────────

let reqCount = 0;
const findings = [];
let wedged = false;
const t0run = Date.now();

const SEV = { CRIT: 0, HIGH: 1, MED: 2, LOW: 3 };
const SEVNAME = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

function trunc(s, n = 200) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}… (${s.length} bytes)` : s;
}

const seenFindings = new Set();
function finding(sev, family, title, repro, observed, why, fix) {
  //  dedupe: one route family answering the same way to twelve payloads is one
  //  defect, not twelve. The first occurrence keeps the repro.
  const k = `${family}::${title}`;
  if (seenFindings.has(k)) return;
  seenFindings.add(k);
  findings.push({ sev, family, title, repro, observed, why, fix });
  console.log(`  FINDING [${SEVNAME[sev]}] ${family}: ${title}`);
  console.log(`      repro:    ${repro}`);
  console.log(`      observed: ${observed}`);
  if (why) console.log(`      why:      ${why}`);
  if (fix) console.log(`      fix:      ${fix}`);
}

async function raw(method, url, opts = {}) {
  const headers = {};
  if (!opts.noCookie) headers.Cookie = COOKIE;
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  reqCount++;
  const t0 = Date.now();
  try {
    //  fetch() refuses to attach a body to GET/HEAD and throws before any
    //  request goes out. That is a client-side rule, not a ship answer, so
    //  drop the body rather than mis-report it as a transport failure.
    const sendBody = method === 'GET' || method === 'HEAD' ? undefined : opts.body;
    const res = await fetch(url, {
      method,
      headers,
      body: sendBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.remote ? REMOTE_TIMEOUT_MS : TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, text, ct: res.headers.get('content-type') || '', ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, text: String(e?.message || e), ct: '', ms: Date.now() - t0, transport: true };
  }
}

//  probe: one hostile request + the universal assertions (1, 2 and 6).
//  Returns the response so a caller can layer case-specific assertions on it.
async function probe(family, method, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${B}${path}`;
  const r = await raw(method, url, opts);
  const curl = `curl -X ${method} ${JSON.stringify(url)}${opts.body ? ` --data-binary ${JSON.stringify(trunc(opts.body, 160))}` : ''}`;

  const timedOut = r.transport && /timeout|abort/i.test(r.text);
  if (r.transport && timedOut && opts.remote) {
    //  the client deadline (30s) and +remote-timeout (~s30) are the same
    //  number, so an unreachable peer races us: sometimes a 504 arrives,
    //  sometimes our abort fires first. Both are the documented slow path.
    finding(SEV.LOW, family, 'unreachable peer costs a ~30s request slot', curl,
      `client aborted at ${r.ms}ms (server bound is +remote-timeout ~s30)`,
      'documented behaviour, recorded so the budget is visible — verified not to block the pier (a concurrent page-tree answers in <1s)',
      '+remote-timeout, if the UI ever needs a shorter deadline');
  } else if (r.transport) {
    finding(SEV.CRIT, family, timedOut ? `request hung >${opts.remote ? REMOTE_TIMEOUT_MS : TIMEOUT_MS}ms` : 'transport failure',
      curl, r.text, timedOut ? 'assertion 2: no request may hang' : 'connection died mid-request',
      'the route arm that handles this path');
  } else if (r.status === 504 && opts.remote) {
    //  +remote-timeout is ~s30 and the arm documents "unreachable or denied
    //  reads as 504". Verified not to block the pier (a concurrent page-tree
    //  answers in <1s), so this is a slow answer, not a wedge.
    finding(SEV.LOW, family, 'unreachable peer costs a 30s request slot', curl,
      `504 after ${r.ms}ms`,
      'documented behaviour (+remote-timeout ~s30), recorded so the budget is visible — not an assertion-1 violation',
      '+remote-timeout, if the UI ever needs a shorter deadline');
  } else if (r.status >= 500) {
    finding(SEV.CRIT, family, `${r.status} on hostile input`, curl,
      `${r.status} ${r.ct} ${trunc(r.text, 240)}`,
      'assertion 1: hostile input must yield a clean 4xx or a well-formed 200, never a 5xx',
      'the route arm that handles this path');
  } else if (r.status === 200 && /json/.test(r.ct)) {
    try {
      JSON.parse(r.text);
    } catch (e) {
      finding(SEV.HIGH, family, '200 with unparseable JSON body', curl,
        `${r.status} ${r.ct} ${trunc(r.text, 240)} :: ${e.message}`,
        'assertion 6: a JSON route answering 200 must return parseable JSON',
        'the +send-json call in that route arm');
    }
  }
  if (VERBOSE) console.log(`    ${r.status} ${method} ${trunc(url, 120)}`);
  return r;
}

//  canary: assertion 3. A dead canary stops the run.
async function canary(family) {
  const r = await raw('GET', `${B}/page-tree`);
  if (r.status !== 200) {
    wedged = true;
    finding(SEV.CRIT, family, 'SHIP WEDGED — canary page-tree failed',
      `curl -H "Cookie: …" ${B}/page-tree`,
      r.transport ? `transport: ${r.text}` : `${r.status} ${trunc(r.text, 200)}`,
      'assertion 3: after every family the ship must still answer page-tree 200',
      'whatever the previous family last poked');
    return false;
  }
  return true;
}

async function tree() {
  const r = await raw('GET', `${B}/page-tree`);
  try { return JSON.parse(r.text).nodes || []; } catch { return []; }
}

//  assertion 5: a name the server REJECTED must not have created anything.
//  Takes the names that actually drew a 4xx — asserting against names the
//  server accepted (200) would mislabel an accept-policy question as a
//  validation bypass, which is exactly the false positive this replaced.
async function assertRejectedAbsent(family, rejected) {
  if (!rejected.length) return;
  const paths = new Set((await tree()).map((n) => n.path));
  for (const name of rejected) {
    //  a page's tree path is its name with any leading/duplicate slashes
    //  collapsed; compare both forms so a near-miss still trips.
    const norm = String(name).replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
    if (paths.has(String(name)) || (norm && paths.has(norm))) {
      finding(SEV.HIGH, family, 'a name the server rejected still created a page',
        `curl -X POST "${B}/page-save?name=${encodeURIComponent(name)}&type=md&new=1" --data-binary x  # returned 4xx`,
        `page-tree nevertheless contains ${JSON.stringify(norm || String(name))}`,
        'assertion 5: a refused name must never create a page',
        '+valid-name / +name-pax vs the write path in that route arm');
      return;
    }
  }
}

//  assertion 4: reflected payloads must come back escaped.
//  HTML surfaces only. A <script> inside a JSON string body served as
//  application/json is data, not markup — flagging it is a false positive.
//  Guard the guard. A probe that matches correctly-escaped output turns every
//  clean surface into a CRITICAL, and a wrong alarm gets the whole run ignored.
//  Runs before any request: costs nothing, and fails loudly rather than lying.
function assertProbesSound() {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const broken = [];
  for (const x of XSS) {
    if (x.tag === 'jsurl') continue;   //  a sink probe: dangerous while inert
    if (`<input value="${esc(x.payload)}">`.includes(x.probe)) broken.push(`${x.tag}: matches ESCAPED output`);
    if (!`<input value="${x.payload}">`.includes(x.probe)) broken.push(`${x.tag}: misses RAW output`);
  }
  if (broken.length) {
    console.error('fuzz-api: XSS probes are unsound, refusing to run:\n  ' + broken.join('\n  '));
    process.exit(2);
  }
}

function xssScan(family, surface, r, repro) {
  if (!/html/i.test(r.ct || '')) return false;
  const text = r.text;
  for (const x of XSS) {
    if (text.includes(x.probe)) {
      //  the title carries only the payload class, so one unescaped sink is
      //  one finding however many paths reach it. The surface goes in the body.
      finding(SEV.CRIT, family, `XSS: ${x.tag} payload reflected unescaped`,
        repro, `${surface} returned the literal ${JSON.stringify(x.probe)}`,
        'assertion 4: anything reflected into HTML must be entity-escaped',
        '+esc (escapes & < > ") — the renderer for that surface is not calling it');
      return true;
    }
  }
  //  generic: a raw opening script tag we did not author
  if (/<script>FUZZMARK/.test(text)) {
    finding(SEV.CRIT, family, 'XSS: raw <script> reflected', repro,
      `${surface} returned an unescaped <script> carrying our marker`,
      'assertion 4', '+esc');
    return true;
  }
  return false;
}

const q = (o) => Object.entries(o)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

//  ── families ─────────────────────────────────────────────────────────────

async function famPageSave() {
  console.log('==> page-save: names');
  const names = QUICK
    ? [...TRAVERSAL.slice(0, 2), UNICODE[4], XSS[0].payload, big(1024)]
    : [...TRAVERSAL, ...UNICODE, ...XSS.map((x) => x.payload), big(1024), '', ' ', '/', '//',
       `${P}/`, 'CAPITALS', `${P}/sp ace`];
  const rejected = [];
  for (const n of names) {
    const r = await probe('page-save', 'POST', `/page-save?${q({ name: n, type: 'md', new: '1' })}`,
      { body: '# fuzz' });
    if (r.status >= 400) rejected.push(n);
    else if (r.status === 200 && /(^|\/)\.\.?(\/|$)/.test(String(n))) {
      //  Urbit paths treat `.` and `..` as ordinary knots, so this is NOT a
      //  filesystem escape — the page really is named "..". But +name-pax
      //  admitting them means page-tree grows nodes whose paths look like
      //  traversal to every client that joins them with "/", and a user
      //  cannot reach or retype them.
      finding(SEV.MED, 'page-save', '+name-pax accepts "." and ".." as page-name segments',
        `curl -X POST ${JSON.stringify(`${B}/page-save?${q({ name: n, type: 'md', new: '1' })}`)} --data-binary '# fuzz'`,
        `200 (created a page whose page-tree path is ${JSON.stringify(trunc(n, 80))})`,
        'dot segments are valid @ta knots so (sane %ta) passes them; the tree then reports paths that look like traversal to any client that string-joins them',
        '+name-pax — reject `.` and `..` alongside the existing non-empty/@ta segment check');
    }
  }
  //  assertion 5: only names that actually drew a 4xx are asserted absent.
  //  Dot segments are ACCEPTED by the server and reported separately above.
  await assertRejectedAbsent('page-save', rejected);

  console.log('==> page-save: body sizes and types');
  const bodies = QUICK
    ? [['1KB', big(1024)]]
    : [['1KB', big(1024)], ['64KB', big(65536)], ['1MB', big(1048576)]];
  for (const [label, body] of bodies) {
    await probe('page-save', 'POST', `/page-save?${q({ name: `${P}/size-${label}`, type: 'md', new: '1' })}`, { body });
  }
  if (!QUICK) {
    for (const t of ['', 'index', '../evil', big(200), '<script>', 'md\u0000', 'MD']) {
      await probe('page-save', 'POST', `/page-save?${q({ name: `${P}/type-probe`, type: t })}`, { body: 'x' });
    }
    //  base= is a rev number: numeric abuse
    for (const v of NUMERIC.slice(0, 7)) {
      await probe('page-save', 'POST', `/page-save?${q({ name: `${P}/note`, type: 'md', base: v })}`, { body: 'x' });
    }
    //  new= is a flag
    for (const v of ['1', '0', 'true', '../x', big(100)]) {
      await probe('page-save', 'POST', `/page-save?${q({ name: `${P}/newflag`, type: 'md', new: v })}`, { body: 'x' });
    }
    //  no name at all / repeated name param
    await probe('page-save', 'POST', '/page-save?type=md', { body: 'x' });
    await probe('page-save', 'POST', `/page-save?name=${P}/dup&name=../evil&type=md`, { body: 'x' });
  }
  return canary('page-save');
}

async function famBatch() {
  console.log('==> page-save-batch');
  const modes = QUICK ? [''] : ['', '?report=1'];
  const cases = QUICK ? BAD_JSON.slice(0, 4) : BAD_JSON;
  for (const mode of modes) {
    for (const c of cases) {
      await probe('page-save-batch', 'POST', `/page-save-batch${mode}`, { body: c.body });
    }
  }
  //  empty / oversized / duplicate-name batches
  const mk = (n, name) => JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ name: name ? name(i) : `${P}/b${i}`, type: 'md', body: 'x' })));
  await probe('page-save-batch', 'POST', '/page-save-batch', { body: '[]' });
  await probe('page-save-batch', 'POST', '/page-save-batch', { body: mk(201) });
  await probe('page-save-batch', 'POST', '/page-save-batch', { body: mk(5, () => `${P}/same`) });
  if (!QUICK) {
    await probe('page-save-batch', 'POST', '/page-save-batch?report=1', { body: mk(0) });
    //  all-or-nothing: a batch containing one name the server REJECTS must
    //  write neither item. Uses a name that genuinely fails +valid-name (an
    //  empty segment), not a dot name — dots pass validation, so a dot batch
    //  is expected to land and proves nothing about atomicity.
    const rb = await probe('page-save-batch', 'POST', '/page-save-batch', {
      body: JSON.stringify([{ name: `${P}/good1`, type: 'md', body: 'x' },
        { name: '//', type: 'md', body: 'x' }]),
    });
    if (rb.status >= 400) {
      const nodes = await tree();
      if (nodes.some((n) => n.path === `${P}/good1`)) {
        finding(SEV.HIGH, 'page-save-batch', 'batch half-applied: the valid item landed though the batch was rejected',
          `curl -X POST "${B}/page-save-batch" --data-binary '[{"name":"${P}/good1",…},{"name":"//",…}]'  # returned ${rb.status}`,
          `page-tree contains ${P}/good1`,
          'the arm documents all-or-nothing validation before any write',
          "[%'POST' %page-save-batch] — the levy valid-name guard");
      }
    }
    //  report mode with hostile base values
    for (const v of ['-1', '99999999999999999999', 'abc', '1.024']) {
      await probe('page-save-batch', 'POST', '/page-save-batch?report=1', {
        body: `[{"name":"${P}/rep","type":"md","body":"x","base":${JSON.stringify(v)}}]`,
      });
    }
    await probe('page-save-batch', 'POST', '/page-save-batch?report=1', {
      body: `[{"name":"${P}/rep","type":"md","body":"x","base":-1}]`,
    });
    await probe('page-save-batch', 'POST', '/page-save-batch?report=notanumber', { body: mk(1) });
  }
  return canary('page-save-batch');
}

async function famStructure() {
  console.log('==> folder-new / page-del / page-move');
  const names = QUICK ? TRAVERSAL.slice(0, 2) : [...TRAVERSAL, ...UNICODE.slice(0, 4), big(1024), ''];
  for (const n of names) {
    await probe('folder-new', 'POST', `/folder-new?${q({ name: n })}`);
  }
  for (const n of (QUICK ? TRAVERSAL.slice(0, 2) : [...TRAVERSAL, '', big(512)])) {
    await probe('page-del', 'POST', `/page-del?${q({ name: n })}`);
  }
  if (!QUICK) {
    //  page-move: hostile from/to, plus the move-under-itself invariant
    await probe('page-move', 'POST', `/page-move?${q({ from: `${P}/note`, to: '../../escape-move' })}`);
    await probe('page-move', 'POST', `/page-move?${q({ from: '../../etc', to: `${P}/x` })}`);
    await probe('page-move', 'POST', `/page-move?${q({ from: P, to: `${P}/sub` })}`);
    await probe('page-move', 'POST', `/page-move?${q({ from: P, to: P })}`);
    await probe('page-move', 'POST', `/page-move?${q({ from: '', to: '' })}`);
    await probe('page-move', 'POST', '/page-move');
    await probe('page-move', 'POST', `/page-move?${q({ from: `${P}/note`, to: big(2048) })}`);
    await probe('page-move', 'POST', `/page-move?${q({ from: `${P}/note`, to: XSS[0].payload })}`);
  }
  await probe('page-del', 'POST', `/page-del?${q({ name: '/' })}`);
  //  the whole tree must survive a page-del aimed at the root
  const nodes = await tree();
  if (nodes.length === 0) {
    finding(SEV.CRIT, 'page-del', 'page-del on a root-ish name emptied the tree',
      `curl -X POST "${B}/page-del?name=%2F"`, 'page-tree returned zero nodes',
      'a hostile name must never delete the whole page store',
      "[%'POST' %page-del] / +name-pax");
  }
  return canary('structure');
}

async function famReads() {
  console.log('==> read routes: page-source / -at / history / backlinks / tree / dump');
  const names = QUICK ? TRAVERSAL.slice(0, 3) : [...TRAVERSAL, ...UNICODE.slice(0, 4), big(1024), ''];
  for (const n of names) {
    await probe('page-source', 'GET', `/page-source?${q({ name: n })}`);
  }
  for (const v of (QUICK ? NUMERIC.slice(0, 3) : NUMERIC.slice(0, 8))) {
    await probe('page-source-at', 'GET', `/page-source-at?${q({ name: `${P}/note`, rev: v })}`);
  }
  if (!QUICK) {
    await probe('page-source-at', 'GET', `/page-source-at?${q({ name: '../etc', rev: '1' })}`);
    await probe('page-source-at', 'GET', `/page-source-at?${q({ name: `${P}/note` })}`);
    for (const n of TRAVERSAL.slice(0, 5)) {
      await probe('page-history', 'GET', `/page-history?${q({ name: n })}`);
      await probe('page-backlinks', 'GET', `/page-backlinks?${q({ name: n })}`);
    }
    //  render=1 with a payload-bearing page, plus junk params on the bulk reads
    await probe('page-tree', 'GET', `/page-tree?${q({ depth: '-1', junk: big(500) })}`);
    await probe('page-dump', 'GET', `/page-dump?${q({ depth: '99999999999999999999' })}`);
    await probe('page-source', 'GET', `/page-source?${q({ name: `${P}/note`, render: '../x' })}`);
  }
  await probe('page-tree', 'GET', '/page-tree?%00=%01');
  await probe('page-dump', 'GET', '/page-dump');
  return canary('reads');
}

async function famSharing() {
  console.log('==> sharing: page-share / share-tree / share-file / groups');
  const modes = QUICK ? ['public', '../x'] : ['public', 'CLEARWEB', '', '../x', big(200), XSS[0].payload, 'clearweb\u0000'];
  for (const m of modes) {
    await probe('page-share', 'POST', `/page-share?${q({ name: `${P}/note`, mode: m })}`);
  }
  for (const n of (QUICK ? TRAVERSAL.slice(0, 3) : TRAVERSAL)) {
    await probe('page-share', 'POST', `/page-share?${q({ name: n, mode: 'clearweb' })}`);
    if (!QUICK) await probe('page-share-tree', 'POST', `/page-share-tree?${q({ name: n, mode: 'clearweb' })}`);
  }
  //  share-file: ship parsing is the interesting surface
  const ships = QUICK
    ? ['~notaship', '']
    : ['~notaship', '', 'zod', '~zod~zod', big(300), '~zod/../etc', XSS[0].payload, '~nec', '~doznec-doznec', '0'];
  for (const s of ships) {
    await probe('share-file', 'POST', `/share-file?${q({ name: `${P}/note`, ship: s, mode: 'read' })}`);
  }
  if (!QUICK) {
    for (const m of ['write', '', '../x', big(100)]) {
      await probe('share-file', 'POST', `/share-file?${q({ name: `${P}/note`, ship: '~zod', mode: m })}`);
    }
    console.log('==> share groups');
    await probe('share-groups', 'GET', '/share-groups');
    const gnames = ['../evil', 'UPPER', '', big(300), 'a b', XSS[0].payload, `${P}-grp`];
    for (const g of gnames) {
      const r = await probe('share-group-save', 'POST', `/share-group-save?${q({ name: g })}`,
        { body: '{"ships":["~zod"],"peek":[],"make":[]}' });
      if (r.status === 200) track('groups', g);
    }
    for (const c of BAD_JSON) {
      await probe('share-group-save', 'POST', `/share-group-save?${q({ name: `${P}-grp` })}`, { body: c.body });
    }
    //  grant paths must stay under /apps
    for (const p of ['/sys', '/sys/vane', 'apps/relative', '/apps/../sys', '', '/apps/\u0000']) {
      await probe('share-group-save', 'POST', `/share-group-save?${q({ name: `${P}-grp` })}`,
        { body: JSON.stringify({ ships: ['~zod'], peek: [p], make: [] }) });
    }
    for (const g of ['../evil', '', big(300), `${P}-grp`]) {
      await probe('share-group-del', 'POST', `/share-group-del?${q({ name: g })}`);
    }
  }
  return canary('sharing');
}

async function famBanlist() {
  console.log('==> banlist');
  const ships = QUICK
    ? ['~notaship', '']
    : ['~notaship', '', 'zod', '~zod~zod', big(300), '~zod/../etc', XSS[0].payload, '~nec',
       '~doznec-doznec-doznec', '0', '~\u0000', '~zod%00'];
  for (const s of ships) {
    const r = await probe('ban', 'POST', `/ban?${q({ ship: s })}`);
    if (r.status === 200) track('ships', s);
    await probe('unban', 'POST', `/unban?${q({ ship: s })}`);
  }
  await probe('ban', 'POST', '/ban');
  const r = await probe('banlist', 'GET', '/banlist');
  if (r.status === 200) {
    try {
      const list = JSON.parse(r.text);
      if (Array.isArray(list) && list.some((s) => /FUZZMARK|notaship/.test(String(s)))) {
        finding(SEV.HIGH, 'banlist', 'a malformed ship name entered the banlist',
          `curl "${B}/banlist"`, trunc(r.text, 200),
          'slaw %p must reject these before they reach the stored set',
          "[%'POST' %ban]");
      }
    } catch { /* probe already flagged */ }
  }
  return canary('banlist');
}

async function famKnow() {
  console.log('==> knowledge store');
  const keys = QUICK
    ? [...TRAVERSAL.slice(0, 2), UNICODE[4]]
    : [...TRAVERSAL, ...UNICODE.slice(0, 4), ...XSS.map((x) => x.payload), big(1024), '', '//'];
  for (const k of keys) {
    await probe('know-save', 'POST', `/know-save?${q({ key: k })}`, { body: 'fuzz body' });
  }
  for (const k of (QUICK ? TRAVERSAL.slice(0, 3) : [...TRAVERSAL, ...UNICODE.slice(0, 3), ''])) {
    await probe('know-read', 'GET', `/know-read?${q({ key: k })}`);
  }
  //  a legitimate key we then abuse the tag surface on
  await probe('know-save', 'POST', `/know-save?${q({ key: `${K}/real` })}`, { body: 'fuzz body' });
  const tags = QUICK
    ? [XSS[0].payload]
    : [...XSS.map((x) => x.payload), '', big(1024), '../x', UNICODE[4], 'a b'];
  for (const t of tags) {
    await probe('know-tag', 'POST', `/know-tag?${q({ key: `${K}/real`, tag: t })}`);
    await probe('know-untag', 'POST', `/know-untag?${q({ key: `${K}/real`, tag: t })}`);
  }
  if (!QUICK) {
    await probe('know-tag', 'POST', `/know-tag?${q({ key: `${K}/real` })}`);
    await probe('know-untag', 'POST', '/know-untag');
    await probe('know-save', 'POST', `/know-save?${q({ key: `${K}/big` })}`, { body: big(65536) });
    await probe('know-save', 'POST', `/know-save?${q({ key: `${K}/xss` })}`,
      { body: XSS.map((x) => x.payload).join('\n') });
    for (const k of [...TRAVERSAL.slice(0, 5), '']) {
      await probe('know-delete', 'POST', `/know-delete?${q({ key: k })}`);
      await probe('know-restore', 'POST', `/know-restore?${q({ key: k })}`);
    }
  }
  await probe('know-list', 'GET', '/know-list');
  //  assertion 4: the /know reader renders keys, tags and bodies
  const kr = await probe('know-reader', 'GET', '/know');
  if (kr.status === 200) xssScan('know', '/know reader', kr, `curl "${B}/know"`);
  if (!QUICK) {
    const kr2 = await probe('know-reader', 'GET', `/know/${encodeURIComponent(`${K}/xss`)}`);
    if (kr2.status === 200) xssScan('know', `/know/${K}/xss`, kr2, `curl "${B}/know/${K}/xss"`);
  }
  return canary('know');
}

async function famBookmarks() {
  console.log('==> bookmarks');
  for (const u of (QUICK ? URB.slice(0, 3) : URB)) {
    const r = await probe('bookmark', 'POST', `/bookmark?${q({ url: u, title: `${P}-t`, folder: `${P}f` })}`);
    if (r.status === 200) track('marks', u);
  }
  //  a real bookmark whose TITLE and FOLDER are injection payloads: /marks renders both
  for (const x of (QUICK ? [XSS[0]] : XSS)) {
    const r = await probe('bookmark', 'POST',
      `/bookmark?${q({ url: `${BM}-${x.tag}`, title: x.payload, folder: x.payload })}`);
    if (r.status === 200) track('marks', `${BM}-${x.tag}`);
  }
  if (!QUICK) {
    track('marks', BM);
    await probe('bookmark', 'POST', `/bookmark?${q({ url: BM, title: big(65536) })}`);
    await probe('bookmark', 'POST', '/bookmark');
    await probe('bookmark', 'POST', `/bookmark?${q({ url: '' })}`);
    for (const f of ['../x', '', big(500), XSS[1].payload]) {
      await probe('bookmark-move', 'POST', `/bookmark-move?${q({ url: BM, folder: f })}`);
    }
    await probe('bookmark-move', 'POST', `/bookmark-move?${q({ url: 'urb://~notaship/x', folder: 'y' })}`);
    await probe('unbookmark', 'POST', '/unbookmark');
    await probe('unbookmark', 'POST', `/unbookmark?${q({ url: '../x' })}`);
  }
  const bl = await probe('bookmarks', 'GET', '/bookmarks');
  if (bl.status === 200) xssScan('bookmarks', '/bookmarks json', bl, `curl "${B}/bookmarks"`);
  //  assertion 4: /marks is the rendered surface
  const marks = await probe('marks', 'GET', '/marks');
  if (marks.status === 200) {
    xssScan('bookmarks', '/marks page', marks,
      `curl -X POST "${B}/bookmark?url=${encodeURIComponent(`${BM}-script`)}&title=<script>FUZZMARKA</script>" then curl "${B}/marks"`);
  }
  return canary('bookmarks');
}

async function famReader() {
  console.log('==> reader / explorer / omni-suggest / history');
  const foreign = (u) => {
    const m = /^urb:\/\/(~[a-z-]+)/.exec(String(u));
    return !!m && m[1] !== _ship;
  };
  for (const u of (QUICK ? URB.slice(0, 4) : [...URB, ...XSS.map((x) => x.payload), big(4096), '', ' '])) {
    const r = await probe('reader', 'GET', `${B}?${q({ url: u })}`, { remote: foreign(u) });
    if (r.status === 200 && /html/.test(r.ct)) {
      xssScan('reader', `root reader ?url=${trunc(u, 60)}`, r,
        `curl ${JSON.stringify(`${B}?${q({ url: u })}`)}`);
    }
  }
  //  /x/<ship>/<path>: the explorer consumes the rest of the path verbatim.
  //  Aim the path-handling cases at OUR OWN ship: a foreign ship short-circuits
  //  straight into the remote peek, so it exercises ames, not path parsing —
  //  and burns +remote-timeout (~s30) per probe. Two foreign probes are kept
  //  deliberately, to pin that an unreachable peer still answers 504.
  const me = await ourShip() || '~nec';
  const local = QUICK
    ? [`${me}/apps/%00`, `${me}/../../etc`]
    : [`${me}/apps/%00`, `${me}/../../etc`, `${me}`, `${me}/`, `${me}/${big(500)}`,
       `${me}/apps/${encodeURIComponent(XSS[0].payload)}`, `${me}/apps//double`, `${me}/apps/.`,
       `${me}/apps/..`, `${me}/apps/lattice.lattice_app/page/${P}`, '', '/', '%2e%2e/%2e%2e',
       `~${'a'.repeat(200)}/apps`, '~notaship/apps'];
  for (const xp of local) {
    const r = await probe('explorer', 'GET', `/x/${xp}`);
    if (r.status === 200 && /html/.test(r.ct)) {
      xssScan('explorer', `/x/${xp}`, r, `curl ${JSON.stringify(`${B}/x/${xp}`)}`);
    }
  }
  //  full only: a known-LOW 30s probe is dead weight in a nightly smoke run
  if (!QUICK) {
    for (const xp of ['~zod/apps', '~zod/apps/%00']) {
      await probe('explorer-remote', 'GET', `/x/${xp}`, { remote: true });
    }
  }
  //  /f/<name>: raw asset serving
  for (const f of (QUICK ? ['../etc'] : ['../etc', '%00', '', `${P}/note`, big(500), '..%2f..%2fetc', '.'])) {
    await probe('asset', 'GET', `/f/${f}`);
  }
  //  /c/<path>: the unauthenticated clearweb surface — also probe with NO cookie
  for (const c of (QUICK ? [`${P}/note`] : ['../etc', '%00', '', `${P}/note`, big(500), '..%2f..%2fetc', '.', 'a//b'])) {
    const r = await probe('clearweb', 'GET', `/c/${c}`, { noCookie: true });
    if (r.status === 200 && /html/.test(r.ct)) {
      xssScan('clearweb', `/c/${c}`, r, `curl ${JSON.stringify(`${B}/c/${c}`)}`);
    }
  }
  for (const s of (QUICK ? [XSS[0].payload] : [...XSS.map((x) => x.payload), '', big(4096), UNICODE[4], '../x', '%00'])) {
    const r = await probe('omni-suggest', 'GET', `/omni-suggest?${q({ q: s })}`);
    if (r.status === 200 && /html/.test(r.ct)) xssScan('omni-suggest', 'omni-suggest', r, `curl "${B}/omni-suggest?q=…"`);
  }
  const h = await probe('history', 'GET', '/history');
  if (h.status === 200) xssScan('history', '/history', h, `curl "${B}/history"`);
  if (!QUICK) {
    await probe('history-forget', 'POST', `/history-forget?${q({ url: '../x' })}`);
    await probe('history-forget', 'POST', '/history-forget');
  }
  return canary('reader');
}

async function famCmdForms() {
  console.log('==> page-cmd / page-forms / comments');
  //  seed a page the command/comment routes can legitimately target
  await probe('setup', 'POST', `/page-save?${q({ name: `${P}/cmd`, type: 'md', new: '1' })}`, { body: '# cmd' });
  const cmds = QUICK
    ? ['(add 2 2)', XSS[0].payload]
    : ['(add 2 2)', XSS[0].payload, '', big(65536), '|=(x=@ !!)', '\u0000', '((((((', 'cmd=%00'];
  for (const c of cmds) {
    await probe('page-cmd', 'POST', `/page-cmd?${q({ name: `${P}/cmd` })}`,
      { body: `cmd=${encodeURIComponent(c)}`, contentType: 'application/x-www-form-urlencoded' });
  }
  for (const n of (QUICK ? TRAVERSAL.slice(0, 2) : TRAVERSAL)) {
    await probe('page-cmd', 'POST', `/page-cmd?${q({ name: n })}`, { body: 'cmd=x' });
  }
  if (!QUICK) {
    await probe('page-cmd', 'POST', `/page-cmd?${q({ name: `${P}/cmd`, web: '1' })}`, { body: 'cmd=1' });
    await probe('page-cmd', 'POST', '/page-cmd', { body: 'cmd=x' });
    //  page-forms numeric abuse on cap/gap
    for (const v of NUMERIC.slice(0, 6)) {
      await probe('page-forms', 'POST', `/page-forms?${q({ name: `${P}/cmd`, on: '1', cap: v, gap: v })}`);
    }
    await probe('page-forms', 'GET', `/page-forms?${q({ name: '../etc' })}`);
    await probe('page-forms-reset', 'POST', `/page-forms-reset?${q({ name: '../etc' })}`);
    //  the unauthenticated write surface
    for (const f of ['../etc', '%00', `${P}/cmd`, '']) {
      await probe('form-post', 'POST', `/f/${f}`, { body: 'entry=x', noCookie: true });
    }
    await probe('form-post', 'POST', `/f/${P}/cmd`, { body: `entry=${encodeURIComponent(XSS[0].payload)}`, noCookie: true });
  }
  console.log('==> comments');
  await probe('page-comments', 'POST', `/page-comments?${q({ name: `${P}/cmd`, on: '1' })}`);
  for (const p of (QUICK ? TRAVERSAL.slice(0, 2) : TRAVERSAL)) {
    await probe('comment', 'POST', `/comment?${q({ page: p })}`, { body: 'body=x' });
  }
  for (const x of (QUICK ? [XSS[0]] : XSS)) {
    await probe('comment', 'POST', `/comment?${q({ page: `${P}/cmd` })}`,
      { body: `body=${encodeURIComponent(x.payload)}`, contentType: 'application/x-www-form-urlencoded' });
  }
  if (!QUICK) {
    await probe('comment', 'POST', `/comment?${q({ page: `${P}/cmd` })}`, { body: '' });
    await probe('comment', 'POST', `/comment?${q({ page: `${P}/cmd` })}`, { body: `body=${'x'.repeat(65536)}` });
    for (const id of ['../x', '', 'UPPER', big(300), XSS[0].payload]) {
      await probe('comment-del', 'POST', `/comment-del?${q({ page: `${P}/cmd`, id })}`);
    }
    await probe('comment-del', 'POST', `/comment-del?${q({ page: '../etc', id: 'a' })}`);
  }
  const ci = await probe('comments-inbox', 'GET', '/comments-inbox');
  if (ci.status === 200) xssScan('comments', 'comments-inbox', ci, `curl "${B}/comments-inbox"`);
  //  assertion 4: the page view renders comments
  const ship = await ourShip();
  if (ship) {
    const view = await probe('page-view', 'GET', `/x/${ship}/apps/lattice.lattice_app/page/${P}/cmd/`);
    if (view.status === 200) {
      xssScan('comments', 'rendered page view', view,
        `POST a comment carrying <script>FUZZMARKA</script> then curl "${B}/x/${ship}/apps/lattice.lattice_app/page/${P}/cmd/"`);
    }
  }
  return canary('cmd/forms/comments');
}

async function famMethods() {
  console.log('==> wrong HTTP methods');
  const gets = ['page-tree', 'page-dump', 'page-source', 'page-history', 'page-source-at',
    'page-backlinks', 'banlist', 'share-groups', 'bookmarks', 'marks', 'omni-suggest',
    'history', 'know-list', 'know-read', 'comments-inbox', 'page-forms'];
  const posts = ['page-save', 'page-save-batch', 'page-del', 'folder-new', 'page-move',
    'page-share', 'page-share-tree', 'share-file', 'share-group-save', 'share-group-del',
    'ban', 'unban', 'know-save', 'know-delete', 'know-restore', 'know-tag', 'know-untag',
    'bookmark', 'unbookmark', 'bookmark-move', 'page-cmd', 'comment', 'comment-del'];
  const gl = QUICK ? gets.slice(0, 3) : gets;
  const pl = QUICK ? posts.slice(0, 3) : posts;
  for (const r of gl) await probe('methods', 'POST', `/${r}?${q({ name: `${P}/note`, key: `${K}/real` })}`, { body: 'x' });
  for (const r of pl) await probe('methods', 'GET', `/${r}?${q({ name: `${P}/note`, key: `${K}/real` })}`);
  if (!QUICK) {
    for (const m of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      await probe('methods', m, `/page-tree`);
      await probe('methods', m, `/page-save?${q({ name: `${P}/m`, type: 'md' })}`, { body: 'x' });
    }
  }
  return canary('methods');
}

//  ── ship identity, snapshots, cleanup ────────────────────────────────────

let _ship = null;
async function ourShip() {
  if (_ship !== null) return _ship;
  const r = await raw('GET', B);
  const m = r.text.match(/urb:\/\/(~[a-z-]{3,60})/);
  _ship = m ? m[1] : '';
  return _ship;
}

async function snapshot() {
  const nodes = await tree();
  const bm = await raw('GET', `${B}/bookmarks`);
  const kn = await raw('GET', `${B}/know-list`);
  const strings = (t) => { try { return JSON.stringify(JSON.parse(t)); } catch { return t; } };
  return {
    pages: nodes.map((n) => n.path).sort(),
    bookmarks: strings(bm.text),
    know: strings(kn.text),
  };
}

function residue(before, after, prefixes) {
  const out = [];
  const newPages = after.pages.filter((p) => !before.pages.includes(p));
  if (newPages.length) out.push(`pages left behind (${newPages.length}): ${newPages.slice(0, 20).join(', ')}`);
  for (const [label, key] of [['bookmarks', 'bookmarks'], ['know-list', 'know']]) {
    for (const pre of prefixes) {
      if (after[key].includes(pre) && !before[key].includes(pre)) {
        out.push(`${label} still mentions the run prefix ${pre}`);
        break;
      }
    }
  }
  return out;
}

const settle = (ms = 3000) => new Promise((r) => setTimeout(r, ms));

async function cleanup(before) {
  console.log('==> cleanup');
  await raw('POST', `${B}/page-del?${q({ name: P })}`);
  //  page-del pokes the serialised writer and acks before the tree reflects it.
  //  Without this the stray sweep below re-deletes the subtree it just removed.
  await settle();
  //  Anything a hostile name created outside the prefix folder. Diff against
  //  the pre-run snapshot rather than pattern-matching: a fuzzer that only
  //  cleans names it can predict is exactly the fuzzer that leaves residue.
  //  Shallowest first, so deleting a parent cascades and the children below
  //  it become no-ops rather than 404 noise.
  const nodes = await tree();
  const strays = nodes
    .map((n) => n.path)
    .filter((p) => p && !before.pages.includes(p))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  for (const p of strays) await raw('POST', `${B}/page-del?${q({ name: p })}`);
  for (const k of [`${K}/real`, `${K}/big`, `${K}/xss`]) {
    await raw('POST', `${B}/know-delete?${q({ key: k })}`);
  }
  //  know-delete is a soft delete; drop the trash entries too if the route exists
  const kl = await raw('GET', `${B}/know-list`);
  const hits = [...kl.text.matchAll(new RegExp(`"(/?${K}[^"]*)"`, 'g'))].map((m) => m[1]);
  for (const k of new Set(hits)) await raw('POST', `${B}/know-delete?${q({ key: k })}`);
  for (const u of made.marks) await raw('POST', `${B}/unbookmark?${q({ url: u })}`);
  for (const g of made.groups) await raw('POST', `${B}/share-group-del?${q({ name: g })}`);
  //  the ban loop already unbans each ship inline; this catches any that were
  //  banned but whose unban was itself part of the fuzzed input
  for (const s of made.ships) await raw('POST', `${B}/unban?${q({ ship: s })}`);
  await raw('POST', `${B}/page-share-tree?${q({ name: P, mode: 'private' })}`);
  //  let the last writes land before the residue snapshot reads the tree back
  await settle();
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  assertProbesSound();
  console.log(`lattice fuzz-api — ${QUICK ? 'QUICK' : 'FULL'} mode`);
  console.log(`  target: ${URL_BASE}   namespace: ${P}   timeout: ${TIMEOUT_MS}ms\n`);

  if (!await canary('preflight')) {
    console.log('\nship was not healthy before the run started. Aborting.');
    process.exit(2);
  }
  const before = await snapshot();
  await ourShip();

  const families = [famPageSave, famBatch, famStructure, famReads, famSharing,
    famBanlist, famKnow, famBookmarks, famReader, famCmdForms, famMethods];

  for (const f of families) {
    const alive = await f();
    if (!alive || wedged) {
      console.log('\n!! CANARY FAILED — the ship is wedged. Stopping the run without further load.');
      break;
    }
  }

  if (!wedged) await cleanup(before);
  const after = wedged ? before : await snapshot();
  const leftovers = wedged ? ['(skipped: ship wedged)'] : residue(before, after, [P, K, `${P}-mark`]);
  const finalCanary = await canary('final');

  const secs = ((Date.now() - t0run) / 1000).toFixed(1);
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`requests:     ${reqCount}`);
  console.log(`wall clock:   ${secs}s  (${(reqCount ? (Date.now() - t0run) / reqCount : 0).toFixed(0)}ms/req)`);
  console.log(`final canary: ${finalCanary ? 'GREEN' : 'RED'}`);
  console.log(`residue:      ${leftovers.length ? leftovers.join(' | ') : 'none'}`);
  console.log(`findings:     ${findings.length}`);
  if (findings.length) {
    console.log('\nfindings, most severe first:');
    findings.sort((a, b) => a.sev - b.sev).forEach((f, i) => {
      console.log(`\n${i + 1}. [${SEVNAME[f.sev]}] ${f.family}: ${f.title}`);
      console.log(`   repro:    ${f.repro}`);
      console.log(`   observed: ${f.observed}`);
      if (f.why) console.log(`   why:      ${f.why}`);
      if (f.fix) console.log(`   fix:      ${f.fix}`);
    });
  }
  const bad = findings.length > 0 || !finalCanary || leftovers.length > 0;
  console.log(`\nfuzz-api ${bad ? 'FOUND ISSUES' : 'CLEAN'}`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
