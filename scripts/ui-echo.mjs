#!/usr/bin/env node
// Unit test for which beacon a write's own echo arrives on (+echoOf in
// ui-src/lattice/20-state.js). A page write bumps /beacon/rev and a memory
// write /beacon/know. An echo counted on the wrong one swallows a real
// update on the other: a page someone else changed would never refresh.
//
// And how a write's echo is accounted (+echoSent, +echoSeen, +echoLanded).
// The ship can send a write's bump before its answer. Counting that echo
// again on landing left one owed, which swallowed the next real remote
// bump: a page made elsewhere after a delete never showed. And one write
// landing must not shut the window on another still in flight.
//
// The accounting runs on a fake clock, so the property run at the end can
// try thousands of interleavings of our writes, their answers, their bumps
// and remote bumps. Its invariants: our own bumps never refresh, and every
// remote bump is followed by a refresh.
//
// Extracted from the source, as ui-beacon.mjs does. Usage: node scripts/ui-echo.mjs
import { makeCheck, cut } from './lib/check.mjs';

const SRC = cut('ui-src/lattice/20-state.js',
  /const echoes = [\s\S]*?\n {2}const echoOf = [\s\S]*?\n {2}\};\n/, 'echoes/echoOf');
const loc = { href: 'http://ship.test/apps/lattice/app' };

