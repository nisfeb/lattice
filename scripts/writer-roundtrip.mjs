#!/usr/bin/env node
//  writer-roundtrip.mjs: the Writer round-trip harness. Pure node, no ship.
//
//  For every file in tests/writer/corpus/ (plan, Corpus):
//
//    0. Features.  The file holds everything features.json says it covers.
//    1. No-op.     Parse with the writer core, serialize, byte-identical.
//    2. Edit.      Apply edits.json's scripted edit, serialize. Every opaque
//                  element and the head (bar automatic-style additions)
//                  appear verbatim in the output.
//    3. LibreOffice reads it. soffice --headless re-saves the original and
//                  the candidate as fodt, and exports both as txt.
//    4. No loss.   canon.py on both re-saves: per-element counts equal,
//                  bar what the edit adds, and the txt diff is exactly the
//                  edit's text change. With no edit the canonical forms
//                  must be identical.
//    5. Lattice reads LibreOffice's save. The core opens the re-save of
//                  the edited file, the edit is in it, and its own no-op
//                  round trip is byte-identical.
//    6. PDF.       The original and the no-op output print to the same
//                  number of pages.
//
//  Steps 1, 2 and 5 run the writer core (ui-src/writer/parse.js,
//  serialize.js and edits.js, plan Task 8). Without it they would skip,
//  and the candidate for steps 3, 4 and 6 would be the original itself.
//
//  Needs python3 and LibreOffice (soffice). Without soffice steps 3, 4 and
//  6 skip, unless WRITER_REQUIRE_SOFFICE=1 (CI sets it), which fails.
//
//  Usage: node scripts/writer-roundtrip.mjs [--only 03-inline,10-unknown]
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { makeCheck } from './lib/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpus = join(root, 'tests', 'writer', 'corpus');
const canonPy = join(here, 'writer-corpus', 'canon.py');
const check = makeCheck();

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(',').map((s) => s.replace(/\.fodt$/, '') + '.fodt')) : null;

const features = JSON.parse(readFileSync(join(corpus, 'features.json'), 'utf8'));
const edits = JSON.parse(readFileSync(join(corpus, 'edits.json'), 'utf8'));
const files = readdirSync(corpus).filter((f) => f.endsWith('.fodt')).sort()
  .filter((f) => !only || only.has(f));

const skip = (step, why) => console.log(`  skip - ${step}: ${why}`);

// ---------------------------------------------------------------- 0. features
console.log('# 0. corpus features');
const has = (text, pat) => {
  if (pat.startsWith('@')) {
    const [name, ...rest] = pat.slice(1).split('=');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!rest.length) return new RegExp(`\\s${esc(name)}="`).test(text);
    return text.includes(` ${name}="${rest.join('=')}"`);
  }
  if (/^[A-Za-z][\w-]*(:[\w-]+)?$/.test(pat)) return new RegExp(`<${pat.replace(/[.-]/g, '\\$&')}[\\s>/]`).test(text);
  return text.includes(pat);
};
for (const [name, want] of Object.entries(features)) {
  if (name.startsWith('_')) continue;
  if (only && !only.has(name)) continue;
  const path = join(corpus, name);
  if (!Array.isArray(want)) {
    if (!existsSync(path)) { skip(name, 'pending: ' + want.pending); continue; }
  }
  if (!check(`${name} exists`, existsSync(path))) continue;
  const text = readFileSync(path, 'utf8');
  for (const pat of Array.isArray(want) ? want : want.needs) {
    const neg = pat.startsWith('!');
    const p = neg ? pat.slice(1) : pat;
    check(`${name} ${neg ? 'lacks' : 'has'} ${JSON.stringify(p)}`, has(text, p) !== neg);
  }
}
for (const f of files) check(`${f} is listed in features.json`, f in features);
for (const f of files) check(`${f} has a scripted edit in edits.json`, f in edits || f.startsWith('14-'));
const ver = existsSync(join(corpus, 'VERSION')) ? readFileSync(join(corpus, 'VERSION'), 'utf8').trim() : '';
check('corpus VERSION names the LibreOffice that saved it', /^LibreOffice \d/.test(ver), ver);

