#!/usr/bin/env node
// Unit test for which beacon a write's own echo arrives on (+echoOf in
// ui-src/lattice/20-state.js). A page write bumps /beacon/rev and a memory
// write /beacon/know. An echo counted on the wrong one swallows a real
// update on the other: a page someone else changed would never refresh.
//
// Extracted from the source, as ui-beacon.mjs does. Usage: node scripts/ui-echo.mjs
import { makeCheck, cut } from './lib/check.mjs';

const { echoes, echoOf } = new Function('location', `${cut('ui-src/lattice/20-state.js',
  /const echoes = [\s\S]*?\n {2}const echoOf = [\s\S]*?\n {2}\};\n/, 'echoes/echoOf')}
return { echoes, echoOf };`)({ href: 'http://ship.test/apps/lattice/app' });
const { eq, done } = makeCheck();
const api = '/apps/lattice';
for (const r of ['know-save', 'know-delete', 'know-restore', 'know-tag', 'know-untag', 'know-move', 'know-verify', 'know-supersede', 'know-import'])
  eq(`${r} echoes on /know`, echoOf(`${api}/${r}?key=%2Fa`), echoes.know);
eq('know-publish echoes on /rev (it publishes a page)', echoOf(`${api}/know-publish?key=%2Fa`), echoes.rev);
for (const r of ['page-save', 'page-del', 'page-move', 'folder-new', 'page-share', 'bookmark-add'])
  eq(`${r} echoes on /rev`, echoOf(`${api}/${r}?name=a`), echoes.rev);
eq('an absolute URL is read by its path', echoOf(`http://ship.test${api}/know-save?key=%2Fa`), echoes.know);
eq('a URL that does not parse falls back to /rev', echoOf('http://['), echoes.rev);
done();
