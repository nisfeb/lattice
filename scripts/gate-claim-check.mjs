//  gate-claim-check.mjs: self-check of lib/gate-claim.mjs, the gate's
//  per-run fleet claims. No ship, no fleet: it works in a scratch dir.
//
//    node scripts/gate-claim-check.mjs
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claim, noneRanWhy, ownerName, ownerState, release, staleClones, tryClaim } from './lib/gate-claim.mjs';
import { procTag } from './lib/hygiene.mjs';

let fails = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) fails++; };

const dir = mkdtempSync(join(tmpdir(), 'gate-claim-'));
const claims = join(dir, 'claims');
const held = (set) => { try { return readFileSync(join(claims, set), 'utf8').trim(); } catch { return null; } };
try {
  const me = ownerName();
  check(me === 'gate-' + procTag().replace(':', '-'), `owner name is gate-<pid>-<starttime> (${me})`);
  check(ownerState(me) === 'live', 'this run reads as a live gate');
  const gone = 'gate-4194303-1';                     // above pid_max, never alive
  check(ownerState(gone) === 'gone', 'a dead gate reads as gone');
  check(ownerState('fast-gate') === 'other' && ownerState('sneagan') === 'other', 'other names are never judged stale');
  //  a second gate: alive for this check, distinct from me
  const other = 'gate-1-424242';
  const isAlive = (tag) => tag === '1:424242' || tag === procTag();

  check(tryClaim(claims, 'lattice-gate', me, isAlive).ok && held('lattice-gate') === me, 'a free set is claimed');
  check(tryClaim(claims, 'lattice-gate', me, isAlive).ok, 'claiming again as the holder is fine');
  const r = tryClaim(claims, 'lattice-gate', other, isAlive);
  check(!r.ok && r.holder === me && held('lattice-gate') === me, 'a second live gate is refused and the claim kept (the fast-gate bug)');
  check(!release(claims, 'lattice-gate', other) && held('lattice-gate') === me, 'another owner cannot release it');
  check(release(claims, 'lattice-gate', me) && held('lattice-gate') === null, 'the holder releases it');
  check(!release(claims, 'lattice-gate', me), 'releasing a free set does nothing');

  writeFileSync(join(claims, 'peer'), gone + '\n');
  check(tryClaim(claims, 'peer', me, isAlive).ok && held('peer') === me, 'a gone gate\'s claim is taken over');
  check(readdirSync(claims).sort().join(' ') === 'peer', 'the takeover leaves no file behind');
  writeFileSync(join(claims, 'old'), 'fast-gate\n');
  const o = tryClaim(claims, 'old', me, isAlive);
  check(!o.ok && o.holder === 'fast-gate' && held('old') === 'fast-gate', 'an older gate\'s fast-gate claim is respected');

  const n = await claim(claims, 'old', me, { secs: 0, isAlive });
  check(!n.ok, 'no wait: a held set is refused at once');
  setTimeout(() => rmSync(join(claims, 'old')), 150);
  const t = Date.now();
  const w = await claim(claims, 'old', me, { secs: 5, every: 50, isAlive });
  check(w.ok && held('old') === me && Date.now() - t < 2000, 'a waiting gate gets the set once it is released');

  const clones = join(dir, 'clones');
  const clone = (id, ship, who) => { mkdirSync(join(clones, id), { recursive: true });
    writeFileSync(join(clones, id, 'meta'), `ship=${ship}\nset=lattice-gate\nport=1\nwho=${who}\n`); };
  clone('dep-1', 'dep', gone); clone('dep-2', 'dep', me); clone('dep-3', 'dep', 'fast-gate'); clone('wep-1', 'wep', gone);
  const s = staleClones(clones, 'dep', isAlive);
  check(s.length === 1 && s[0].id === 'dep-1' && s[0].who === gone, 'only a gone gate\'s clones of the ship are stale');

  //  a run that executed no suite fails, and says why
  check(noneRanWhy({ ran: 3, planned: 3 }) === '' && noneRanWhy({ ran: 0, planned: 0, warm: true }) === '', 'a run with suites, or a --warm run, is not failed for running none');
  check(/claim wait timed out/.test(noneRanWhy({ ran: 0, planned: 2, fatal: 'the claim wait timed out after 2700 s: set lattice-gate is held by ' + other })), 'giving up on a held claim with nothing run fails, naming the claim wait');
  check(/nothing matched/.test(noneRanWhy({ ran: 0, planned: 0 })), 'nothing to run fails as nothing matched');
  check(/2 were planned/.test(noneRanWhy({ ran: 0, planned: 2 })), 'planned suites that never started fail');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `gate-claim-check: ${fails} failed` : 'gate-claim-check: all passed');
process.exit(fails ? 1 : 0);
