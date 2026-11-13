#!/usr/bin/env node
//  scad-unit.mjs: the pure parts of scad.js, in node. No ship, no browser.
//
//    - the customizer parser against OpenSCAD's own reading of each fixture
//      in tests/scad/customizer (the .json beside it, made by
//      scripts/scad-corpus/expect.mjs with --export-format param)
//    - the one-line rewrite a customizer change makes, and its -D form
//    - include resolution: paths stay inside lattice, and caps stop a
//      runaway or hostile include tree
//    - the STL reader, and its triangle cap
//
//  Usage: node scripts/scad-unit.mjs
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';
import { parseParams, rewriteLine, fmtValue, defineArg, parseLiteral } from '../ui-src/scad/customizer.js';
import { scanIncludes, resolveRef, collect } from '../ui-src/scad/includes.js';
import { parseStl, MAX_TRIS } from '../ui-src/scad/stl.js';

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, '..', 'tests', 'scad', 'customizer');
const check = makeCheck();

console.log('customizer: lattice reads what OpenSCAD reads');
for (const f of readdirSync(FX).filter((n) => n.endsWith('.scad')).sort()) {
  const src = readFileSync(join(FX, f), 'utf8');
  const want = JSON.parse(readFileSync(join(FX, f.replace(/\.scad$/, '.json')), 'utf8')).parameters;
  const got = parseParams(src);
  check.eq(`${f}: the same parameters, in order`, got.map((p) => p.name).join(' '), want.map((p) => p.name).join(' '));
  for (const w of want) {
    const g = got.find((p) => p.name === w.name);
    if (!g) continue;
    const mine = {
      group: g.group, initial: g.value, type: g.type,
      caption: g.description || undefined, min: g.min, max: g.max, step: g.step,
      options: g.options && g.options.map((x) => ({ name: x.name, value: x.value })),
      maxLength: g.maxLength,
    };
    const theirs = {
      group: w.group, initial: w.initial, type: w.type,
      caption: w.caption === undefined ? undefined : w.caption.trim() || undefined,
      min: w.min, max: w.max, step: w.step,
      options: w.options && w.options.map((x) => ({ name: x.name, value: x.value })),
      maxLength: w.maxLength,
    };
    const bad = Object.keys(theirs).filter((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs[k]));
    check(`${f}: ${w.name}`, !bad.length, bad.map((k) => `${k}: lattice ${JSON.stringify(mine[k])}, OpenSCAD ${JSON.stringify(theirs[k])}`).join('; '));
  }
}

{
  //  the new page's template is the box fixture, so OpenSCAD's own reading
  //  of it above covers the template too
  const blank = readFileSync(join(here, '..', 'ui-src', 'scad', 'blank.scad'), 'utf8');
  check.eq('the new page template is tests/scad/customizer/box.scad', blank, readFileSync(join(FX, 'box.scad'), 'utf8'));
  check.eq('  with three customizer variables', parseParams(blank).length, 3);
}

