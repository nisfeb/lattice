#!/usr/bin/env node
// Recall eval for the knowledge store: how often /know-search puts an
// expected entry near the top for questions an agent would really ask.
//
// The question set is private (it is about the owner's memories), so it is
// not in this repo. It lives as a private lattice page, or a local file:
//
//   {"cases": [{"q": "which git identity do commits use", "keys": ["/feedback/x"]},
//              {"q": "a question nothing answers", "keys": []}, ...]}
//
// A case with no keys is a nothing-stored question: it passes when the
// answer comes back weak (docs/agent-knowledge.md, "Recall").
//
// Usage:  node scripts/know-eval.mjs [page:<name> | <file.json>]   (default page:eval/memory-recall)
// Env:    LATTICE_URL, LATTICE_COOKIE (as the other suites)
// Pure fetch, no browser. It only reads.
import { readFileSync } from 'fs';
import { homedir } from 'os';

const URL = (process.env.LATTICE_URL || 'http://localhost:8080').replace(/\/$/, '');
const COOKIE_FILE = process.env.LATTICE_COOKIE || homedir() + '/.config/lattice-fs/cookie';
const cookie = readFileSync(COOKIE_FILE, 'utf8').trim();
const src = process.argv[2] || 'page:eval/memory-recall';
const get = async (path) => {
  const r = await fetch(URL + '/apps/lattice' + path, { headers: { cookie } });
  if (!r.ok) throw new Error(path + ': ' + r.status);
  return r.json();
};

const set = src.startsWith('page:')
  ? JSON.parse((await get('/page-source?name=' + encodeURIComponent(src.slice(5)))).body)
  : JSON.parse(readFileSync(src, 'utf8'));

let r5 = 0, r10 = 0, rr = 0, n = 0, weakOk = 0, weakN = 0, ms = 0;
const misses = [];
for (const c of set.cases) {
  const t = Date.now();
  const res = await get('/know-search?k=10&q=' + encodeURIComponent(c.q));
  ms += Date.now() - t;
  if (!c.keys.length) { weakN++; if (res.weak) weakOk++; else misses.push(`not weak (${res.strength}): ${c.q}`); continue; }
  n++;
  const keys = res.results.map((x) => x.key);
  const best = Math.min(...c.keys.map((k) => keys.indexOf(k)).filter((i) => i >= 0).map((i) => i + 1), Infinity);
  if (best <= 5) r5++;
  if (best <= 10) r10++;
  if (best !== Infinity) rr += 1 / best;
  if (best > 5) misses.push(`${best === Infinity ? 'not in 10' : 'rank ' + best}: ${c.q} -> ${keys.slice(0, 3).join(', ')}`);
}
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0) + '%';
console.log(`recall@5 ${r5}/${n} (${pct(r5, n)})  recall@10 ${r10}/${n} (${pct(r10, n)})  MRR ${(rr / (n || 1)).toFixed(2)}`);
console.log(`nothing-stored questions answered weak: ${weakOk}/${weakN}`);
console.log(`mean latency ${Math.round(ms / set.cases.length)} ms over ${set.cases.length} queries`);
for (const m of misses) console.log('  ' + m);
