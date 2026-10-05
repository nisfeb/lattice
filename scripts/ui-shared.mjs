#!/usr/bin/env node
// Unit tests for the "shared with me" folder (ui-src/lattice/69-shared.js):
// a folder per sharing ship, each page by its own name on that ship, folds
// that collapse, and a row that opens the page on its ship. 69-shared.js
// runs as-is in a vm with a stub DOM, so this needs no browser and no ship.
//
// Usage:  node scripts/ui-shared.mjs
import { readFileSync } from 'fs';
import vm from 'vm';
import { makeCheck } from './lib/check.mjs';

const src = readFileSync(new URL('../ui-src/lattice/69-shared.js', import.meta.url), 'utf8');
const check = makeCheck();

function El(tag) { this.tag = tag; this.kids = []; this.style = {}; this.className = ''; this.text = ''; }
Object.defineProperty(El.prototype, 'textContent', {
  get() { return this.text + this.kids.map((k) => k.textContent).join(''); },
  set(v) { this.text = v; this.kids = []; },
});
El.prototype.append = function (...k) { this.kids.push(...k); };
El.prototype.appendChild = function (k) { this.kids.push(k); };

const D = '/apps/shell.shell/desks/lattice.desk/desk/data/lattice.lattice_app';
function boot(items, coll = []) {
  const treeList = new El('div'), opened = [];
  let stored = coll;
  const ctx = {
    treeList, sharedWithMe: items, mode: 'pages', api: '/apps/lattice',
    collapsed: () => stored.slice(), setCollapsed: (c) => { stored = c; },
    renderTree: () => { treeList.kids = []; ctx.renderShared(stored); },
    guardDirty: async () => true, history: { replaceState() {} },
    openGrub: (p, s) => opened.push([p, s]),
    document: { createElement: (t) => new El(t), createTextNode: (t) => ({ textContent: t }) },
  };
  vm.runInNewContext(src, ctx);
  ctx.renderShared(stored);
  const rows = () => treeList.kids.map((r) => (r.className.includes('pg') ? 'page ' : 'fold ') + r.textContent);
  return { ctx, treeList, rows, opened };
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
    'fold ▾📁 shared with me',
    'fold ▾📁 ~bus', 'page notes/aread×',
    'fold ▾📁 ~nec', 'page apps/calendar/thingread×', 'page blog/draftread×', 'page site/loggingedit×',
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
  const { treeList, opened } = boot(items);
  const row = treeList.kids.find((r) => r.textContent.startsWith('site/logging'));
  if (row) row.onclick({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0));
  check('a row opens the page on its own ship',
    JSON.stringify(opened) === JSON.stringify([[D + '/page/site/logging/code', '~nec']]), JSON.stringify(opened));
}

check.done();