// a fresh copy of the accounting on its own fake clock
function load() {
  let now = 1e6, tid = 0;
  const timers = new Map();
  const setT = (fn, ms) => { timers.set(++tid, { at: now + Math.max(0, ms || 0), fn }); return tid; };
  const clearT = (id) => { timers.delete(id); };
  // move the clock to `t`, firing every timer due on the way, in order
  const to = (t) => {
    for (;;) {
      let next = null;
      for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      timers.delete(next[0]);
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = Math.max(now, t);
  };
  const m = new Function('location', 'Date', 'setTimeout', 'clearTimeout',
    `${SRC}\nreturn { echoes, echoOf, echoSent, echoSeen, echoLanded };`)(loc, { now: () => now }, setT, clearT);
  return { ...m, to, now: () => now, wait: (ms) => to(now + ms) };
}

const { eq, check, done } = (() => { const c = makeCheck(); return { eq: c.eq, check: c, done: c.done }; })();
{
  const { echoes, echoOf } = load();
  const api = '/apps/lattice';
  for (const r of ['know-save', 'know-delete', 'know-restore', 'know-tag', 'know-untag', 'know-move', 'know-verify', 'know-supersede', 'know-import'])
    eq(`${r} echoes on /know`, echoOf(`${api}/${r}?key=%2Fa`), echoes.know);
  eq('know-publish echoes on /rev (it publishes a page)', echoOf(`${api}/know-publish?key=%2Fa`), echoes.rev);
  for (const r of ['page-save', 'page-del', 'page-move', 'folder-new', 'page-share', 'bookmark-add'])
    eq(`${r} echoes on /rev`, echoOf(`${api}/${r}?name=a`), echoes.rev);
  eq('an absolute URL is read by its path', echoOf(`http://ship.test${api}/know-save?key=%2Fa`), echoes.know);
  eq('a URL that does not parse falls back to /rev', echoOf('http://['), echoes.rev);
}

// the write accounting, as shipWrite and the stream drive it. A write's
// window stays open for 4 s after it lands at least.
const SHUT = 5000;
function rig() {
  const a = load();
  const e = a.echoes.rev;
  let woke = 0;
  const wake = () => { woke++; };
  // a bump on the stream: true when it refreshed (straight away)
  const bump = () => { if (a.echoSeen(e, wake)) return false; woke++; return true; };
  const send = () => { const at = a.now(); a.echoSent(e); return at; };
  const land = (at, ok) => a.echoLanded(e, ok, at);
  return { ...a, e, bump, send, land, woke: () => woke };
}

{ // the bump arrives before the answer (a page-del's comes with it)
  const r = rig();
  const w = r.send(); r.wait(300);
  r.bump(); r.wait(10);
  r.land(w, true);
  eq('early echo: landing claims it and owes nothing', r.e.n, 0);
  r.wait(SHUT);
  eq('early echo: no refresh for our own write', r.woke(), 0);
  eq('early echo: the next remote bump refreshes', r.bump(), true);
}
{ // the usual order: answer first, then the bump
  const r = rig();
  const w = r.send(); r.wait(300); r.land(w, true);
  eq('late echo: one bump is owed', r.e.n, 1);
  r.wait(800); r.bump(); r.wait(SHUT);
  eq('late echo: no refresh for our own write', r.woke(), 0);
  eq('late echo: the next remote bump refreshes', r.bump(), true);
}
{ // someone else's bump arrives while ours flies, ours just after landing
  const r = rig();
  const w = r.send(); r.wait(100);
  r.bump(); r.wait(100);
  r.land(w, true); r.wait(100);
  r.bump();
  eq('crossed: no refresh while the window is open', r.woke(), 0);
  r.wait(SHUT);
  eq('crossed: the window shutting refreshes once for theirs', r.woke(), 1);
}
{ // a failed write changes nothing, so a bump during it was someone else's
  const r = rig();
  const w = r.send(); r.wait(100);
  r.bump(); r.land(w, false);
  eq('failed write: owes nothing', r.e.n, 0);
  r.wait(SHUT);
  eq('failed write: the bump during it refreshes', r.woke(), 1);
}
{ // a quick save lands while a slow move still flies; the move's bump comes
  // after the save's window but before the move's answer
  const r = rig();
  const mv = r.send(); r.wait(100);
  const sv = r.send(); r.wait(500); r.land(sv, true);
  r.wait(300); r.bump();                  // the save's echo
  r.wait(8000); r.bump();                 // the move's, early
  r.wait(200); r.land(mv, true);
  eq('overlap: the move owes nothing', r.e.n, 0);
  r.wait(2 * 9100 + 100);                 // twice the move's round trip
  eq('overlap: no refresh for either write', r.woke(), 0);
  eq('overlap: the next remote bump refreshes', r.bump(), true);
}
{ // a folder move bumps once per page: the extra bumps refresh once
  const r = rig();
  const mv = r.send(); r.wait(500);
  r.bump(); r.bump(); r.bump(); r.land(mv, true);
  r.wait(SHUT);
  eq('multi-bump move: one refresh for the extra bumps', r.woke(), 1);
  eq('multi-bump move: nothing owed', r.e.n, 0);
}

// The property run. Each case is a handful of our writes on one beacon,
// some overlapping, some failing, each ok one bumping once before or after
// its answer, and a few remote bumps anywhere. By the end every remote bump
// must be served by a refresh at or after it, and nothing may be owed.
//
// A bump carries nothing that says whose it is. So when our bump arrives
// before its window shuts, a refresh must always serve a remote bump not
// yet served: ours never refresh. When one of ours comes later than that
// and a remote bump has already taken its count, it looks remote and
// refreshes: then refreshes may only be no more than remote bumps, and
// with no remote bump at all there must be none. Stream coalescing is out
// of scope (see the comment on `refocused`, 90-sync.js).
let seed = 104;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const pick = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const CASES = 20000;
let bad = null, worst = 0, crossed = 0, lateCases = 0;
for (let c = 0; c < CASES && !bad; c++) {
  const a = load();
  const e = a.echoes.rev;
  const t0 = a.now();
  const ev = [];
  const writes = pick(1, 5), remotes = pick(0, 3);
  let late = false;
  for (let i = 0; i < writes; i++) {
    const sent = t0 + pick(0, 20000);
    const rtt = rnd() < 0.2 ? pick(5000, 40000) : pick(50, 3000);
    const ok = rnd() < 0.85;
    ev.push({ t: sent, k: 'send', i }, { t: sent + rtt, k: 'land', i, ok });
    if (ok) {
      const b = rnd() < 0.5 ? sent + pick(0, rtt) : sent + rtt + pick(0, 10000);
      if (b - sent - rtt >= Math.max(4000, 2 * rtt)) late = true;
      ev.push({ t: b, k: 'own', i });
    }
  }
  if (late) lateCases++;
  for (let i = 0; i < remotes; i++) ev.push({ t: t0 + pick(0, 30000), k: 'remote' });
  // an answer never beats its own send; ties go in a random order otherwise
  ev.forEach((x) => { x.r = rnd(); });
  const rank = { send: 0, own: 1, remote: 1, land: 2 };
  ev.sort((x, y) => x.t - y.t || (x.i === y.i && x.k !== y.k ? rank[x.k] - rank[y.k] : x.r - y.r));
  const log = [], sentAt = {};
  let pending = [], refreshes = 0;
  const refresh = () => {
    refreshes++;
    log.push('refresh@' + (a.now() - t0));
    if (!pending.length && !late) { bad = bad || { c, why: 'a refresh with no remote bump to serve', log }; return; }
    if (pending.length) worst = Math.max(worst, a.now() - pending[0]);
    pending = [];
  };
  const wake = refresh;
  for (const x of ev) {
    a.to(x.t);
    log.push(`${x.k}${x.i ?? ''}${x.k === 'land' ? (x.ok ? '+' : '-') : ''}@${x.t - t0}`);
    if (x.k === 'send') { sentAt[x.i] = a.now(); a.echoSent(e); }
    else if (x.k === 'land') a.echoLanded(e, x.ok, sentAt[x.i]);
    else {
      if (x.k === 'remote') { pending.push(a.now()); if (e.fly) crossed++; }
      if (!a.echoSeen(e, wake)) refresh();
    }
  }
  a.wait(200000);
  if (!bad && pending.length) bad = { c, why: 'a remote bump never refreshed', log };
  if (!bad && e.n) bad = { c, why: `${e.n} bump(s) still owed at the end`, log };
  if (!bad && refreshes > remotes) bad = { c, why: `${refreshes} refreshes for ${remotes} remote bump(s)`, log };
}
check(`property: ${CASES} interleavings, ours never refresh, every remote does`,
  !bad, bad && `case ${bad.c}: ${bad.why}: ${bad.log.join(' ')}`);
check('property: remote bumps crossed in-flight writes', crossed > 1000, `${crossed}`);
check('property: some of our bumps came late', lateCases > 1000, `${lateCases}`);
console.log(`  (slowest remote refresh: ${(worst / 1000).toFixed(1)} s after its bump)`);
done();
