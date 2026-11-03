#!/usr/bin/env node
//  writer-odt.mjs: .odt import and export (ui-src/writer/odt.js, plan
//  Task 12), pure node plus LibreOffice headless.
//
//    1. Each corpus .odt imports to a fodt the writer core opens, whose
//       no-op round trip is byte-identical, and whose LibreOffice re-save
//       canonicalizes equal to the corpus .fodt's (the same document).
//    2. Each corpus .fodt exports to an .odt that is STORED with mimetype
//       first, and whose LibreOffice re-save canonicalizes equal to the
//       source's. Importing that export gives the source's canonical form.
//    3. An imported .odt edited in the writer core and saved is read by
//       LibreOffice with the edit in it.
//    4. A zip bomb (honest or lying sizes) is refused, an .odt with
//       pictures imports with a note naming them, and a styles.xml
//       automatic style whose name content.xml also uses is renamed with
//       its references.
//
//  Without soffice the LibreOffice steps skip, unless
//  WRITER_REQUIRE_SOFFICE=1.
//
//  Usage: node scripts/writer-odt.mjs
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateRawSync } from 'zlib';
import { makeCheck } from './lib/check.mjs';
import { importWriter } from './lib/writer-node.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const corpus = join(root, 'tests', 'writer', 'corpus');
const check = makeCheck();
const { importOdt, exportOdt, zipStored, ENTRY_MAX, parseFodt, serializeFodt, applyEdit } =
  await importWriter('odt.js', 'parse.js', 'serialize.js', 'edits.js');

//  scratch beside the corpus, at its depth, so relative links compare
const tmp = join(root, 'tests', 'writer', '.rt-odt');
const made = [tmp];
const dir = (n) => { const d = join(root, 'tests', 'writer', '.rt-odt-' + n); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); made.push(d); return d; };
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

const files = readdirSync(corpus).filter((f) => f.endsWith('.odt')).sort();
check('the corpus has .odt files', files.length >= 10, String(files.length));

// ---------------------------------------------------------------- 1
const imported = dir('imported'), exported = dir('exported'), edited = dir('edited');
for (const f of files) {
  const stem = f.replace(/\.odt$/, '');
  const r = await importOdt(ab(readFileSync(join(corpus, f))));
  if (!check(`${f} imports`, r.text && !r.error, r.error)) continue;
  const p = parseFodt(r.text);
  if (!check(`${f} import opens in the writer`, !p.error, p.error)) continue;
  const s = serializeFodt(p, r.text);
  check(`${f} import no-op round trip is byte-identical`, s && s.text === r.text, s && s.error);
  writeFileSync(join(imported, stem + '.fodt'), r.text);
  // 2
  const src = readFileSync(join(corpus, stem + '.fodt'), 'utf8');
  const e = exportOdt(src);
  if (!check(`${stem}.fodt exports`, e.blob, e.error)) continue;
  const z = await blobBytes(e.blob);
  const dv = new DataView(z.buffer);
  check(`${stem}.odt export starts with a STORED mimetype`, dv.getUint32(0, true) === 0x04034b50 && dv.getUint16(8, true) === 0
    && new TextDecoder().decode(z.subarray(30, 38)) === 'mimetype'
    && new TextDecoder().decode(z.subarray(38, 38 + 39)) === 'application/vnd.oasis.opendocument.text');
  writeFileSync(join(exported, stem + '.odt'), z);
  const back = await importOdt(ab(z));
  check(`${stem} export imports again`, back.text && !parseFodt(back.text).error, back.error);
}