// ---------------------------------------------------------------- the core
//  writer-node.mjs resolves the core's bare prosemirror-* imports from
//  scripts/node_modules (npm ci --prefix scripts)
let core = null;
const coreFiles = ['parse.js', 'serialize.js'].map((f) => join(root, 'ui-src', 'writer', f));
if (coreFiles.every(existsSync)) {
  const { importWriter } = await import('./lib/writer-node.mjs');
  core = await importWriter('parse.js', 'serialize.js');
  if (existsSync(join(root, 'ui-src', 'writer', 'edits.js'))) Object.assign(core, await importWriter('edits.js'));
}
const noCore = 'needs the writer core (ui-src/writer/parse.js, serialize.js), plan Task 8';

// ---------------------------------------------------------------- 1, 2
//  LibreOffice rewrites relative links relative to where it saves, so
//  every directory a file is read from or saved to sits beside the corpus
//  (tests/writer/.rt-*), at the corpus's depth, and is removed at the end.
const writerDir = dirname(corpus);
const made = [];
const sib = (name) => { const p = mkdtempSync(join(writerDir, `.rt-${name}-`)); made.push(p); return p; };
const cleanup = () => made.forEach((p) => rmSync(p, { recursive: true, force: true }));
process.on('exit', cleanup);
const tmp = mkdtempSync(join(tmpdir(), 'writer-rt-'));
made.push(tmp);
const cand = { noop: sib('noop'), edit: sib('edit') };
const noopOf = {};
const editOf = {};

console.log('# 1. no-op round trip through the writer core');
if (!core) skip('every file', noCore);
for (const f of files) {
  const orig = readFileSync(join(corpus, f), 'utf8');
  if (!core) { noopOf[f] = join(corpus, f); continue; }
  const parsed = core.parseFodt(orig);
  if (!check(`${f} parses`, parsed && !parsed.error, parsed?.error)) continue;
  const out = core.serializeFodt(parsed, orig);
  if (!check(`${f} serializes`, out && !out.error, out?.error)) continue;
  check(`${f} no-op output is byte-identical`, out.text === orig);
  noopOf[f] = join(cand.noop, f);
  writeFileSync(noopOf[f], out.text);
}

console.log('# 2. scripted edit');
if (!core) skip('every file', noCore);
for (const f of files) {
  const e = edits[f];
  if (!core) continue;
  if (!e) { skip(f, 'no scripted edit'); continue; }
  if (!core.applyEdit) { check.bad(`${f} edit`, 'the core has no applyEdit (ui-src/writer/edits.js)'); continue; }
  const orig = readFileSync(join(corpus, f), 'utf8');
  const parsed = core.parseFodt(orig);
  const edited = core.applyEdit(parsed, e);
  if (!check(`${f} edit applies`, edited && !edited.error, edited?.error)) continue;
  const out = core.serializeFodt(edited, orig);
  if (!check(`${f} edited document serializes`, out && !out.error, out?.error)) continue;
  const head = orig.slice(0, orig.indexOf('<office:automatic-styles>'));
  check(`${f} head before automatic styles is verbatim`, out.text.startsWith(head));
  for (const raw of parsed.opaque || []) {
    if (!out.text.includes(raw)) { check.bad(`${f} opaque element kept verbatim`, raw.slice(0, 80)); break; }
  }
  editOf[f] = join(cand.edit, f);
  writeFileSync(editOf[f], out.text);
}

