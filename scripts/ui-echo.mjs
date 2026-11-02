#!/usr/bin/env node
// Unit test for which beacon a write's own echo arrives on (+echoOf in
// ui-src/lattice/20-state.js). A page write bumps /beacon/rev and a memory
// write /beacon/know. An echo counted on the wrong one swallows a real
// update on the other: a page someone else changed would never refresh.
//
//
// And how a write's echo is accounted (+echoSeen, +echoLanded). The ship can
// send a write's bump before its answer. Counting that echo again on landing
// left one owed, which swallowed the next real remote bump: a page made
// elsewhere after a delete never showed.
//
// Extracted from the source, as ui-beacon.mjs does. Usage: node scripts/ui-echo.mjs
import { makeCheck, cut } from './lib/check.mjs';

const { echoes, echoOf, echoSeen, echoLanded } = new Function('location', `${cut('ui-src/lattice/20-state.js',
  /const echoes = [\s\S]*?\n {2}const echoOf = [\s\S]*?\n {2}\};\n/, 'echoes/echoOf')}
return { echoes, echoOf, echoSeen, echoLanded };`)({ href: 'http://ship.test/apps/lattice/app' });
const { eq, done } = makeCheck();
const api = '/apps/lattice';
for (const r of ['know-save', 'know-delete', 'know-restore', 'know-tag', 'know-untag', 'know-move', 'know-verify', 'know-supersede', 'know-import'])
  eq(`${r} echoes on /know`, echoOf(`${api}/${r}?key=%2Fa`), echoes.know);
eq('know-publish echoes on /rev (it publishes a page)', echoOf(`${api}/know-publish?key=%2Fa`), echoes.rev);
for (const r of ['page-save', 'page-del', 'page-move', 'folder-new', 'page-share', 'bookmark-add'])
  eq(`${r} echoes on /rev`, echoOf(`${api}/${r}?name=a`), echoes.rev);
eq('an absolute URL is read by its path', echoOf(`http://ship.test${api}/know-save?key=%2Fa`), echoes.know);
eq('a URL that does not parse falls back to /rev', echoOf('http://['), echoes.rev);

// the write accounting, as shipWrite and the stream drive it: a write holds
// the window open while it flies, and on landing shrinks it to WIN ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = 150;
const fresh = () => ({ n: 0, until: 0, at: 0, early: 0, timer: 0, wake: null });
const send = (e) => { e.until = Date.now() + 60000; };
const land = (e, ok) => { e.until = Date.now() + WIN; echoLanded(e, ok); };
let woke = 0;
const wake = () => { woke++; };

{ // the bump arrives before the answer (a page-del's comes with it)
  const e = fresh(); woke = 0;
  send(e);
  eq('early echo: our own bump is swallowed', echoSeen(e, wake), true);
  land(e, true);
  eq('early echo: landing claims it and owes nothing', e.n, 0);
  await sleep(WIN + 100);
  eq('early echo: no refresh for our own write', woke, 0);
  eq('early echo: the next remote bump is NOT swallowed', echoSeen(e, wake), false);
}
{ // the usual order: answer first, then the bump
  const e = fresh(); woke = 0;
  send(e); land(e, true);
  eq('late echo: one bump is owed', e.n, 1);
  eq('late echo: it is swallowed', echoSeen(e, wake), true);
  await sleep(WIN + 100);
  eq('late echo: no refresh for our own write', woke, 0);
  eq('late echo: the next remote bump is NOT swallowed', echoSeen(e, wake), false);
}
{ // someone else's bump arrives while ours flies, ours just after landing
  const e = fresh(); woke = 0;
  send(e);
  echoSeen(e, wake);              // theirs, taken for ours for now
  land(e, true);
  eq('crossed: ours, arriving late, is swallowed', echoSeen(e, wake), true);
  eq('crossed: no refresh while the window is open', woke, 0);
  await sleep(WIN + 100);
  eq('crossed: the window shutting refreshes once for theirs', woke, 1);
}
{ // a failed write changes nothing, so a bump during it was someone else's
  const e = fresh(); woke = 0;
  send(e);
  echoSeen(e, wake);
  land(e, false);
  eq('failed write: owes nothing', e.n, 0);
  await sleep(WIN + 100);
  eq('failed write: the bump during it refreshes', woke, 1);
}
done();