// ---------------------------------------------------------------- 4
{
  const MIME = 'application/vnd.oasis.opendocument.text';
  //  a deflated entry, with its central directory sizes as given
  const deflZip = (name, data, statedSize) => {
    const c = deflateRawSync(data, { level: 9 });
    const blob = zipStored([['mimetype', MIME], [name, c]]);
    return blob.arrayBuffer().then((ab) => {
      const u = new Uint8Array(ab), v = new DataView(ab);
      //  turn the second entry into a deflated one with the stated size
      const l2 = 30 + 8 + MIME.length;
      v.setUint16(l2 + 8, 8, true);
      v.setUint32(l2 + 22, statedSize, true);
      let p = v.getUint32(u.length - 6, true);
      p += 46 + 8;
      v.setUint16(p + 10, 8, true);
      v.setUint32(p + 24, statedSize, true);
      return ab;
    });
  };
  const big = new Uint8Array(60 * 1024 * 1024);
  const comp = deflateRawSync(big, { level: 9 }).length;
  check('the bomb is small and inflates past 50 MB', comp < 80 * 1024, comp + ' bytes');
  let r = await importOdt(await deflZip('content.xml', big, big.length));
  check('a zip bomb stating its size is refused', r.error && /too large/.test(r.error), r.error || 'imported');
  r = await importOdt(await deflZip('content.xml', big, 1000));
  check('a zip bomb lying about its size is refused', r.error && /inflates past/.test(r.error), r.error || 'imported');
  check('the entry cap is far below the bomb', ENTRY_MAX < big.length);
  r = await importOdt(await deflZip('content.xml', new TextEncoder().encode('<x/>'), 4));
  check('a deflated entry that is not ODF is refused with a reason', r.error && /office:document-content/.test(r.error), r.error);
  r = await importOdt(new TextEncoder().encode('not a zip').buffer);
  check('a file that is not a zip is refused', r.error && /not a zip/.test(r.error), r.error);

  //  pictures: the corpus 01 .odt with two pictures added
  const one = readFileSync(join(corpus, '01-paragraphs.odt'));
  const withPics = join(tmp, 'pics.odt');
  writeFileSync(withPics, one);
  execFileSync('python3', ['-I', '-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'a')
z.writestr('Pictures/cat.png', b'\\x89PNG fake')
z.writestr('Pictures/dog.jpg', b'fake')
z.close()`, withPics]);
  r = await importOdt(ab(readFileSync(withPics)));
  check('an .odt with pictures imports', r.text && !r.error, r.error);
  check('the note names the pictures left out', /left out 2 pictures \(cat\.png, dog\.jpg\)/.test(r.note || ''), r.note);
  r = await importOdt(ab(one));
  check('an .odt without pictures has no note', r.text && !r.note, r.note);

  //  the tiny-inflate fallback, for a browser with no DecompressionStream
  {
    const DS = globalThis.DecompressionStream;
    delete globalThis.DecompressionStream;
    try {
      const a = await importOdt(ab(readFileSync(join(corpus, '10-unknown.odt'))));
      globalThis.DecompressionStream = DS;
      const b = await importOdt(ab(readFileSync(join(corpus, '10-unknown.odt'))));
      check('without DecompressionStream, tiny-inflate imports the same document', a.text && a.text === b.text, a.error);
      delete globalThis.DecompressionStream;
      const bomb = await importOdt(await deflZip('content.xml', big, 1000));
      check('and the lying zip bomb is still refused', !!bomb.error, bomb.text && 'imported ' + bomb.text.length);
      //  stated to end where a whole content.xml does, with more after it
      const whole = '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>';
      const tail = await importOdt(await deflZip('content.xml', new TextEncoder().encode(whole + ' '.repeat(5000)), whole.length));
      check('and an entry inflating past its stated size is refused, not cut short', tail.error && /inflates past/.test(tail.error), tail.error || 'imported');
    } finally { globalThis.DecompressionStream = DS; }
  }

  //  a styles.xml automatic style named like one of content.xml's
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"';
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text><text:p text:style-name="P1">body</text:p></office:text></office:body></office:document-content>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NS}><office:styles/><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-style="italic"/></style:style><style:page-layout style:name="pm1"/></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"><style:header><text:p text:style-name="P1">head</text:p></style:header></style:master-page></office:master-styles></office:document-styles>`;
  const clash = await (zipStored([['mimetype', MIME], ['content.xml', content], ['styles.xml', styles]])).arrayBuffer();
  r = await importOdt(clash);
  const t = r.text || '';
  check('a clashing styles.xml automatic style imports', t && !r.error, r.error);
  check('it is renamed', /<style:style style:name="MP1_1" style:family="paragraph"><style:text-properties fo:font-style="italic"/.test(t), t.slice(0, 400));
  check('its master-page reference follows', t.includes('<style:header><text:p text:style-name="MP1_1">head'));
  check("content.xml's own P1 is untouched", t.includes('<text:p text:style-name="P1">body') && /style:name="P1" style:family="paragraph"><style:text-properties fo:font-weight="bold"/.test(t));
  check('a name that does not clash is kept', t.includes('style:page-layout-name="pm1"') && t.includes('style:name="pm1"'));

  //  Basic: a module listed many times is read once, and what Basic holds
  //  counts toward the document cap
  const lc = '<?xml version="1.0"?><library:libraries xmlns:library="http://openoffice.org/2000/library"><library:library library:name="L&amp;&quot;1" library:link="false"/></library:libraries>';
  const lb = (n) => '<?xml version="1.0"?><library:library xmlns:library="http://openoffice.org/2000/library" library:name="L">' + '<library:element library:name="M"/>'.repeat(n) + '</library:library>';
  const mod = (code) => '<?xml version="1.0"?><script:module xmlns:script="http://openoffice.org/2000/script" script:name="M">' + code + '</script:module>';
  const bz = (n, code) => zipStored([['mimetype', MIME], ['content.xml', content], ['Basic/script-lc.xml', lc], ['Basic/L&"1/script-lb.xml', lb(n)], ['Basic/L&"1/M.xml', mod(code)]]).arrayBuffer();
  r = await importOdt(await bz(3, 'Sub Main'));
  check('a Basic module listed three times is embedded once', r.text && (r.text.match(/<ooo:module /g) || []).length === 1, r.error || r.text);
  check('a Basic library name is escaped', r.text && r.text.includes('ooo:name="L&amp;&quot;1"'), r.error);
  r = await importOdt(await bz(1, 'x'.repeat(9 * 1024 * 1024)));
  check('a Basic module past the document cap is refused', r.error && /too large/.test(r.error), r.error || 'imported');
}

// ---------------------------------------------------------------- LibreOffice
const soffice = ['soffice', 'libreoffice'].find((c) => spawnSync('which', [c]).status === 0);
if (!soffice) {
  const why = 'LibreOffice (soffice) is not on PATH';
  if (process.env.WRITER_REQUIRE_SOFFICE === '1') check.bad('LibreOffice steps', why);
  else console.log('  skip - LibreOffice steps: ' + why);
} else {
  const profile = join(tmp, 'profile');
  const lo = (outdir, inputs) => spawnSync(soffice, [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
    '--convert-to', 'fodt:OpenDocument Text Flat XML', '--outdir', outdir, ...inputs], { stdio: 'ignore', timeout: 900_000 });
  //  (spawnSync: a file LibreOffice cannot read shows as a failed check below)
  const canon = (path) => execFileSync('python3', [join(here, 'writer-corpus', 'canon.py'), path], { maxBuffer: 1 << 28 }).toString();
  const stems = files.map((f) => f.replace(/\.odt$/, ''));
  const O = dir('lo-orig'), I = dir('lo-imported'), E = dir('lo-exported'), D = dir('lo-edited');
  lo(O, stems.map((s) => join(corpus, s + '.fodt')));
  lo(I, stems.map((s) => join(imported, s + '.fodt')));
  lo(E, stems.map((s) => join(exported, s + '.odt')));
  //  LibreOffice's own .odt of each document: some releases (24.2) read a
  //  package and a flat file of the same document differently
  const N = dir('lo-native');
  lo(N, stems.map((s) => join(corpus, s + '.odt')));
  //  3: an edit to the imported document, saved by the writer core
  const edits = JSON.parse(readFileSync(join(corpus, 'edits.json'), 'utf8'));
  const editedStems = [];
  for (const s of stems) {
    const ed = edits[s + '.fodt'];
    if (!ed) continue;
    const text = readFileSync(join(imported, s + '.fodt'), 'utf8');
    const p = parseFodt(text);
    if (p.error) continue;
    const st = applyEdit(p, ed);
    const out = st && !st.error && serializeFodt(st, text);
    if (out && out.text) { writeFileSync(join(edited, s + '.fodt'), out.text); editedStems.push([s, ed]); }
  }
  if (editedStems.length) execFileSync(soffice, [`-env:UserInstallation=file://${profile}`, '--headless', '--norestore',
    '--convert-to', 'txt:Text (encoded):UTF8', '--outdir', D, ...editedStems.map(([s]) => join(edited, s + '.fodt'))], { stdio: 'ignore', timeout: 900_000 });
  for (const s of stems) {
    let want;
    try { want = canon(join(O, s + '.fodt')); } catch (e) { check.bad(`${s} canonicalizes`, String(e).slice(0, 200)); continue; }
    let got = '';
    try { got = canon(join(I, s + '.fodt')); } catch {}
    check(`${s}.odt imported equals the corpus .fodt (canonical, after LibreOffice)`, got === want, firstDiff(got, want));
    try { got = canon(join(E, s + '.fodt')); } catch { got = ''; }
    let native = '';
    if (got !== want) try { native = canon(join(N, s + '.fodt')); } catch {}
    check(`${s}.fodt exported as .odt equals the source (canonical, after LibreOffice${native && got === native ? ", as LibreOffice's own .odt of it reads" : ''})`,
      got === want || (native !== want && got === native), firstDiff(got, want));
  }
  for (const [s, ed] of editedStems) {
    let lines = [];
    try { lines = readFileSync(join(D, s + '.txt'), 'utf8').replace(/\r/g, '').split('\n'); } catch {}
    const add = (ed.txt && ed.txt.add) || [];
    check(`${s} imported, edited in the writer and read by LibreOffice has the edit`,
      //  (LibreOffice 24.2 writes a table row's cells one per line, 26.8 on one line with tabs)
      lines.length > 0 && add.every((l) => lines.includes(l) || l.split('\t').every((c) => lines.includes(c))), JSON.stringify(add));
  }
  console.log(`# ${editedStems.length} imported documents edited and read back by LibreOffice`);
}
function firstDiff(a, b) {
  if (a === b) return '';
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: got ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))} want ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`;
}

if (!process.env.KEEP) for (const d of made) rmSync(d, { recursive: true, force: true });
check.done();