// ---------------------------------------------------------------- 3, 4, 6
const soffice = ['soffice', 'libreoffice'].find((c) => spawnSync('which', [c]).status === 0);
const profile = join(tmp, 'profile');
const lo = (fmt, outdir, inputs) => {
  if (!inputs.length) return;
  execFileSync(soffice, [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
    '--convert-to', fmt, '--outdir', outdir, ...inputs], { stdio: 'ignore', timeout: 900_000 });
};
const canon = (path) => execFileSync('python3', [canonPy, path], { maxBuffer: 1 << 28 }).toString();
const counts = (text) => {
  const c = {};
  for (const m of text.matchAll(/<([A-Za-z_][\w.-]*:[\w.-]+|[A-Za-z_][\w.-]*)[\s>/]/g)) c[m[1]] = (c[m[1]] || 0) + 1;
  return c;
};
const txtLines = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  .filter((l, i, a) => i < a.length - 1 || l !== '');
const pdfPages = (path) => (readFileSync(path, 'latin1').match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
const minus = (a, b) => {
  const m = new Map();
  b.forEach((l) => m.set(l, (m.get(l) || 0) + 1));
  return a.filter((l) => { const n = m.get(l) || 0; if (n) { m.set(l, n - 1); return false; } return true; });
};

if (!soffice) {
  const why = 'LibreOffice (soffice) is not on PATH';
  if (process.env.WRITER_REQUIRE_SOFFICE === '1') check.bad('steps 3, 4 and 6', why);
  else ['# 3', '# 4', '# 6'].forEach((s) => skip(s, why));
} else {
  const d = sib;
  const O = { fodt: d('o-fodt'), txt: d('o-txt'), pdf: d('o-pdf') };
  const N = { fodt: d('n-fodt'), txt: d('n-txt'), pdf: d('n-pdf') };
  const E = { fodt: d('e-fodt'), txt: d('e-txt') };
  const loVer = execFileSync(soffice, [`-env:UserInstallation=file://${profile}`, '--version']).toString().trim();
  const rel = (v) => (v.match(/LibreOffice (\d+\.\d+)/) || [])[1];
  const sameLo = rel(loVer) && rel(loVer) === rel(ver);
  console.log(`# ${loVer}; the corpus was saved by ${ver}`);
  if (!sameLo) skip('the corpus fixed-point check', `it needs LibreOffice ${rel(ver)}, this is ${rel(loVer)}`);
  const origs = files.map((f) => join(corpus, f));
  const noops = files.map((f) => noopOf[f]).filter(Boolean);
  const editsDone = files.filter((f) => editOf[f]);
  const t0 = Date.now();
  //  the no-op candidates are written under the corpus file names, so each
  //  set goes to its own directory
  lo('fodt:OpenDocument Text Flat XML', O.fodt, origs);
  lo('txt:Text (encoded):UTF8', O.txt, origs);
  lo('pdf:writer_pdf_Export', O.pdf, origs);
  if (core) {
    lo('fodt:OpenDocument Text Flat XML', N.fodt, noops);
    lo('txt:Text (encoded):UTF8', N.txt, noops);
    lo('pdf:writer_pdf_Export', N.pdf, noops);
  } else {
    //  no core: the no-op candidate is the original, and its LibreOffice
    //  reading is the re-save's, so step 4 compares original and re-save
    lo('txt:Text (encoded):UTF8', N.txt, files.map((f) => join(O.fodt, f)));
    lo('pdf:writer_pdf_Export', N.pdf, files.map((f) => join(O.fodt, f)));
  }
  lo('fodt:OpenDocument Text Flat XML', E.fodt, editsDone.map((f) => editOf[f]));
  lo('txt:Text (encoded):UTF8', E.txt, editsDone.map((f) => editOf[f]));
  console.log(`# LibreOffice conversions took ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  console.log('# 3. LibreOffice opens and re-saves each file');
  for (const f of files) {
    const n = basename(f, '.fodt');
    check(`${f} original re-saves as fodt`, existsSync(join(O.fodt, f)));
    check(`${f} original exports as txt`, existsSync(join(O.txt, n + '.txt')));
    check(`${f} no-op candidate exports as txt`, existsSync(join(N.txt, n + '.txt')));
    if (core) check(`${f} no-op candidate re-saves as fodt`, existsSync(join(N.fodt, f)));
    if (editOf[f]) {
      check(`${f} edited document re-saves as fodt`, existsSync(join(E.fodt, f)));
      check(`${f} edited document exports as txt`, existsSync(join(E.txt, n + '.txt')));
    }
  }

  console.log('# 4. no loss through LibreOffice');
  for (const f of files) {
    const n = basename(f, '.fodt');
    if (!existsSync(join(O.fodt, f))) continue;
    const same = (label, a, b) => {
      const ca = counts(a); const cb = counts(b);
      const diff = Object.keys({ ...ca, ...cb }).filter((k) => ca[k] !== cb[k]);
      check(`${f} ${label}: element counts equal`, !diff.length,
        diff.slice(0, 6).map((k) => `${k} ${ca[k] || 0}->${cb[k] || 0}`).join(', '));
      let at = 0; while (at < a.length && a[at] === b[at]) at++;
      check(`${f} ${label}: canonical forms identical`, a === b,
        `first difference at ${at}: ${JSON.stringify(a.slice(at, at + 60))} vs ${JSON.stringify(b.slice(at, at + 60))}`);
    };
    const reOrig = canon(join(O.fodt, f));
    //  the corpus is saved at LibreOffice's fixed point, so this
    //  LibreOffice's re-save of it changes nothing, when it is the same
    //  release that saved the corpus (an older or newer one writes other
    //  defaults, which is not loss)
    if (sameLo) same('a LibreOffice re-save of the original', canon(join(corpus, f)), reOrig);
    //  both sides through this LibreOffice: the plan's no-loss check,
    //  independent of the LibreOffice release
    if (core && existsSync(join(N.fodt, f))) same('no-op through the core and LibreOffice', reOrig, canon(join(N.fodt, f)));
    const ot = join(O.txt, n + '.txt'); const nt = join(N.txt, n + '.txt');
    if (existsSync(ot) && existsSync(nt)) {
      const A = txtLines(ot); const B = txtLines(nt);
      check(`${f} no-op: text export unchanged`, A.join('\n') === B.join('\n'),
        `removed ${JSON.stringify(minus(A, B).slice(0, 2))} added ${JSON.stringify(minus(B, A).slice(0, 2))}`);
    }
    if (!editOf[f]) continue;
    const e = edits[f];
    const ef = join(E.fodt, f);
    if (!existsSync(ef)) continue;
    const ca = counts(canon(join(O.fodt, f))); const ce = counts(canon(ef));
    const bad = Object.keys({ ...ca, ...ce }).filter((k) => (ce[k] || 0) !== (ca[k] || 0) + (e.adds?.[k] || 0));
    check(`${f} edit: element counts change only by what the edit adds`, !bad.length,
      bad.slice(0, 6).map((k) => `${k} ${ca[k] || 0}->${ce[k] || 0} (adds ${e.adds?.[k] || 0})`).join(', '));
    const A = txtLines(join(O.txt, n + '.txt')); const B = txtLines(join(E.txt, n + '.txt'));
    const rem = minus(A, B).sort(); const add = minus(B, A).sort();
    check(`${f} edit: text export changes by exactly the edit`,
      JSON.stringify(rem) === JSON.stringify([...e.txt.remove].sort()) && JSON.stringify(add) === JSON.stringify([...e.txt.add].sort()),
      `removed ${JSON.stringify(rem)} added ${JSON.stringify(add)}`);
  }

  console.log('# 5. lattice opens what LibreOffice saved');
  if (!core) skip('every file', noCore);
  for (const f of files) {
    if (!core) continue;
    const ef = join(E.fodt, f);
    if (!existsSync(ef)) { skip(f, 'no edited re-save'); continue; }
    const text = readFileSync(ef, 'utf8');
    const parsed = core.parseFodt(text);
    if (!check(`${f} LibreOffice re-save of the edit parses`, parsed && !parsed.error, parsed?.error)) continue;
    const e = edits[f];
    //  the words the edit put in, not LibreOffice's txt line, which adds
    //  list labels and outline numbers and joins table cells with tabs
    const wants = (e.cells ?? [e.text ?? e.word]).filter(Boolean).map((w) => w.trim());
    const words = core.fodtText(text);
    check(`${f} the edit is in LibreOffice's re-save`, wants.every((w) => words.includes(w)), JSON.stringify(wants));
    const out = core.serializeFodt(parsed, text);
    check(`${f} LibreOffice re-save no-op round trip is byte-identical`, out && out.text === text);
  }

  console.log('# 6. PDF page counts');
  for (const f of files) {
    const n = basename(f, '.fodt');
    const a = join(O.pdf, n + '.pdf'); const b = join(N.pdf, n + '.pdf');
    if (!check(`${f} prints to PDF`, existsSync(a) && existsSync(b))) continue;
    const pa = pdfPages(a); const pb = pdfPages(b);
    check(`${f} no-op output prints to the same page count (${pa})`, pa > 0 && pa === pb, `${pa} vs ${pb}`);
  }
}

check.done();
