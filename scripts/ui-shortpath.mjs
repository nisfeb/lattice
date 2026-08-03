#!/usr/bin/env node
// Unit tests for shortPath (ui-app/src/10-shell.js).
//
// shortPath decides what a grant looks like in the ACL and share panes. Its
// contract is a uniqueness claim: the shortest tail that stays unambiguous
// among the paths shown beside it. A break there is not cosmetic. Two
// different grants render as the same string and someone auditing their own
// permissions cannot tell which page they are looking at.
//
// Extracted and evaluated straight from the source, the same idiom as
// scripts/ui-listedit.mjs, so this needs no browser and no ship.
//
// Usage:  node scripts/ui-shortpath.mjs

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(here, '../grubbery-overlay/nex/lattice/ui-app/src/10-shell.js'), 'utf8');
const m = src.match(/const shortPath = \([\s\S]*?\n {2}\};/);
if (!m) { console.error('could not find shortPath in 10-shell.js'); process.exit(2); }
const shortPath = new Function(`${m[0]}\nreturn shortPath;`)();

let fails = 0;
const eq = (name, got, want) => {
  if (got === want) console.log('  ok   - ' + name);
  else { console.log(`  FAIL - ${name}\n         want ${JSON.stringify(want)}\n         got  ${JSON.stringify(got)}`); fails++; }
};
const B = '/apps/lattice.lattice_app/';

console.log('shortening');
eq('a page grant drops the app base', shortPath(`${B}page/notes`, [`${B}page/notes`]), 'notes');
eq('a pub grant drops it too', shortPath(`${B}pub`, [`${B}pub`]), 'pub');
// the ellipsis marks a TRUNCATED tail: present when segments were dropped,
// absent when the whole stripped path is on screen
eq('a nested page shows its leaf, marked as truncated',
  shortPath(`${B}page/a/b/c`, [`${B}page/a/b/c`]), '\u2026/c');

console.log('\ndisambiguation');
{
  const x = `${B}page/x/note`, y = `${B}page/y/note`;
  eq('a shared leaf grows by one segment', shortPath(x, [x, y]), 'x/note');
  eq('and so does its neighbour', shortPath(y, [x, y]), 'y/note');
}
{
  const x = `${B}page/a/deep/note`, y = `${B}page/b/deep/note`;
  // grown to the full stripped path, so nothing was dropped and no ellipsis
  eq('it keeps growing until unique', shortPath(x, [x, y]), 'a/deep/note');
}
eq('an unrelated path does not force growth',
  shortPath(`${B}page/notes`, [`${B}page/notes`, `${B}page/other`]), 'notes');

console.log('\nthe uniqueness contract holds where it used to break');
// strip() drops an optional "page/", so these two once BOTH rendered as
// "foo": one segment each, nothing left to extend, contract silently broken.
{
  const withPage = `${B}page/foo`, without = `${B}foo`;
  const a = shortPath(withPage, [withPage, without]);
  const b = shortPath(without, [withPage, without]);
  eq('a page grant and a bare grant stay distinguishable', a === b, false);
  eq('the page one says so', a, 'page/foo');
  eq('the bare one stays bare', b, 'foo');
}
{
  // the same collision one level down
  const withPage = `${B}page/a/b`, without = `${B}a/b`;
  eq('and at depth', shortPath(withPage, [withPage, without]) === shortPath(without, [withPage, without]), false);
}

console.log('\nno two paths in one list ever render the same');
{
  const all = [
    `${B}page/foo`, `${B}foo`, `${B}pub`, `${B}page/pub`,
    `${B}page/x/note`, `${B}page/y/note`, `${B}page/a/b/c`, `${B}a/b/c`,
    '/apps/other.app/page/foo',
  ];
  const seen = new Map();
  let dup = null;
  for (const p of all) {
    const s = shortPath(p, all);
    if (seen.has(s)) dup = `${seen.get(s)} and ${p} both render as ${JSON.stringify(s)}`;
    seen.set(s, p);
  }
  eq('every grant in a mixed list is uniquely labelled', dup, null);
}

console.log('\nleaving things alone');
// a foreign app has no base to strip, so the whole path is its segments and
// the leaf shows truncated. Callers put the full path in `title`.
eq('a foreign app path shortens and says it was cut',
  shortPath('/apps/other.app/page/foo', ['/apps/other.app/page/foo']), '\u2026/foo');
eq('the bare base is returned as-is', shortPath(B, [B]), B);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
