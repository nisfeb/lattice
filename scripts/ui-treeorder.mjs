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

console.log('\na strict total order');
// The checks above see only the rows one engine's sort happened to give.
// These look at the comparator itself: it is pulled out of treeOrder's
// .sort call, with the items it was handed, and tested for the axioms a
// sort needs. They also run treeOrder under sorts that are not stable and
// that compare other pairs than the engine's, which an inconsistent
// comparator cannot survive. Names add case, unicode (e with a combining
// accent, which the collator calls equal to the precomposed one) and
// display names, which the order must ignore.
const nativeSort = Array.prototype.sort;
function withSort(impl, fn) {
  Array.prototype.sort = impl;
  try { return fn(); } finally { Array.prototype.sort = nativeSort; }
}
function grab(order, list) {
  let got = null;
  withSort(function (cmp) { got = { cmp, items: [...this] }; return nativeSort.call(this, cmp); },
    () => order(list));
  return got;
}
// heapsort: not stable, and compares pairs no merge or insertion sort would
function heapSort(cmp) {
  const a = this, n = a.length;
  const down = (i, m) => {
    for (;;) {
      let c = 2 * i + 1;
      if (c >= m) return;
      if (c + 1 < m && cmp(a[c + 1], a[c]) > 0) c++;
      if (cmp(a[c], a[i]) <= 0) return;
      [a[c], a[i]] = [a[i], a[c]];
      i = c;
    }
  };
  for (let i = (n >> 1) - 1; i >= 0; i--) down(i, n);
  for (let m = n - 1; m > 0; m--) { [a[0], a[m]] = [a[m], a[0]]; down(0, m); }
  return a;
}
// quicksort on a seeded random pivot, also not stable
function quickSort(seed) {
  return function (cmp) {
    const a = this;
    let s = seed >>> 0 || 1;
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
    const qs = (lo, hi) => {
      if (lo >= hi) return;
      const pv = a[lo + Math.floor(rnd() * (hi - lo + 1))];
      let i = lo, j = hi;
      while (i <= j) {
        while (cmp(a[i], pv) < 0) i++;
        while (cmp(a[j], pv) > 0) j--;
        if (i <= j) { [a[i], a[j]] = [a[j], a[i]]; i++; j--; }
      }
      qs(lo, j); qs(i, hi);
    };
    qs(0, a.length - 1);
    return a;
  };
}
const useg = fc.constantFrom('a', 'A', 'b', 'B', 'e', 'E', 'é', 'é', 'ä', 'a-1', '10', '2');
const unode = fc.record({ path: fc.array(useg, { minLength: 1, maxLength: 4 }).map((s) => s.join('/')),
  page: fc.boolean(), dname: fc.option(fc.constantFrom('Zed', 'alpha', 'Été', ''), { nil: undefined }) });
// as `tree` above, plus display names, and half the time no folder nodes
// filled in, so pages are parents with nothing over them and folders can
// be missing from a chain
const utree = fc.tuple(fc.array(unode, { maxLength: 30 }), fc.boolean()).map(([ns, fill]) => {
  const seen = new Map();
  for (const n of ns) {
    const o = { path: n.path, page: n.page, kind: 'md' };
    if (n.dname !== undefined) o.dname = n.dname;
    seen.set((n.page ? 'p:' : 'f:') + n.path, o);
  }
  if (fill) for (const n of [...seen.values()]) {
    const s = n.path.split('/');
    for (let i = 1; i < s.length; i++) {
      const d = s.slice(0, i).join('/');
      if (!seen.has('f:' + d) && !seen.has('p:' + d)) seen.set('f:' + d, { path: d, page: false });
    }
  }
  return [...seen.values()];
});
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const key = (n) => (n.page ? 'p:' : 'f:') + n.path;
for (const [name, order] of [['ascending', asc], ['descending', desc]]) {
  let why = '';
  const ok = (prop, runs = 2000) => {
    try { fc.assert(prop, { numRuns: runs }); return true; }
    catch (e) { why = e.message.split('\n').slice(0, 3).join(' '); return false; }
  };
  check(name + ': the comparator is antisymmetric, and 0 only for one node',
    ok(fc.property(utree, (t) => {
      const { cmp, items } = grab(order, t);
      for (const x of items) for (const y of items) {
        const c = sign(cmp(x, y));
        if (c !== -sign(cmp(y, x))) return false;
        if ((c === 0) !== (key(x.n) === key(y.n))) return false;
      }
      return true;
    })), why);
  check(name + ': the comparator is transitive',
    ok(fc.property(utree, (t) => {
      const { cmp, items } = grab(order, t);
      for (const x of items) for (const y of items) {
        if (cmp(x, y) >= 0) continue;
        for (const z of items) if (cmp(y, z) < 0 && cmp(x, z) >= 0) return false;
      }
      return true;
    }), 500), why);
  check(name + ': heapsort and random-pivot quicksort give the engine\'s rows',
    ok(fc.property(utree, (t) => {
      const want = paths(order(t));
      return paths(withSort(heapSort, () => order(t))) === want
        && paths(withSort(quickSort(1), () => order([...t].reverse()))) === want
        && paths(withSort(quickSort(7), () => order(t))) === want;
    })), why);
  // only where every parent is in the tree: a missing one has no row to follow
  check(name + ': under heapsort every row still follows its parent',
    ok(fc.property(utree, (t) => {
      const have = new Set(t.map((n) => n.path));
      fc.pre(t.every((n) => !parent(n.path) || have.has(parent(n.path))));
      return misplaced(withSort(heapSort, () => order(t))).length === 0;
    })), why);
  check(name + ': display names do not move a row',
    ok(fc.property(utree, (t) => paths(order(t)) === paths(order(t.map(({ dname, ...n }) => n))))), why);
}

console.log('\nordinary trees, as before');
// a folder node over every page, no page that is a parent and no page
// that shares a folder's name: the rows treeOrder drew before the fix
{
  const t = [F('notes'), P('notes/zeta'), P('notes/Alpha'), F('notes/sub'), P('notes/sub/one'),
    P('readme'), F('conflicts'), P('conflicts/offline-edit-x'), P('Beta'), F('archive')];
  check.eq('ascending: folders first, then pages, by the collator',
    asc(t).map((n) => n.path).join(' '),
    'archive conflicts conflicts/offline-edit-x notes notes/sub notes/sub/one notes/Alpha notes/zeta Beta readme');
  check.eq('descending: the same groups, names reversed',
    desc(t).map((n) => n.path).join(' '),
    'notes notes/sub notes/sub/one notes/zeta notes/Alpha conflicts conflicts/offline-edit-x archive readme Beta');
}

check.done();
