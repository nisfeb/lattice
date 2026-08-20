#!/usr/bin/env node
//  The offline-save invariant, enforced structurally.
//
//  enqueueSave and enqueueKnow return false when the queue refused the write,
//  having already told the user "NOT SAVED". A caller that ignores that boolean
//  and clears `dirty` anyway reports the edit as stored when it was lost. That
//  regression has happened once per call site: it was fixed on the page paths,
//  and 95-know.js kept doing it for months afterwards because nothing checked.
//
//  A behavioural test for this needs a browser, a ship, and a broken IndexedDB.
//  This is the cheap structural version: every call must be guarded. It costs
//  nothing, runs in CI, and fails the moment a fifth call site forgets.
//
//  If a future call site genuinely does not need the guard, mark it with
//  `// offline-invariant: exempt — <reason>` on the line above and say why.
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const src = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'grubbery-overlay', 'nex', 'lattice', 'ui-app', 'src');

//  the helpers that report failure through their return value
const GUARDED = ['enqueueSave', 'enqueueKnow'];

let fails = 0;
let checked = 0;
const ok = (m) => console.log('  ok   - ' + m);
const bad = (m) => { console.log('  FAIL - ' + m); fails++; };

for (const f of readdirSync(src).filter((n) => n.endsWith('.js')).sort()) {
  const text = readFileSync(join(src, f), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const fn of GUARDED) {
      //  `continue`, not `return`: a line calling the SECOND helper must still
      //  be examined after the first one fails to match.
      if (!line.includes(`await ${fn}(`)) continue;
      //  the definition itself, not a call
      if (/async\s+function\s/.test(line)) continue;
      checked++;
      const prev = lines[i - 1] || '';
      if (/offline-invariant:\s*exempt/.test(prev)) { ok(`${f}:${i + 1} ${fn} exempt (annotated)`); continue; }
      //  the guard shape: the call's value is tested, not discarded
      if (/if\s*\(\s*!\s*\(\s*await/.test(line) || /(const|let|var)\s+\w+\s*=\s*await/.test(line)
        || /return\s+await/.test(line) || /\?\s*$/.test(line)) {
        ok(`${f}:${i + 1} ${fn} result is checked`);
        continue;
      }
      bad(`${f}:${i + 1} ${fn} result is DISCARDED — an edit the queue refused `
        + 'would be reported as saved. Guard it: if (!(await ' + fn + '(...))) return;');
    }
  });
}

console.log(`\nchecked ${checked} call site(s)`);
if (!checked) { console.log('FAIL - found no call sites at all; did the helpers get renamed?'); fails++; }
if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall checks passed');
