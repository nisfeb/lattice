#!/usr/bin/env node
// Unit tests for the "shared with me" folder (ui-src/lattice/69-shared.js):
// a folder per sharing ship, each page by its own name on that ship, folds
// that collapse, and a row that opens the page on its ship. 69-shared.js
// runs as-is in a vm with a stub DOM, so this needs no browser and no ship.
//
// Usage:  node scripts/ui-shared.mjs
import vm from 'vm';
import { makeCheck, read, cut } from './lib/check.mjs';

// the folder row and the fold store are shared with the other two trees,
// so they are lifted from where they live and run ahead of 69-shared.js
const L = 'ui-src/lattice/';
const src = cut(L + '20-state.js', /const collStore = [\s\S]*?\n {2}const paneColl = .*/, 'collStore') + '\n'
  + cut(L + '30-tree.js', /function folderRow\([\s\S]*?\n {2}\}/, 'folderRow') + '\n'
  + cut(L + '30-tree.js', /function treeItem\([\s\S]*?\n {2}\}/, 'treeItem') + '\n'
  + cut(L + '30-tree.js', /const SYSF = \{[\s\S]*?\n {2}\};/, 'SYSF') + '\n'
  + cut(L + '30-tree.js', /function sysFlair\([\s\S]*?\n {2}\}/, 'sysFlair') + '\n'
  + cut(L + '21-tabs.js', /const tabLink = [\s\S]*?\n {2}\};/, 'tabLink') + '\n'
  + read(L + '69-shared.js');
const check = makeCheck();

function El(tag) {
  this.tag = tag; this.kids = []; this.style = {}; this.className = ''; this.text = '';
  this.dataset = {}; this.attrs = {};
}
El.prototype.setAttribute = function (k, v) { this.attrs[k] = String(v); };
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this.text + this.kids.map((k) => k.textContent).join(''); },
  set(v) { this.text = v; this.kids = []; },
});
El.prototype.append = function (...k) {
  this.kids.push(...k.map((x) => (typeof x === 'string' ? { textContent: x } : x)));
};
El.prototype.appendChild = function (k) { this.kids.push(k); };

const D = '/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app';
function boot(items, coll = []) {
  const treeList = new El('div'), opened = [];
  const localStorage = { appColl: JSON.stringify(coll) };
  const ctx = {
    treeList, sharedWithMe: items, mode: 'pages', api: '/apps/lattice', localStorage,
    renderTree: () => { treeList.kids = []; ctx.renderShared(JSON.parse(localStorage.appColl)); },
    guardDirty: async () => true, history: { replaceState() {} },
    // a row opens through the tab model (21-tabs.js) as a grub tab
    openIn: (kind, p, o) => opened.push([kind, p, o.ship]), ico: () => '',
    // the move in and out (Task 5 of shared page links): its palette home
    // and its registration, stubbed
    action: () => {}, rowMore: () => {},
    // the fit to width (10-shell.js) needs layout; here the whole name
    fitName: (el, t) => { el.textContent = t; },
    tip: (b, name) => { b.title = name; b.setAttribute('aria-label', name); return b; },
    document: { createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: t }), addEventListener() {}, hidden: false },
    // the refocus refetch (69-shared.js) listens on the window
    window: { addEventListener() {} },
  };
  vm.runInNewContext(src, ctx);
  ctx.renderShared(coll);
  //  a page row sits in a wrapper beside its Move into my pages button
  const pages = () => treeList.kids.map((r) => (r.className === 'swrow' ? r.kids[0] : r));
  const rows = () => pages().map((r) => (r.className.includes('pg') ? 'page ' : 'fold ') + r.textContent);
  return { ctx, treeList, rows, opened, pages };
}
// ~nec's arrive unsorted, and not merely reversed
const items = [
  { host: '~nec', path: D + '/page/blog/draft/code', mode: 'read' },
  { host: '~bus', path: '/apps/lattice.lattice_app/page/notes/a/code', mode: 'read' },
  { host: '~nec', path: D + '/page/site/logging/code', mode: 'edit' },
  { host: '~nec', path: '/apps/calendar/thing', mode: 'read' },
];

