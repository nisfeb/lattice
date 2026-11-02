#!/usr/bin/env node
// Unit test for the preview frames' writes on WebKit (navBusy, navDoc,
// navUrl in ui-src/lattice/10-shell.js).
//
// WebKitGTK drops a srcdoc written while the frame's last navigation is
// still in flight: one load fires with the old document on screen. On
// WebKit a write made while one is in flight marks the frame, and its
// next load writes the current attribute again. This runs that code on
// fake frames that model the drop at its worst (every write made while a
// load is pending is lost) and checks, over thousands of interleavings
// of writes, loads and frames leaving the page:
//   - once the loads settle, a frame shows what its attribute holds,
//     never an older write
//   - it settles: the replays stop (no loop)
//   - one load listener per frame, however many writes
//   - outside WebKit (Chromium's user agent) nothing is added at all
// And that every write to a preview frame in ui-src/lattice goes through
// the helpers: one that sets srcdoc or src itself skips the replay.
//
// Extracted from the source, as ui-echo.mjs does. Usage: node scripts/ui-prevnav.mjs
import { readdirSync } from 'fs';
import { makeCheck, cut, read } from './lib/check.mjs';

const SRC = cut('ui-src/lattice/10-shell.js',
  /const prevWK = [\s\S]*?\n {2}const prevUrl = [^\n]*\n/, 'prevWK..prevUrl');
const WK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CR = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// a frame that loses every write made while a load is pending
function frame() {
  const attrs = new Map();
  const f = {
    isConnected: true, pending: null, shown: null, loads: 0, listeners: [],
    hasAttribute: (k) => attrs.has(k),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => { attrs.delete(k); },
    addEventListener: (ev, fn) => { if (ev === 'load') f.listeners.push(fn); },
    // what the attributes ask the frame to show
    want: () => (attrs.has('srcdoc') ? 'doc:' + attrs.get('srcdoc')
      : attrs.has('src') ? 'url:' + attrs.get('src') : 'blank'),
    nav() { if (f.isConnected && f.pending === null) f.pending = f.want(); },
    // the pending load lands, and its listeners run
    land() {
      if (f.pending === null) return false;
      f.shown = f.pending; f.pending = null; f.loads++;
      for (const fn of f.listeners) fn();
      return true;
    },
  };
  Object.defineProperty(f, 'srcdoc', { set(v) { attrs.set('srcdoc', String(v)); f.nav(); } });
  Object.defineProperty(f, 'src', { set(v) { attrs.set('src', String(v)); f.nav(); } });
  return f;
}

function load(ua) {
  return new Function('navigator',
    `let prev = null;\n${SRC}\nreturn { navDoc, navUrl, prevDoc, prevUrl, set: (f) => { prev = f; } };`)(
    { userAgent: ua });
}

// a small seeded generator, so a failure names its seed
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const check = makeCheck();

{
  // the case seed 7002 found: two writes inside one pending load
  const m = load(WK);
  const f = frame(); m.set(f);
  m.prevDoc('charlie'); m.prevDoc('echo');
  f.land();
  check.eq('two writes in one load: the second is written again on its load', f.pending, 'doc:echo');
  f.land();
  check.eq('and the frame shows the second', f.shown, 'doc:echo');
  check.eq('and nothing is pending after', f.pending, null);
  // three writes, the last a url: the replay writes what is current
  m.prevDoc('a'); m.prevDoc('b'); m.prevUrl('/f/x');
  while (f.land());
  check.eq('a url written last wins over the srcdocs before it', f.shown, 'url:/f/x');
  // a write while the replay itself is in flight
  m.prevDoc('c'); m.prevDoc('d');
  f.land();                     // shows c, writes d again
  m.prevDoc('e');               // lost: d's replay is pending
  while (f.land());
  check.eq('a write during the replay is written again too', f.shown, 'doc:e');
  check.eq('one load listener, however many writes', f.listeners.length, 1);
  // a single write is never written twice
  const n = f.loads;
  m.prevDoc('g'); while (f.land());
  check.eq('a lone write loads once', f.loads - n, 1);
}

{
  // a frame that left the page is not written again
  const m = load(WK);
  const f = frame(); m.set(f);
  m.prevDoc('a'); m.prevDoc('b');
  f.isConnected = false;
  const n = f.loads;
  f.land();
  check.eq('a frame that left the page is not written again on its last load', f.pending, null);
  check.eq('...and loads only what it had', f.loads - n, 1);
}

{
  // outside WebKit: nothing at all
  const m = load(CR);
  const f = frame(); m.set(f);
  m.prevDoc('a'); m.prevDoc('b'); f.land();
  check.eq('Chromium: no load listener', f.listeners.length, 0);
  check('Chromium: no mark on the frame', f.latNav === undefined);
}

{
  // the property: random writes, loads and frame swaps on two frames (the
  // live one and a group's parked one); after the loads settle every
  // connected frame shows its attribute, within a bounded number of loads
  let bad = null;
  for (let seed = 1; seed <= 3000 && !bad; seed++) {
    const r = rng(seed);
    const m = load(WK);
    let live = frame(); m.set(live);
    const parked = frame();
    const log = [];
    let writes = 0;
    for (let i = 0; i < 40; i++) {
      const x = r();
      const v = 'v' + i;
      if (x < 0.3) { m.prevDoc(v); writes++; log.push('prevDoc ' + v); }
      else if (x < 0.38) { m.prevUrl('/f/' + v); writes++; log.push('prevUrl ' + v); }
      else if (x < 0.5) { m.navDoc(parked, v); writes++; log.push('navDoc parked ' + v); }
      else if (x < 0.55) { m.navUrl(parked, '/f/' + v); writes++; log.push('navUrl parked ' + v); }
      else if (x < 0.85) { live.land(); log.push('land live'); }
      else if (x < 0.95) { parked.land(); log.push('land parked'); }
      else {
        // showPreview: a fresh frame replaces the live one
        live.isConnected = false;
        live = frame(); m.set(live);
        log.push('swap live');
      }
    }
    for (const f of [live, parked]) {
      const before = f.loads;
      let k = 0;
      while (f.land()) if (++k > writes + 2) break;
      if (k > writes + 2) { bad = `seed ${seed}: loads never settle: ${log.join(', ')}`; break; }
      if (f.loads > before && f.shown !== f.want()) {
        bad = `seed ${seed}: shows ${f.shown}, holds ${f.want()}: ${log.join(', ')}`; break;
      }
      if (f.listeners.length > 1) { bad = `seed ${seed}: ${f.listeners.length} listeners`; break; }
    }
  }
  check('3000 random interleavings: every frame settles on what it holds', !bad, bad);
}

{
  // every preview write goes through navDoc / navUrl (prevDoc, prevUrl):
  // no `prev.srcdoc =`, `prev.src =`, `gprev.srcdoc =` or the like
  const dir = 'ui-src/lattice/';
  const raw = [];
  for (const file of readdirSync(new URL('../' + dir, import.meta.url)).filter((x) => x.endsWith('.js'))) {
    read(dir + file).split('\n').forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\b(prev|gprev|n)\.(srcdoc|src)\s*=(?!=)/.test(line)) raw.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  check('every preview frame write goes through navDoc / navUrl', !raw.length, raw.join(' | '));
}

check.done();
