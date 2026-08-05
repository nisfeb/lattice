#!/usr/bin/env node
// Unit tests for the vault export's tar writer (ui-app/src/78-export.js).
//
// A tar writer is exactly the kind of code that looks fine and produces an
// archive nobody can open two years later when they need it. So this does not
// assert on our own bytes. It writes real archives, hands them to the system's
// real tar, and compares what comes back out against what went in.
//
// The interesting cases are the ones a hand test never reaches: a body with
// non-ascii in it (the header declares a BYTE count, not a character count)
// and a path too long for the 100 byte name field.
//
// Usage:  node scripts/ui-vaultar.mjs

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, '../grubbery-overlay/nex/lattice/ui-app/src/78-export.js'), 'utf8');

// the pure half only: everything from the encoder down to the end of tarBlob.
// The rest of the file talks to the ship and the DOM.
const a = src.indexOf('const te = new TextEncoder();');
const b = src.indexOf('//  ~2026.');
if (a < 0 || b < 0) { console.error('could not find the tar writer in 78-export.js'); process.exit(2); }
const { tarBlob, splitName } =
  new Function(`${src.slice(a, b)}\nreturn { tarBlob, splitName };`)();

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) console.log('  ok   - ' + name);
  else { console.log(`  FAIL - ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(got)}`); fails++; }
};

let tar = 'tar';
try { execFileSync(tar, ['--version'], { stdio: 'ignore' }); }
catch { console.error('no tar on PATH, cannot verify archives'); process.exit(2); }

// Write the archive, unpack it with the real tar, and read back every file.
async function roundTrip(files) {
  const dir = mkdtempSync(join(tmpdir(), 'vaultar-'));
  const arc = join(dir, 'v.tar');
  writeFileSync(arc, Buffer.from(await tarBlob(files).arrayBuffer()));
  const out = join(dir, 'out');
  execFileSync('mkdir', ['-p', out]);
  execFileSync(tar, ['xf', arc, '-C', out]);
  const seen = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else seen.set(relative(out, p), readFileSync(p, 'utf8'));
    }
  };
  walk(out);
  rmSync(dir, { recursive: true, force: true });
  return seen;
}

const MT = 1750000000;

console.log('the ustar name split');
eq('a short path needs no prefix', JSON.stringify(splitName('pages/notes.md')), '["","pages/notes.md"]');
eq('a long path splits at a slash', splitName('pages/' + 'a'.repeat(60) + '/' + 'b'.repeat(60))[1],
  'b'.repeat(60));
// no slash late enough to split at: the writer must fall back, not truncate
eq('one unsplittable name reports it', splitName('pages/' + 'x'.repeat(200)), null);

console.log('\nround trips through the system tar');
{
  const files = [
    { name: 'pages/plain.md', body: '# hello\n', mtime: MT },
    { name: 'pages/deep/nest/ed/file.md', body: 'nested\n', mtime: MT },
  ];
  const got = await roundTrip(files);
  eq('a plain file comes back byte for byte', got.get('pages/plain.md'), '# hello\n');
  eq('a nested path is preserved', got.get('pages/deep/nest/ed/file.md'), 'nested\n');
  eq('nothing extra appears', got.size, 2);
}

console.log('\nnon-ascii bodies (the size field is BYTES, not characters)');
{
  // "héllo ⚡ 日本" is 12 characters and 20 bytes. A writer that declared 12
  // would leave the archive desynchronised from this entry onward, so the
  // NEXT file is the one that proves it: it has to survive too.
  const body = 'héllo ⚡ 日本\n';
  const got = await roundTrip([
    { name: 'pages/utf8.md', body, mtime: MT },
    { name: 'pages/after.md', body: 'still here\n', mtime: MT },
  ]);
  eq('a utf-8 body round-trips', got.get('pages/utf8.md'), body);
  eq('and the entry after it is not corrupted', got.get('pages/after.md'), 'still here\n');
}

console.log('\npaths too long for the 100 byte name field');
{
  //  fits with a prefix
  const long = 'pages/' + 'dir'.repeat(20) + '/' + 'leaf'.repeat(15) + '.md';
  //  no slash late enough for a prefix split: needs the GNU longname record
  const huge = 'pages/' + 'z'.repeat(240) + '.md';
  const got = await roundTrip([
    { name: long, body: 'long\n', mtime: MT },
    { name: huge, body: 'huge\n', mtime: MT },
    { name: 'pages/last.md', body: 'last\n', mtime: MT },
  ]);
  eq('a long path survives via the ustar prefix', got.get(long), 'long\n');
  eq('an unsplittable path survives via @LongLink', got.get(huge), 'huge\n');
  eq('and the archive is still readable after both', got.get('pages/last.md'), 'last\n');
}

console.log('\nempty and edge bodies');
{
  const got = await roundTrip([
    { name: 'pages/empty.md', body: '', mtime: MT },
    { name: 'pages/exact.md', body: 'x'.repeat(512), mtime: MT },
    { name: 'pages/tail.md', body: 'tail\n', mtime: MT },
  ]);
  eq('an empty file round-trips', got.get('pages/empty.md'), '');
  // a body that is exactly one block adds no padding. Getting that wrong
  // shifts every following header by 512 bytes.
  eq('a body of exactly one block does not shift the next header',
    got.get('pages/exact.md'), 'x'.repeat(512));
  eq('and the file after it is intact', got.get('pages/tail.md'), 'tail\n');
}

console.log('\nmodification times are carried, not invented');
{
  const dir = mkdtempSync(join(tmpdir(), 'vaultar-'));
  const arc = join(dir, 'v.tar');
  writeFileSync(arc, Buffer.from(
    await tarBlob([{ name: 'pages/t.md', body: 'x\n', mtime: MT }]).arrayBuffer()));
  const out = join(dir, 'out');
  execFileSync('mkdir', ['-p', out]);
  execFileSync(tar, ['xf', arc, '-C', out]);
  eq('the mtime we asked for is the mtime on disk',
    Math.floor(statSync(join(out, 'pages/t.md')).mtimeMs / 1000), MT);
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
