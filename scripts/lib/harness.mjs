//  harness.mjs — the one place that knows how to reach a ship from a headless
//  browser, and how a ui-*.mjs suite reports what it found.
//
//  The preamble used to be hand-rolled per suite, and the copies drifted
//  rather than stayed in step: some expanded a leading ~ in LATTICE_COOKIE
//  and some threw ENOENT on the same value, and the printers disagreed about
//  when a detail string is shown. One definition means a change to the cookie
//  format, the Chrome flags or the settle contract is one edit.
//
//  No new dependencies. puppeteer-core is imported lazily, so a suite that
//  never launches a browser can still import from here.

import { readFileSync } from 'fs';
import { homedir } from 'os';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  Where the ship is and how to prove we are logged in. The vars are
//  arguments because the desktop suites point at a second ship with its own
//  cookie file; that divergence is easier to see as a call than as another
//  copy of these six lines.
export function shipEnv({
  urlVar = 'LATTICE_URL',
  cookieVar = 'LATTICE_COOKIE',
  cookieDefault = homedir() + '/.config/lattice-fs/cookie',
} = {}) {
  const base = (process.env[urlVar] || 'http://localhost:8080').replace(/\/$/, '');
  const file = (process.env[cookieVar] || cookieDefault).replace(/^~/, homedir());
  const cookie = readFileSync(file, 'utf8').trim();
  const [name, ...rest] = cookie.split('=');
  return {
    base,
    app: base + '/apps/lattice/app',
    host: new globalThis.URL(base).hostname,
    cookie,                       // the raw header value, for bare fetch()
    cookieName: name,
    cookieValue: rest.join('='),
  };
}

export async function launchBrowser({ profile } = {}) {
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; }
  catch { console.error('puppeteer-core missing: npm i --no-save puppeteer-core'); process.exit(2); }
  return puppeteer.launch({
    executablePath: process.env.CHROME || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox'],
    ...(profile ? { userDataDir: profile } : {}),
  });
}

//  A page that is already logged in. `onPageError` is registered before the
//  cookie so nothing the app throws on its first paint is missed; a suite
//  that passes one treats an uncaught exception in the app as a failure.
export async function openPage(browser, env, { viewport, onPageError } = {}) {
  const page = await browser.newPage();
  if (onPageError) page.on('pageerror', onPageError);
  await page.setCookie({
    name: env.cookieName, value: env.cookieValue, domain: env.host, path: '/',
  });
  if (viewport) await page.setViewport(viewport);
  return page;
}

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
  Object.defineProperty(check, 'fails', { get: () => fails });
  return check;
}

//  Three consecutive sub-4s document loads before the suite starts. Right
//  after a deploy the pier answers everything at 5-10s while the nexus
//  rebuilds, and a timing assertion made in that window measures deploy churn
//  instead of the behaviour under test.
export async function settle(env, { tries = 40, gap = 5000, budget = 4000 } = {}) {
  let okRuns = 0;
  for (let i = 0; i < tries && okRuns < 3; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(env.base + '/apps/lattice', { headers: { Cookie: env.cookie } });
      okRuns = (r.ok && Date.now() - t0 < budget) ? okRuns + 1 : 0;
    } catch { okRuns = 0; }
    if (okRuns < 3) await sleep(gap);
  }
  if (okRuns < 3) { console.log('ship never settled'); process.exit(1); }
}
