//  check.mjs: how every suite counts and reports its checks, and how a pure
//  suite lifts the code under test out of the repo's source.
//
//  Pure suites import this file and never harness.mjs. CI sorts any suite
//  that names lib/harness.mjs into the browser suites, which need a ship, so
//  a pure suite importing it would silently stop running on PRs. harness.mjs
//  re-exports makeCheck from here, so there is one printer either way.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

//  One printer, one counter, handed out together so they cannot come apart.
//  `detail` is diagnostics for a failure and is hidden on a pass, which keeps
//  the FAIL lines a reader is scanning for from being buried. A suite whose
//  detail is a measurement worth seeing either way asks for detailOnPass.
export function makeCheck({ detailOnPass = false } = {}) {
  let fails = 0;
  const check = (name, cond, detail) => {
    const show = detail && (detailOnPass || !cond);
    console.log((cond ? '  ok   - ' : '  FAIL - ') + name + (show ? ' (' + detail + ')' : ''));
    if (!cond) fails++;
    return cond;
  };
  check.ok = (name) => check(name, true);
  check.bad = (name, detail) => check(name, false, detail);
  check.eq = (name, got, want) =>
    check(name, got === want, `want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  //  the summary line and the exit code, for a suite with nothing to tear down
  check.done = () => {
    console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
    process.exit(fails ? 1 : 0);
  };
  Object.defineProperty(check, 'fails', { get: () => fails });
  return check;
}

const root = fileURLToPath(new URL('../..', import.meta.url));

//  a file of the repo, by its path from the repo root
export const read = (path) => readFileSync(root + path, 'utf8');

//  the first match of `re` in that file. A function that moved or was renamed
//  exits 2, "could not test", rather than passing or failing on nothing.
export const cut = (path, re, what) => {
  const m = read(path).match(re);
  if (!m) { console.error(`could not find ${what} in ${path}`); process.exit(2); }
  return m[0];
};
