#!/usr/bin/env node
// Concatenate ui-src/lattice/*.js (filename order) into the served app.js.
// One IIFE, one served asset. The pier serializes requests (~2s each),
// so the client must stay a single file. No deps, no bundler.
import { createHash } from 'crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ui = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'code', 'nex', 'lattice', 'ui-app');
// sources live OUTSIDE code/: code/ is the published code dir a desk
// mirrors, and a guest must not carry 37 files its ball never loads.
const srcDir = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'ui-src', 'lattice');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
if (!files.length) { console.error('no src files'); process.exit(1); }

// The sources' whole-line // comments stay in ui-src and are left out of
// the served file: they were 287 KB of its 737 KB, compiled into the nexus
// and read by every cold boot. Only whole lines go, never a comment after
// code, and ui-app-comments.mjs proves the result is the same program
// (the same tokens) as the sources with every comment in.
const dropComments = (t) => t.replace(/^[ \t]*\/\/.*\n/gm, '');
const body = files
  .map((f) => `// ── src/${f} ` + '─'.repeat(Math.max(1, 66 - f.length)) + '\n'
    + dropComments(readFileSync(join(srcDir, f), 'utf8').trimEnd() + '\n'))
  .join('\n');

// The hash the ship gives writer.js (+js-tag in app.hoon: the first 16
// bytes of its SHA-256, read as a little-endian atom, printed @uv), so
// 26-writer.js asks for writer.js?h=H and the ship can answer it
// immutable. Build writer.js first (build-writer.mjs): a writer.js change
// changes app.js too.
const uv = (bytes) => {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  const A = '0123456789abcdefghijklmnopqrstuv';
  let s = '';
  do { s = A[Number(n & 31n)] + s; n >>= 5n; } while (n > 0n);
  const parts = [];
  while (s.length > 5) { parts.unshift(s.slice(-5)); s = s.slice(0, -5); }
  parts.unshift(s);
  return '0v' + parts.join('.');
};
const tag = (f) => (existsSync(join(ui, f))
  ? uv(createHash('sha256').update(readFileSync(join(ui, f))).digest().subarray(0, 16)) : '');
const writerH = tag('writer.js');
// sheet.js, the grid editor for fods pages (build-sheet.mjs), the same way
const sheetH = tag('sheet.js');
// pdf.js, the Export PDF layout (78-pdf.js), is hand-written in ui-app/
// and loaded the same way
const pdfH = tag('pdf.js');
// skills.js, the Skills tool tab (95s-skills.js), hand-written in ui-app/ too
const skillsH = tag('skills.js');

writeFileSync(join(ui, 'app.js'),
  '/* BUILT FILE — do not edit. Source: ui-src/lattice/, build: scripts/build-ui.mjs */\n'
  + '(function () {\n\'use strict\';\n'
  + `// the served writer.js's hash (build-ui.mjs, 26-writer.js)\nconst WRITER_H = '${writerH}';\n`
  + `// and sheet.js's, the grid editor for fods pages\nconst SHEET_H = '${sheetH}';\n`
  + `// and pdf.js's (78-pdf.js)\nconst PDF_H = '${pdfH}';\n`
  + `// and skills.js's (95s-skills.js)\nconst SKILLS_H = '${skillsH}';\n\n`
  + body + '})();\n');
console.log(`built app.js from ${files.length} src files`);

// settings.js is the one look and tab model of the ship's Settings page and
// the desktop manager page. The manager must work with no ship, so it
// carries a copy: this one, byte for byte. CI diffs it like app.js.
copyFileSync(join(ui, 'settings.js'),
  join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'ui', 'settings.js'));
