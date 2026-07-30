#!/usr/bin/env node
// Concatenate ui-app/src/*.js (filename order) into the served app.js.
// One IIFE, one served asset — the pier serializes requests (~2s each),
// so the client must stay a single file. No deps, no bundler.
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ui = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'grubbery-overlay', 'nex', 'lattice', 'ui-app');
const srcDir = join(ui, 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
if (!files.length) { console.error('no src files'); process.exit(1); }

const body = files
  .map((f) => `// ── src/${f} ` + '─'.repeat(Math.max(1, 66 - f.length)) + '\n'
    + readFileSync(join(srcDir, f), 'utf8').trimEnd() + '\n')
  .join('\n');

writeFileSync(join(ui, 'app.js'),
  '/* BUILT FILE — do not edit. Source: ui-app/src/, build: scripts/build-ui.mjs */\n'
  + '(function () {\n\'use strict\';\n' + body + '})();\n');
console.log(`built app.js from ${files.length} src files`);