{
  const { rows } = boot(items);
  const want = [
    'fold ▾shared with me',
    'fold ▾~bus', 'page notes/aread×',
    'fold ▾~nec', 'page apps/calendar/thingread×', 'page blog/draftread×', 'page site/loggingedit×',
  ];
  check('a folder per ship, each page by its own name there, sorted',
    JSON.stringify(rows()) === JSON.stringify(want), JSON.stringify(rows()));
}
{
  const { rows, treeList } = boot(items);
  treeList.kids.find((r) => r.textContent.includes('~bus')).onclick();
  check('a ship folder collapses to its row',
    !rows().some((r) => r.includes('notes/a')) && rows().some((r) => r.includes('~nec')) && rows().some((r) => r.includes('site/logging')),
    JSON.stringify(rows()));
  treeList.kids[0].onclick();
  check('the top folder collapses to one row', rows().length === 1, JSON.stringify(rows()));
}
{
  const { pages, opened } = boot(items);
  const row = pages().find((r) => r.textContent.startsWith('site/logging'));
  if (row) row.onclick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  check('a row opens the page on its own ship',
    JSON.stringify(opened) === JSON.stringify([['grub', D + '/page/site/logging/code', '~nec']]), JSON.stringify(opened));
}
{
  const { treeList } = boot(items);
  const w = treeList.kids.find((r) => r.className === 'swrow' && r.kids[0].textContent.startsWith('site/logging'));
  const row = w && w.kids[0];
  const mv = w && w.kids[1];
  check('a row drags, and has Move into my pages beside it, a button',
    !!row && row.draggable === true && !!mv && mv.tag === 'button' && mv.className === 'swmv'
      && mv.dataset.action === 'swm-move' && mv.title === 'Move into my pages'
      && mv.attrs['aria-label'] === mv.title,
    JSON.stringify(row && { draggable: row.draggable, mv: mv && mv.title }));
}

{
  //  the folders lattice makes or draws itself carry a mark that says so:
  //  shared with me here, conflicts/ in the files tree (renderTree)
  const { treeList, ctx } = boot(items);
  const top = treeList.kids[0];
  const f = top.kids.find((k) => k.className === 'sysf');
  check('shared with me carries the system folder mark, with what it is in its tip',
    !!f && /Not a folder in your pages/.test(f.title) && f.attrs['aria-label'] === f.title,
    JSON.stringify(f && f.title));
  check('and only the top folder does, not a ship\'s',
    treeList.kids.filter((r) => r.kids && r.kids.some((k) => k.className === 'sysf')).length === 1);
  const row = new El('div');
  const c = ctx.sysFlair(row, 'conflicts');
  check('conflicts/ says it is safe to delete and made again on the next conflict',
    row.kids[0] === c && /Safe to delete/.test(c.title) && /made again on the next conflict/.test(c.title),
    c.title);
}

{
  //  un-hiding a tab fires focus and visibilitychange together: one GET
  const on = [];
  let gets = 0;
  const slow = async () => { gets++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => [] }; };
  const ctx = {
    treeList: new El('div'), sharedWithMe: [], mode: 'pages', api: '/apps/lattice',
    localStorage: { appColl: '[]' }, renderTree() {}, guardDirty: async () => true,
    history: { replaceState() {} }, openIn() {}, ico: () => '', action() {}, rowMore() {},
    fitName: (el, t) => { el.textContent = t; },
    tip: (b) => b, bgFetch: slow, fetch: slow, Date,
    document: { createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: t }),
      addEventListener: (t, f) => on.push(f), hidden: false },
    window: { addEventListener: (t, f) => on.push(f) },
  };
  vm.runInNewContext(src, ctx);
  for (const f of on) f();
  await new Promise((r) => setTimeout(r, 50));
  check('focus and visibilitychange together fetch shared-with-me once', gets === 1, String(gets));
}

check.done();
