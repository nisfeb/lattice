#!/usr/bin/env node
// Unit and property tests for treeOrder (ui-src/lattice/30-tree.js).
//
// treeOrder lays the files tree out as flat rows, so a row's place IS its
// parent: a page drawn anywhere but after its parent's row reads as a page
// of some other folder. A page can also be a parent (`reports/x` a page and
// `reports/x/patch-1` under it), and the ship sends no folder node for it
// then. The comparator once sorted that page among the pages but its
// children among the folders, which is not a consistent order, and an
// inconsistent comparator leaves the result to the engine's sort. The
// desktop app's webview (JavaScriptCore) drew patch-1 to patch-4 of one
// owner's ship at the top of reports/, under nothing, and patch-5 and
// patch-6 under their page, from the very dump Chromium (V8) drew right.
// V8 shows the same break once the nodes arrive in another order, which
// is what this suite feeds it.
//
// Contracts checked here, for any order the nodes arrive in:
//   every row follows its parent's row, with only that parent's
//     descendants between them
//   the result does not depend on the input order
//   folders (and pages with children) come before plain pages
//
// Usage:  node scripts/ui-treeorder.mjs
// Setup:  npm ci --prefix scripts     (fast-check is locked in scripts/)

import { makeCheck, cut } from './lib/check.mjs';

let fc;
try { fc = (await import('fast-check')).default; }
catch { console.error('fast-check missing: npm i --no-save fast-check'); process.exit(2); }

const src = cut('ui-src/lattice/30-tree.js', /\n {2}function treeOrder\([\s\S]*?\n {2}\}\n/, 'treeOrder');
const make = (sort) => new Function('treeSort', 'treeColl', `${src}\nreturn treeOrder;`)(
  () => sort, new Intl.Collator());
const asc = make('name'), desc = make('name-desc');
const check = makeCheck();

const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// the rows that do not sit under their parent: the nearest row before each
// that is not one of the parent's descendants has to be the parent itself
function misplaced(rows) {
  const bad = [];
  rows.forEach((n, i) => {
    const par = parent(n.path);
    if (!par) return;
    let j = i - 1;
    while (j >= 0 && rows[j].path.startsWith(par + '/')) j--;
    if (j < 0 || rows[j].path !== par) bad.push(n.path);
  });
  return bad;
}
const paths = (rows) => rows.map((n) => (n.page ? 'p:' : 'f:') + n.path).join(' ');

// the shape from the report: reports/ames-viz-perf-king is a page with six
// pages under it, beside other pages and a real folder in reports/
const P = (path) => ({ path, page: true, kind: 'md' });
const F = (path) => ({ path, page: false });
const K = 'reports/ames-viz-perf-king';
const base = [F('reports'), P('reports/2026-10-11-bench-review'), P('reports/2026-10-30-lattice-test-speed'),
  P(K), ...[1, 2, 3, 4, 5, 6].map((i) => P(K + '/patch-' + i)),
  F('reports/brave-weekly'), P('reports/brave-weekly/2026-10-26'), P('reports/lattice-perf-pass')];

console.log('the reported tree');
{
  // patch-1..4 arriving after the rest, as a tree patched in this tab has
  // them (addTreeNode appends), drew them at the top of reports/
  const late = [...base.filter((n) => !/patch-[1-4]$/.test(n.path)),
    ...base.filter((n) => /patch-[1-4]$/.test(n.path))];
  const rows = asc(late);
  check('every patch draws under its page', misplaced(rows).length === 0, paths(rows));
  check.eq('the page draws first, then its patches in order',
    rows.slice(rows.findIndex((n) => n.path === K), rows.findIndex((n) => n.path === K) + 7)
      .map((n) => n.path.split('/').pop()).join(),
    'ames-viz-perf-king,patch-1,patch-2,patch-3,patch-4,patch-5,patch-6');
  check('and sorts with the folders, before the plain pages',
    paths(rows) === paths(asc(base)) && rows.findIndex((n) => n.path === K)
      < rows.findIndex((n) => n.path === 'reports/2026-10-11-bench-review'), paths(rows));
  check('a page with children keeps its patches descending too', misplaced(desc(late)).length === 0,
    paths(desc(late)));
}

console.log('\nproperties');
// paths from a small alphabet so pages and folders collide often: a page
// that is also a parent, a folder and a page of one name, deep chains
const seg = fc.constantFrom('a', 'b', 'c', 'B', 'a-1', '10', '2');
const node = fc.record({ path: fc.array(seg, { minLength: 1, maxLength: 4 }).map((s) => s.join('/')),
  page: fc.boolean() });
// a tree as the ship sends it: one node per (path, page), with the folder
// nodes a page's ancestors need unless a page already holds that path
const tree = fc.array(node, { maxLength: 40 }).map((ns) => {
  const seen = new Map();
  for (const n of ns) seen.set((n.page ? 'p:' : 'f:') + n.path, { path: n.path, page: n.page, kind: 'md' });
  for (const n of [...seen.values()]) {
    const s = n.path.split('/');
    for (let i = 1; i < s.length; i++) {
      const d = s.slice(0, i).join('/');
      if (!seen.has('f:' + d) && !seen.has('p:' + d)) seen.set('f:' + d, { path: d, page: false });
    }
  }
  return [...seen.values()];
});
const shuffled = tree.chain((t) => fc.tuple(fc.constant(t), fc.shuffledSubarray(t, { minLength: t.length })));
for (const [name, order] of [['ascending', asc], ['descending', desc]]) {
  let why = '';
  const ok = (prop) => {
    try { fc.assert(prop, { numRuns: 3000 }); return true; } catch (e) { why = e.message.split('\n').slice(0, 3).join(' '); return false; }
  };
  check(name + ': every row follows its parent',
    ok(fc.property(tree, (t) => misplaced(order(t)).length === 0)), why);
  check(name + ': the input order does not change the rows',
    ok(fc.property(shuffled, ([t, s]) => paths(order(t)) === paths(order(s)))), why);
  check(name + ': siblings put folders and parents before plain pages',
    ok(fc.property(tree, (t) => {
      const rows = order(t);
      const dirs = new Set(t.filter((n) => !n.page).map((n) => n.path));
      for (const n of t) if (parent(n.path)) dirs.add(parent(n.path));
      const kids = new Map();
      for (const n of rows) {
        const k = kids.get(parent(n.path)) || [];
        k.push(dirs.has(n.path));
        kids.set(parent(n.path), k);
      }
      return [...kids.values()].every((k) => k.indexOf(false) < 0 || !k.slice(k.indexOf(false)).includes(true));
    })), why);
}

check.done();
