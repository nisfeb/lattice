#!/usr/bin/env node
// Unit test for the beacon stream's backoff rule (+streamFail in
// ui-src/lattice/90-sync.js). A stream that registers and then breaks within
// seconds must count as a failure, or every editor reconnects every few
// seconds into a ship that is breaking streams because it is saturated.
//
// Extracted from the source, as ui-shortpath.mjs does. Usage: node scripts/ui-beacon.mjs
import { makeCheck, cut } from './lib/check.mjs';

const streamFail = new Function(`${cut('ui-src/lattice/90-sync.js',
  /const streamFail = [\s\S]*?;\n/, 'streamFail')}\nreturn streamFail;`)();
const { eq, done } = makeCheck();
eq('the keep expiring after its minute resets the count', streamFail(3, true, 80000, false), 0);
eq('a live bump proves the stream, however short', streamFail(3, true, 2000, true), 0);
eq('registered then broken in seconds is a failure', streamFail(0, true, 2000, false), 1);
eq('and keeps counting up', streamFail(2, true, 5000, false), 3);
eq('never registered is a failure', streamFail(1, false, 0, false), 2);
eq('the count stops at five (a 30 s pause)', streamFail(5, true, 100, false), 5);
done();