console.log('\ncustomizer: a change rewrites only the value');
{
  const src = 'width = 30; // [10:100]\nlabel = "a \\"b\\""; // [8]\nflag=true;\nv = [1, 2, 3];\nwall = 2; // [0.8:0.2:6]\n';
  const ps = parseParams(src);
  const L = src.split('\n');
  const p = (n) => ps.find((q) => q.name === n);
  check.eq('a number', rewriteLine(L[0], p('width'), 45), 'width = 45; // [10:100]');
  check.eq('a string keeps its quotes and escapes', rewriteLine(L[1], p('label'), 'say "hi" \\ there'), 'label = "say \\"hi\\" \\\\ there"; // [8]');
  check.eq('the string read back is the value', parseLiteral(rewriteLine(L[1], p('label'), 'say "hi" \\ there').slice(8, -8)), 'say "hi" \\ there');
  check.eq('a boolean, with no spaces to keep', rewriteLine(L[2], p('flag'), false), 'flag=false;');
  check.eq('a vector', rewriteLine(L[3], p('v'), [4, 5.5, 6]), 'v = [4, 5.5, 6];');
  check.eq('a decimal step writes no float noise', rewriteLine(L[4], p('wall'), 0.8 + 0.2 * 7), 'wall = 2.2; // [0.8:0.2:6]');
  check.eq('a line that changed is not written', rewriteLine('width = 31; // [10:100]', p('width'), 45), null);
  check.eq('a -D argument', defineArg(p('width'), 45), 'width=45');
  check.eq('a -D string argument', defineArg(p('label'), 'x"y'), 'label="x\\"y"');
  check.eq('fmtValue of a big integer', fmtValue(123456789), '123456789');
  check.eq('fmtValue of a float with no step', fmtValue(0.1 + 0.2), '0.3');
  check.eq('fmtValue of NaN writes a number', fmtValue(NaN), '0');
  const mixed = parseParams('a = 1; b = 2; // [0:10]\n');
  check.eq('two on a line are two parameters', mixed.map((q) => q.name).join(','), 'a,b');
  check.eq('  and the second rewrites only itself', rewriteLine('a = 1; b = 2; // [0:10]', mixed[1], 7), 'a = 1; b = 7; // [0:10]');
  check.eq('a parameter in a block comment is none', parseParams('/*\nx = 1;\n*/\ny = 2;\n').map((q) => q.name).join(), 'y');
  check.eq('a brace in a string does not end the top level', parseParams('s = "{";\nt = 3;\n').map((q) => q.name).join(), 's,t');
  check.eq('nothing after the first function', parseParams('a = 1;\nfunction f(x) = x;\nb = 2;\n').map((q) => q.name).join(), 'a');
  check.eq('a name set twice is read at its last line', parseParams('a = 1;\na = 2;\n')[0].line, 1);
  check.eq('CRLF lines', parseParams('a = 1; // [0:9]\r\nb = 2;\r\n').map((q) => `${q.name}:${q.max}`).join(), 'a:9,b:undefined');
  //  a hostile source: long, unbalanced, odd bytes. It must answer, fast.
  const t0 = Date.now();
  const huge = 'x = 1; // [' + '['.repeat(200000) + '\n' + '/*'.repeat(50000) + '\n' + '"'.repeat(100001) + '\n';
  parseParams(huge);
  check('a hostile 450 KB source parses in under a second', Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
}

console.log('\nincludes: resolved as lattice pages, inside lattice');
{
  const inc = scanIncludes('include <lib/screws.scad>\nuse <gear>;\n// include <commented.scad>\nx = "include <instring>";\n/* use <blocked> */\n  include<tight.scad>\n');
  check.eq('include and use are found, comments and strings are not', inc.map((i) => `${i.kind}:${i.ref}@${i.line}`).join(' '), 'include:lib/screws.scad@1 use:gear@2 include:tight.scad@6');
  check.eq('relative to the page folder', JSON.stringify(resolveRef('parts', 'lib/screws.scad')), JSON.stringify({ page: 'parts/lib/screws', file: '/w/parts/lib/screws.scad' }));
  check.eq('the .scad is optional', resolveRef('parts', 'gear').page, 'parts/gear');
  check.eq('  and the file keeps the name written', resolveRef('parts', 'gear').file, '/w/parts/gear');
  check.eq('.. goes up a folder', resolveRef('a/b', '../c.scad').page, 'a/c');
  check('.. past the root is refused', !!resolveRef('a', '../../x.scad').error);
  check('an absolute path is refused', !!resolveRef('', '/etc/passwd').error);
  check('a URL is refused', !!resolveRef('', 'https://example.com/x.scad').error);
  check('a windows path is refused', !!resolveRef('', 'C:\\x.scad').error);
  check('an empty include is refused', !!resolveRef('', '').error);

  const pages = { 'parts/box': 'include <lib/a.scad>\nuse <lib/b>\ncube(1);', 'parts/lib/a': 'include <b.scad>\nx=1;', 'parts/lib/b': 'y=2;' };
  const read = async (n) => (n in pages ? pages[n] : null);
  const c = await collect('parts/box', pages['parts/box'], read);
  check.eq('collect writes the page and every include', c.files.map(([p]) => p).sort().join(' '), '/w/parts/box.scad /w/parts/lib/a.scad /w/parts/lib/b /w/parts/lib/b.scad');
  check.eq('  with no notes', c.notes.length, 0);
  const asked = [];
  const cyc = await collect('a', 'include <a.scad>\ninclude <b.scad>', async (n) => { asked.push(n); return n === 'b' ? 'include <a.scad>\ninclude <b.scad>' : 'include <b.scad>'; });
  check('a cycle ends', cyc.files.length <= 3, String(cyc.files.length));
  check.eq('  and each page is read once, the open one never', asked.sort().join(), 'b');
  const chain = await collect('p0', 'include <p1.scad>', async (n) => `include <p${Number(n.slice(1)) + 1}.scad>`);
  check('a chain stops at the depth cap', chain.files.length <= 10 && chain.notes.some((x) => /deeper/.test(x)), `${chain.files.length} files`);
  const fan = await collect('f', Array.from({ length: 500 }, (_, i) => `include <x${i}.scad>`).join('\n'), async () => 'x=1;');
  check('a fan-out stops at the file cap', fan.files.length <= 64 && fan.notes.some((x) => /more than/.test(x)), `${fan.files.length} files`);
  const big = await collect('g', 'include <a.scad>\ninclude <b.scad>', async () => 'x'.repeat(3 * 1024 * 1024));
  check('the size cap stops a huge include', big.files.length === 2 && big.notes.some((x) => /MB/.test(x)), `${big.files.length} files`);
  const esc = await collect('s', 'include <../../../etc/passwd>\ninclude <http://evil/x.scad>', async () => 'boom');
  check.eq('hostile paths are noted, never read', esc.files.length + ':' + esc.notes.length, '1:2');
  const thrown = await collect('t', 'include <a.scad>', async () => { throw new Error('down'); });
  check.eq('a read that fails is a missing page', thrown.files.length, 1);
}

console.log('\nSTL: OpenSCAD\'s binary STL');
{
  const stl = (tris) => {
    const b = new ArrayBuffer(84 + tris.length * 50), dv = new DataView(b);
    dv.setUint32(80, tris.length, true);
    tris.forEach((t, i) => t.forEach((v, k) => dv.setFloat32(84 + i * 50 + 12 + k * 4, v, true)));
    return new Uint8Array(b);
  };
  const m = parseStl(stl([[0, 0, 0, 10, 0, 0, 0, 20, 0], [0, 0, 5, 10, 0, 5, 0, 20, 5]]));
  check.eq('two triangles', m.tris, 2);
  check.eq('the box', JSON.stringify([m.min, m.max]), JSON.stringify([[0, 0, 0], [10, 20, 5]]));
  check.eq('a face normal from its corners', [...m.nor.slice(0, 3)].join(), '0,0,1');
  check('a short file is an error', !!parseStl(new Uint8Array(10)).error);
  const lie = stl([[0, 0, 0, 1, 0, 0, 0, 1, 0]]);
  new DataView(lie.buffer).setUint32(80, 1000, true);
  check('a count past the bytes is an error', !!parseStl(lie).error);
  const bomb = new Uint8Array(84);
  new DataView(bomb.buffer).setUint32(80, MAX_TRIS + 1, true);
  check('more triangles than the cap is refused before any is read', /more than the viewer draws/.test(parseStl(bomb).error || ''));
  check.eq('an empty part', parseStl(stl([])).tris, 0);
  check('a corner that is not a finite number is refused', /no size/.test(parseStl(stl([[0, 0, 0, Infinity, 0, 0, 0, 1, 0]])).error || '')
    && /no size/.test(parseStl(stl([[0, 0, 0, NaN, 0, 0, 0, 1, 0]])).error || ''));
}

check.done();
