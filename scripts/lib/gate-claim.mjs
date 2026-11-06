//  gate-claim.mjs: the gate's fleet claims, one owner per run.
//
//  Every gate used to claim its sets as `fast-gate`, so two gates run at
//  once (by two agents, say) each read the other's claim as its own and
//  booted, snapshotted and dropped ships under each other. Now each run
//  claims as gate-<pid>-<starttime> (or the name --as gives), so:
//
//    - a claim is taken with an exclusive create, never by overwriting;
//    - a set another live gate holds is waited for, not shared;
//    - a claim whose gate is gone (the pid is dead, or is now another
//      process) is stale, and is taken over, as scripts/sweep.sh judges
//      an orphan by the same pid:starttime;
//    - a release removes the claim only while it is still ours;
//    - clones a gone gate left behind are dropped as their owner.
//
//  Any other name (a person's, `fast-gate` from an older gate.mjs) is
//  never judged stale: it is waited for, up to the wait, then refused.
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { alive, procTag } from './hygiene.mjs';

const NAME = /^gate-(\d+)-(\d+)$/;

//  this run's owner name: gate-<pid>-<starttime>
export function ownerName(pid = process.pid) {
  return 'gate-' + procTag(pid).replace(':', '-');
}
//  'live', 'gone' (a gate whose process is over) or 'other' (not a gate name)
export function ownerState(name, isAlive = alive) {
  const m = NAME.exec(name);
  if (!m) return 'other';
  return isAlive(`${m[1]}:${m[2]}`) ? 'live' : 'gone';
}

const read = (f) => { try { return readFileSync(f, 'utf8').trim(); } catch { return null; } };

//  One try. Answers { ok: true } when the claim is ours, or { ok: false,
//  holder } when another holds it. A stale gate's claim is removed and the
//  create tried again.
export function tryClaim(dir, set, who, isAlive = alive) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, set);
  for (let i = 0; i < 3; i++) {
    try { writeFileSync(f, who + '\n', { flag: 'wx' }); return { ok: true }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const holder = read(f);
    if (holder === null) continue;                 // released between the create and the read
    if (holder === who) return { ok: true };
    if (ownerState(holder, isAlive) !== 'gone') return { ok: false, holder };
    //  Take over a gone gate's claim: move it aside (atomic), and if what
    //  moved was a fresh claim another run made meanwhile, put it back.
    const aside = `${f}.${who}`;
    try { renameSync(f, aside); } catch { continue; }
    if (read(aside) !== holder) { try { linkSync(aside, f); } catch {} }
    rmSync(aside, { force: true });
  }
  return { ok: false, holder: read(f) || '?' };
}

//  Waits up to `secs` for the claim, saying who holds it once a minute.
export async function claim(dir, set, who, { secs = 0, say = () => {}, every = 15000, isAlive = alive } = {}) {
  const end = Date.now() + secs * 1000;
  let told = 0;
  for (;;) {
    const r = tryClaim(dir, set, who, isAlive);
    if (r.ok || Date.now() >= end) return r;
    if (Date.now() - told >= 60000) { say(`set ${set} is claimed by ${r.holder}: waiting`); told = Date.now(); }
    await new Promise((res) => setTimeout(res, Math.min(every, Math.max(0, end - Date.now()))));
  }
}

//  Removes the claim only while it is ours. Answers whether it did.
export function release(dir, set, who) {
  const f = join(dir, set);
  if (read(f) !== who) return false;
  rmSync(f, { force: true });
  return true;
}

//  Clones of `ship` whose gate owner is gone: [{ id, who }]
export function staleClones(clonesDir, ship, isAlive = alive) {
  if (!existsSync(clonesDir)) return [];
  const out = [];
  for (const id of readdirSync(clonesDir)) {
    const meta = read(join(clonesDir, id, 'meta'));
    if (!meta) continue;
    const m = Object.fromEntries(meta.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (m.ship === ship && ownerState(m.who || '', isAlive) === 'gone') out.push({ id, who: m.who });
  }
  return out;
}
