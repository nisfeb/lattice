#!/usr/bin/env node
//  perf-measure.mjs: how fast lattice feels, measured the same way on any
//  release, so a performance pass can be compared with the one before it.
//
//  Each run gets a fresh browser context (no cache, no service worker), so
//  its first loads are first loads. Per scenario it records wall time from
//  the action to the result, the main thread's busy time (CDP TaskDuration),
//  long tasks (PerformanceObserver longtask, every frame), and the requests
//  made and bytes received. The median of RUNS runs is printed as JSON.
//
//  Scenarios that need a feature the release lacks (tabs, splits, frame
//  tabs, the forum) are measured by their nearest equivalent or left out:
//  72 switches pages instead of tabs, opens the reader home in a window
//  instead of a browser tab, and has no splits or forum.
//
//  Usage: LATTICE_URL=http://localhost:8120 LATTICE_COOKIE=/tmp/mec-cookie.txt \
//           node scripts/perf-measure.mjs [--runs 5] [--only cold,save-private]
//           [--vp desktop,phone] [--label main] [--load 2] [--routes]
//           [--link-host URL --link-cookie FILE] [--frames] [--pagecache]
//           [--out FILE] [--no-scenarios]
//
//    --load N      N background loops fetching page-dump while measuring,
//                  a ship under load (it never seeds or writes)
//    --routes      also time the key routes server-side (median of RUNS)
//    --frames      an editor alone, then with six browser tabs and a forum
//                  tab parked: idle main-thread cost, open streams, and a
//                  save's time split into queued and server
//    --pagecache   a shared page saved behind a cached reader view: when the
//                  ship serves the new text, and when the cache holds it
//    --out FILE    the JSON so far, rewritten after every section
//    PERF_RAW=1    every run, not only the medians
//    --link-*      a second ship on the same release: it shares a page with
//                  this one, which links it, and the link page's save is
//                  timed (scenario save-link)
//
//  Writes about 30 pages under perf/ (two published). Fake fleet ships only.
import { shipEnv, launchBrowser, openPage, shipName, seed, sleep } from './lib/harness.mjs';
import { readFileSync, writeFileSync } from 'fs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] ?? true); };
const flag = (k) => argv.includes('--' + k);
const RUNS = +arg('runs', 5);
const ONLY = arg('only', null)?.split(',');
const VPS = arg('vp', 'desktop,phone').split(',');
const LOAD = +arg('load', 0);
const LABEL = arg('label', '');
const OUT = arg('out', null);
const env = shipEnv();
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.base)) {
  console.error('perf-measure: refusing a non-local ship; fake fleet ships only');
  process.exit(2);
}
const SHIP = await shipName(env);
const Q = encodeURIComponent;
const N_PAGES = 28;
const P = (i) => 'perf/p' + String(i).padStart(2, '0');
const SH1 = 'perf/shared1', SH2 = 'perf/shared2', LNK = 'perf/link';
const marker = (n) => 'perfmark-' + n.replace(/\W/g, '-');
const VIEWPORTS = {
  desktop: { width: 1400, height: 900 },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const on = (n) => !ONLY || ONLY.includes(n);
const api = (path, init = {}) => fetch(env.base + '/apps/lattice/' + path,
  { ...init, headers: { Cookie: env.cookie, ...(init.headers || {}) } });

// ── fixtures ───────────────────────────────────────────────────────────────
//  page-save new=1 answers 409 for a page already there, so a rerun is cheap
async function fixtures() {
  const pages = [];
  for (let i = 0; i < N_PAGES; i++)
    pages.push([P(i), '# ' + P(i) + '\n\n' + marker(P(i)) + '\n\n' + 'lorem ipsum dolor sit amet. '.repeat(40)]);
  await seed(env, pages);
  await seed(env, [[SH1, '# shared one\n\n' + marker(SH1) + '\n\n[two](urb://' + SHIP + '/' + SH2 + ')\n'],
    [SH2, '# shared two\n\n' + marker(SH2) + '\n']], { share: 'shared' });
}

//  a link page: the peer ship makes perf/linked, shares it with us (edit),
//  and we link it at perf/link. Current releases only.
async function linkFixture(host, cookieFile) {
  const cookie = readFileSync(cookieFile, 'utf8').trim();
  const B = (path, body) => fetch(host + '/apps/lattice/' + path,
    { method: 'POST', body, headers: { Cookie: cookie } });
  await B('page-save?name=perf/linked&type=md&new=1', '# linked\n\n' + marker(LNK) + '\n');
  await B('share-file?name=perf/linked&ship=' + Q(SHIP) + '&mode=edit');
  const bship = (await (await fetch(host + '/~/host')).text()).trim();
  for (let i = 0; i < 60; i++) {
    const l = await (await api('shared-with-me')).json().catch(() => []);
    const e = l.find((x) => x.host === bship && x.path.endsWith('/page/perf/linked/code'));
    if (e) {
      const r = await api('link-make?host=' + Q(bship) + '&path=' + Q(e.path) + '&to=' + Q(LNK), { method: 'POST' });
      return r.ok || r.status === 409;
    }
    await sleep(2000);
  }
  return false;
}

// ── background load ────────────────────────────────────────────────────────
let loading = false;
function startLoad(n) {
  loading = true;
  for (let i = 0; i < n; i++) (async () => {
    while (loading) {
      try { await (await api('page-dump')).arrayBuffer(); } catch { await sleep(500); }
    }
  })();
}

// ── instrumentation ────────────────────────────────────────────────────────
//  every frame keeps its own long tasks, stamped in epoch ms so they can be
//  cut to a scenario's window and merged across frames
const LT_INIT = `(() => { try {
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries())
    window.__lt.push([Math.round(performance.timeOrigin + e.startTime), Math.round(e.duration)]); })
    .observe({ type: 'longtask', buffered: true });
} catch {} })();`;

async function instrument(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  await page.evaluateOnNewDocument(LT_INIT);
  const reqs = new Map();          // requestId -> record
  const log = [];
  cdp.on('Network.requestWillBeSent', (e) => {
    if (reqs.has(e.requestId)) return;     // a redirect hop
    const r = { id: e.requestId, url: e.request.url, method: e.request.method, ts: e.timestamp,
      wall: Date.now(), bytes: 0, done: false, sw: false, cache: false, timing: null, status: 0 };
    reqs.set(e.requestId, r); log.push(r);
  });
  cdp.on('Network.responseReceived', (e) => {
    const r = reqs.get(e.requestId); if (!r) return;
    r.sw = !!e.response.fromServiceWorker; r.cache = !!e.response.fromDiskCache;
    r.timing = e.response.timing || null; r.status = e.response.status;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId); if (!r) return;
    r.bytes = e.encodedDataLength; r.done = true; r.end = e.timestamp; r.endWall = Date.now();
  });
  cdp.on('Network.loadingFailed', (e) => {
    const r = reqs.get(e.requestId); if (!r) return;
    r.done = true; r.failed = true; r.end = e.timestamp; r.endWall = Date.now();
  });
  const busy = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { task: m.TaskDuration * 1000, script: m.ScriptDuration * 1000 };
  };
  const longtasks = async (t0, t1) => {
    const seen = new Set(), out = [];
    for (const f of page.frames()) {
      const l = await f.evaluate(() => window.__lt || []).catch(() => []);
      for (const [s, d] of l) {
        const k = s + ':' + d;
        if (s >= t0 && s <= t1 && !seen.has(k)) { seen.add(k); out.push(d); }
      }
    }
    return out;
  };
  return { cdp, log, busy, longtasks };
}

//  the streams (keep SSE) a page holds stay open forever; they are counted,
//  never waited on
const isStream = (u) => /\/grubbery\/api\/keep|\/streams?\b|text\/event-stream/.test(u) && !/\/apps\/lattice\/streams$/.test(u);

async function meter(ins, fn) {
  const i0 = ins.log.length, b0 = await ins.busy(), t0 = Date.now();
  let extra = {}, ok = true;
  try { extra = (await fn()) || {}; } catch (e) { ok = false; extra = { err: String(e.message).slice(0, 400) }; }
  const t1 = Date.now();
  const ms = extra.ms ?? (t1 - t0);
  await sleep(150);                  // let loadingFinished events arrive
  const b1 = await ins.busy();
  const rs = ins.log.slice(i0).filter((r) => r.wall <= t1 + 50);
  const net = rs.filter((r) => !r.sw && !r.cache && !r.url.startsWith('data:'));
  const lts = await ins.longtasks(t0, t1);
  delete extra.ms;
  return {
    ok, ms,
    //  a navigation in the window resets the counters: null, not negative
    busyMs: b1.task >= b0.task ? Math.round(b1.task - b0.task) : null,
    scriptMs: b1.script >= b0.script ? Math.round(b1.script - b0.script) : null,
    longN: lts.length, longMs: lts.reduce((a, d) => a + d, 0), longMax: Math.max(0, ...lts),
    reqs: rs.length, netReqs: net.length, swReqs: rs.filter((r) => r.sw).length,
    kb: Math.round(rs.reduce((a, r) => a + (r.bytes || 0), 0) / 1024),
    streams: rs.filter((r) => isStream(r.url)).length,
    ...extra,
  };
}

//  a request's own time, split: queued in the browser (the six-connection
//  limit), waiting on the ship, and the download
function split(r) {
  if (!r || !r.timing) return null;
  const t = r.timing, base = t.requestTime;
  const send = base + t.sendStart / 1000;
  return {
    queued: Math.round((send - r.ts) * 1000),
    server: Math.round(t.receiveHeadersEnd - t.sendEnd),
    total: r.end ? Math.round((r.end - r.ts) * 1000) : null,
  };
}

// ── helpers in the page ────────────────────────────────────────────────────
const until = (p, fn, arg, ms = 60000) => p.waitForFunction(fn, { timeout: ms, polling: 20 }, arg);
const editorShows = (p, name) => until(p, (m) => {
  const s = document.getElementById('src');
  return !!s && s.value.includes(m) && !s.readOnly
    && document.querySelectorAll('#treelist a.pg').length > 0;
}, marker(name));
const caps = (p) => p.evaluate(() => ({
  tabs: !!window.latTabs, splits: !!window.latSplits,
  frames: !!document.getElementById('rb-browser'), forum: !!document.getElementById('rb-forum'),
  drawers: !!document.getElementById('lpane'), mtabs: !!document.querySelector('.mtabs button'),
}));
const pressChord = async (p, key, mods) => {
  for (const m of mods) await p.keyboard.down(m);
  await p.keyboard.press(key);
  for (const m of [...mods].reverse()) await p.keyboard.up(m);
};
const treeOpen = (p, name) => p.evaluate((n) => {
  const a = [...document.querySelectorAll('#treelist a.pg')]
    .find((x) => decodeURIComponent(x.getAttribute('href') || '').includes('name=' + n));
  if (!a) return false;
  a.click(); return true;
}, name);
//  the perf folder open in the tree, so its rows exist
const expandPerf = (p) => p.evaluate(() => {
  const f = [...document.querySelectorAll('#treelist .fld')].find((x) => /^\s*[▸▾]?\s*perf\b/.test(x.textContent));
  if (f && !document.querySelector('#treelist a.pg[href*="perf%2Fp00"]')) f.click();
});
const frameKeyFront = (p) => p.evaluate(() => {
  const s = window.latTabs.state(); return s.tabs[s.active]?.key;
});
const frameReady = (p, test) => until(p, (t) => {
  const s = window.latTabs.state();
  const k = s.tabs[s.active]?.key;
  const f = k && document.querySelector(`iframe[data-tool="${k}"]`);
  if (!f || f.hidden) return false;
  try {
    const w = f.contentWindow;
    return f.contentDocument.readyState === 'complete' && new RegExp(t).test(w.location.pathname + w.location.search);
  } catch { return false; }
}, test);

//  type a marker into the editor and save with Ctrl+S; the time is from the
//  key to the page-save answer, and to the network going quiet after it
async function saveNow(p, ins, tag) {
  const mark = tag + '-' + Date.now();
  await p.evaluate((m) => {
    const s = document.getElementById('src');
    s.focus(); s.value = s.value.replace(/\nsaved-\S+\n?$/, '') + '\nsaved-' + m + '\n';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, mark);
  const i0 = ins.log.length;
  const t0 = Date.now();
  await pressChord(p, 'KeyS', ['Control']);
  let r = null;
  for (; Date.now() - t0 < 40000;) {
    r = ins.log.slice(i0).find((x) => /\/(page-save|remote-save)\?/.test(x.url));
    if (r && r.done) break;
    await sleep(20);
  }
  if (!r || !r.done) throw new Error('no page-save answer');
  const answered = r.endWall - t0;
  //  quiet: no non-stream request in flight for 400 ms
  let quietAt = Date.now();
  for (const tq = Date.now(); Date.now() - tq < 20000;) {
    const open = ins.log.slice(i0).filter((x) => !x.done && !isStream(x.url));
    if (open.length) quietAt = Date.now();
    else if (Date.now() - quietAt > 400) break;
    await sleep(50);
  }
  const b = split(r);
  return { ms: answered, settled: quietAt - t0, preReq: r.wall - t0,
    queued: b?.queued, server: b?.server, status: r.status };
}

// ── one run ────────────────────────────────────────────────────────────────
async function oneRun(browser, vpName, run) {
  const vp = VIEWPORTS[vpName];
  const ctx = await browser.createBrowserContext();
  const page = await openPage(ctx, env, { viewport: vp });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const ins = await instrument(page);
  const out = {};
  //  a scenario left out by --only still runs, unreported: the ones after
  //  it start from the state it leaves
  const m = async (name, fn) => { const r = await meter(ins, fn); if (on(name)) out[name] = r; };
  const first = P(0), open = P(1 + run), other = P(10 + run);

  // cold: a fresh profile to an editor showing the page, ready to type
  await m('cold', async () => {
    const t0 = Date.now();
    await page.goto(env.app + '?name=' + Q(first), { waitUntil: 'domcontentloaded', timeout: 90000 });
    const dcl = Date.now() - t0;
    await editorShows(page, first);
    return { dcl };
  });
  const c = await caps(page);
  //  the worker installs and takes the page; a warm reload is one it serves
  await until(page, () => !!navigator.serviceWorker?.controller, null, 30000).catch(() => {});
  await sleep(2500);
  await m('warm', async () => {
    const t0 = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
    const dcl = Date.now() - t0;
    await editorShows(page, first);
    return { dcl };
  });
  await sleep(1500);
  await expandPerf(page);
  await sleep(500);

  await m('open-tree', async () => {
    if (!await treeOpen(page, open)) throw new Error('no tree row ' + open);
    await editorShows(page, open);
  });
  await sleep(800);

  //  two documents, then back to the first: tabs where there are tabs
  if (c.tabs) {
    await page.evaluate((n) => window.latTabs.openIn('page', n, { newTab: true }), other);
    await editorShows(page, other);
    await sleep(800);
    await m('switch', async () => {
      await page.evaluate((n) => {
        const s = window.latTabs.state();
        const t = s.tabs.find((x) => x.key === n);
        return window.latTabs.switchTab(t.id);
      }, open);
      await editorShows(page, open);
    });
  } else {
    await treeOpen(page, other); await editorShows(page, other);
    await sleep(800);
    await m('switch', async () => { await treeOpen(page, open); await editorShows(page, open); });
  }
  await sleep(800);

  await m('save-private', () => saveNow(page, ins, 'priv'));
  await sleep(1500);
  {
    await treeOpen(page, SH1); await editorShows(page, SH1); await sleep(800);
    await m('save-shared', () => saveNow(page, ins, 'shr'));
    await sleep(1500);
  }
  if (process.env.PERF_LINK) {
    await page.evaluate(() => {
      const f = [...document.querySelectorAll('#treelist .fld')].find((x) => /^\s*[▸▾]?\s*perf\b/.test(x.textContent));
      if (f && !document.querySelector('#treelist a.pg.lnk')) f.click();
    });
    if (c.tabs) await page.evaluate((n) => window.latTabs.openIn('page', n), LNK);
    else await treeOpen(page, LNK);
    await editorShows(page, LNK).catch(() => {});
    await sleep(1500);
    await m('save-link', () => saveNow(page, ins, 'lnk'));
    await sleep(1500);
  }

  //  the palette (Ctrl+K) where there is one; 72's Ctrl+K was search
  if (c.tabs) {
    await m('palette', async () => {
      await pressChord(page, 'KeyK', ['Control']);
      await until(page, () => { const e = document.getElementById('palette'); return e && !e.hidden; });
      await until(page, () => document.querySelectorAll('#pallist > *').length > 0);
    });
    await page.keyboard.press('Escape'); await sleep(400);
  }
  await m('search', async () => {
    if (c.tabs) await pressChord(page, 'KeyF', ['Control', 'Shift']);
    else await pressChord(page, 'KeyK', ['Control']);
    await until(page, () => document.activeElement?.id === 'qinput');
    const tq = Date.now();
    await page.keyboard.type('perfmark');
    await until(page, () => (document.getElementById('qlist')?.querySelectorAll('a').length || 0) > 0
      || /result/.test(document.getElementById('qsum')?.textContent || ''));
    return { results: Date.now() - tq };
  });
  await page.keyboard.press('Escape'); await sleep(400);
  if (c.tabs) await page.evaluate((n) => window.latTabs.openIn('page', n), open);
  else await treeOpen(page, open);
  await editorShows(page, open).catch(() => {});
  await sleep(600);

  if (c.splits && vpName === 'desktop') {
    await m('split', async () => {
      const g0 = await page.evaluate(() => window.latTabs.groups().length);
      await pressChord(page, 'Backslash', ['Control']);
      await until(page, (n) => {
        const g = window.latTabs.groups();
        const s = window.latTabs.state();
        return g.length === n + 1 && s.shows;
      }, g0);
    });
    //  back to one group: close the new group's tabs
    await page.evaluate(async () => {
      const gs = window.latTabs.groups();
      for (const g of gs.slice(1)) for (const t of g.tabs) await window.latTabs.closeTab(t.id);
    }).catch(() => {});
    await sleep(800);
  }

  if (vpName === 'phone') {
    if (c.drawers) {
      const inView = (id) => until(page, (i) => {
        const r = document.getElementById(i).getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.width > 0
          && !document.getAnimations().some((a) => a.playState === 'running'
            && a.effect?.getTiming().iterations !== Infinity);
      }, id);
      const offScreen = (id) => until(page, (i) => {
        const r = document.getElementById(i).getBoundingClientRect();
        return (r.right <= 0 || r.left >= innerWidth)
          && !document.getAnimations().some((a) => a.playState === 'running'
            && a.effect?.getTiming().iterations !== Infinity);
      }, id);
      await m('drawer-left', async () => { await page.tap('#treet'); await inView('lpane'); });
      await m('drawer-left-close', async () => { await page.touchscreen.tap(380, 420); await offScreen('lpane'); });
      await m('drawer-right', async () => { await page.tap('#ctlt'); await inView('rpane'); });
      await m('drawer-right-close', async () => { await page.touchscreen.tap(10, 420); await offScreen('rpane'); });
    } else if (c.mtabs) {
      //  72: the tree is a view of its own on a phone (.mtabs)
      const show = (v, sel) => m('drawer-' + v, async () => {
        await page.evaluate((x) => document.querySelector(`.mtabs button[data-mv="${x}"]`).click(), v);
        await until(page, (s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0; }, sel);
      });
      await show('tree', '#treelist');
      await show('code', '#src');
    }
    await sleep(500);
  }

  //  a browser tab's first load, then back and forward inside it
  const R1 = '/apps/lattice?url=' + Q('urb://' + SHIP + '/' + SH1);
  const R2 = '/apps/lattice?url=' + Q('urb://' + SHIP + '/' + SH2);
  if (c.frames) {
    await m('browser-first', async () => {
      await page.evaluate(() => document.getElementById('rb-browser').click());
      await frameReady(page, '^/apps/lattice/?(\\?u=sw\\d+)?$').catch(async (e) => {
        throw new Error(e.message.slice(0, 30) + ' ' + JSON.stringify(await page.evaluate(() => {
          const s = window.latTabs.state(); const k = s.tabs[s.active]?.key;
          return { k, fs: [...document.querySelectorAll('iframe[data-tool]')].map((f) => {
            try { return f.dataset.tool + ' ' + f.hidden + ' ' + f.contentWindow.location.href + ' ' + f.contentDocument.readyState; } catch { return 'x'; } }) };
        })));
      });
    });
    const key = await frameKeyFront(page);
    const go = async (u, mk) => {
      await page.evaluate(([k, x]) => { document.querySelector(`iframe[data-tool="${k}"]`).contentWindow.location.href = x; }, [key, u]);
      await frameHas(page, key, mk, mk === marker(SH1) ? SH1 : SH2);
    };
    await go(R1, marker(SH1)); await sleep(1200);
    await go(R2, marker(SH2)); await sleep(1200);
    await m('back', async () => {
      await page.evaluate(() => document.querySelector('.fhead:not([hidden]) [data-fh=back], [data-fh=back]').click());
      await frameHas(page, key, marker(SH1), SH1);
      return { at: await frameAt(page, key) };
    });
    await sleep(1200);
    await m('forward', async () => {
      await page.evaluate(() => document.querySelector('.fhead:not([hidden]) [data-fh=fwd], [data-fh=fwd]').click());
      await frameHas(page, key, marker(SH2), SH2);
      return { at: await frameAt(page, key) };
    });
  } else {
    //  72: the reader in a window of its own
    const w = await ctx.newPage();
    await w.setViewport(vp);
    const wins = await instrument(w);
    const wm = async (name, fn) => { const r = await meter(wins, fn); if (on(name)) out[name] = r; };
    await wm('browser-first', async () => {
      await w.goto(env.base + '/apps/lattice', { waitUntil: 'load', timeout: 90000 });
    });
    const has = (mk) => until(w, (x) => document.body?.textContent.includes(x) && document.readyState === 'complete', mk);
    await w.goto(env.base + R1, { waitUntil: 'load' }); await has(marker(SH1)); await sleep(1200);
    await w.goto(env.base + R2, { waitUntil: 'load' }); await has(marker(SH2)); await sleep(1200);
    await wm('back', async () => { await w.goBack({ waitUntil: 'domcontentloaded' }); await has(marker(SH1)); });
    await sleep(1200);
    await wm('forward', async () => { await w.goForward({ waitUntil: 'domcontentloaded' }); await has(marker(SH2)); });
    await w.close();
  }
  if (c.forum) {
    await m('forum-first', async () => {
      await page.evaluate(() => document.getElementById('rb-forum').click());
      await frameReady(page, '^/apps/lattice/forum');
    });
  }
  await ctx.close();
  return out;
}

const frameAt = (p, key) => p.evaluate((k) => {
  try { return decodeURIComponent(document.querySelector(`iframe[data-tool="${k}"]`).contentWindow.location.search); }
  catch { return null; }
}, key);
const frameHas = (p, key, mk, name) => until(p, ([k, x, n]) => {
  const f = document.querySelector(`iframe[data-tool="${k}"]`);
  try {
    const d = f.contentDocument;
    if (d.readyState !== 'complete') return false;
    if (n && !decodeURIComponent(f.contentWindow.location.search).includes('/' + n)) return false;
    if (d.body.textContent.includes(x)) return true;
    //  the reader paints a page in a srcdoc frame of its own
    return [...d.querySelectorAll('iframe')].some((i) => {
      try { return i.contentDocument.body.textContent.includes(x); } catch { return false; }
    });
  } catch { return false; }
}, [key, mk, name || null]);

// ── the costs of parked frames and streams ─────────────────────────────────
//  an editor alone, then with six browser tabs and a forum tab parked: the
//  main thread over 10 s idle, streams held, and a save's time and split
async function frameCost(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await openPage(ctx, env, { viewport: VIEWPORTS.desktop });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  const ins = await instrument(page);
  await page.goto(env.app + '?name=' + Q(P(2)), { waitUntil: 'domcontentloaded', timeout: 90000 });
  await editorShows(page, P(2));
  await sleep(4000);
  const idle = () => meter(ins, async () => { await sleep(10000); });
  const out = { idle0: await idle() };
  const saves0 = [];
  for (let i = 0; i < RUNS; i++) { saves0.push(await meter(ins, () => saveNow(page, ins, 'f0'))); await sleep(1500); }
  out.save0 = saves0;
  if (await page.evaluate(() => !!document.getElementById('rb-browser'))) {
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => document.getElementById('rb-browser').click());
      await frameReady(page, '^/apps/lattice/?(\\?u=sw\\d+)?$').catch(() => {});
      await sleep(1500);
    }
    await page.evaluate(() => document.getElementById('rb-forum')?.click());
    await frameReady(page, '^/apps/lattice/forum').catch(() => {});
    await sleep(1500);
    await page.evaluate((n) => window.latTabs.openIn('page', n), P(2));
    await editorShows(page, P(2));
    await sleep(4000);
    out.frames = await page.evaluate(() => document.querySelectorAll('#toolhost iframe').length);
    out.idle7 = await idle();
    out.openStreams = ins.log.filter((r) => isStream(r.url) && !r.done).length;
    const saves7 = [];
    for (let i = 0; i < RUNS; i++) { saves7.push(await meter(ins, () => saveNow(page, ins, 'f7'))); await sleep(1500); }
    out.save7 = saves7;
  }
  out.allOpenStreams = ins.log.filter((r) => isStream(r.url) && !r.done).map((r) => r.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 90));
  await ctx.close();
  return out;
}

// ── the reader page cache: how long a stale view takes to converge ─────────
//  ui-pagecache's "next view is fresh": a page saved behind a cached view;
//  after the stale paint, how long until the cache holds the new text, and
//  whether a view 10 s later (the suite's wait) shows it
async function pageCache(browser) {
  const ctx = await browser.createBrowserContext();
  const p = await openPage(ctx, env);
  const url = env.base + '/apps/lattice?url=' + Q('urb://' + SHIP + '/' + SH2);
  const cached = (u) => p.evaluate(async (x) => {
    const c = await caches.open('lattice-pages'); const r = await c.match(x);
    return r ? r.text() : null;
  }, u).catch(() => null);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 60 && !(await cached(url)); i++) await sleep(1000);
  const res = [];
  for (let i = 0; i < RUNS; i++) {
    const stamp = 'pc-' + Date.now();
    await p.goto(env.base + '/apps/lattice', { waitUntil: 'domcontentloaded' });
    await api('page-save?name=' + Q(SH2) + '&type=md', { method: 'POST',
      body: '# shared two\n\n' + marker(SH2) + '\n\n' + stamp + '\n' });
    //  the ship serves it
    const t0 = Date.now();
    let served = null;
    for (; Date.now() - t0 < 30000;) {
      const r = await fetch(url, { headers: { Cookie: env.cookie } });
      if ((await r.text()).includes(stamp)) { served = Date.now() - t0; break; }
      await sleep(250);
    }
    const t1 = Date.now();
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    const paint = Date.now() - t1;
    let stale = null;
    for (let k = 0; k < 5 && stale === null; k++)
      stale = await p.content().then((h) => !h.includes(stamp), () => null) ?? (await sleep(300), null);
    let fresh = null;
    for (; Date.now() - t1 < 40000;) {
      if ((await cached(url))?.includes(stamp)) { fresh = Date.now() - t1; break; }
      await sleep(200);
    }
    res.push({ served, paint, stale, cacheFresh: fresh, within10s: fresh !== null && fresh <= 10000 });
    await sleep(2000);
  }
  await ctx.close();
  return res;
}

// ── server side ────────────────────────────────────────────────────────────
async function routes() {
  const R = {
    'app': 'app', 'app.js': 'app/app.js', 'page-dump': 'page-dump', 'page-tree': 'page-tree',
    'page-source': 'page-source?name=' + Q(P(3)), 'shared-with-me': 'shared-with-me',
    'share-groups': 'share-groups', 'streams': 'streams', 'reader-home': '',
    'reader-page': '?url=' + Q('urb://' + SHIP + '/' + SH1), 'forum': 'forum',
  };
  const out = {};
  for (const [k, path] of Object.entries(R)) {
    const ts = []; let st = 0, size = 0;
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      const r = await fetch(env.base + '/apps/lattice' + (path ? '/' + path : ''), { headers: { Cookie: env.cookie }, redirect: 'manual' });
      const b = await r.arrayBuffer();
      ts.push(Math.round(performance.now() - t0)); st = r.status; size = b.byteLength;
    }
    out[k] = { ms: med(ts), status: st, kb: Math.round(size / 1024) };
  }
  for (const [k, name] of [['page-save', P(4)], ['page-save-shared', SH1]]) {
    const ts = [];
    for (let i = 0; i < RUNS; i++) {
      const body = (await (await api('page-source?name=' + Q(name))).json()).body;
      const t0 = performance.now();
      await (await api('page-save?name=' + Q(name) + '&type=md', { method: 'POST', body: body.replace(/\nsrv-\d+\n?$/, '') + '\nsrv-' + i + '\n' })).arrayBuffer();
      ts.push(Math.round(performance.now() - t0));
      await sleep(500);
    }
    out[k] = { ms: med(ts) };
  }
  return out;
}

// ── aggregate ──────────────────────────────────────────────────────────────
const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
function medianOf(runs) {
  const out = {};
  const names = [...new Set(runs.flatMap((r) => Object.keys(r)))];
  for (const n of names) {
    const rs = runs.map((r) => r[n]).filter(Boolean);
    const keys = [...new Set(rs.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'ok' && k !== 'err');
    out[n] = { n: rs.filter((r) => r.ok).length };
    for (const k of keys) out[n][k] = med(rs.map((r) => r[k]));
    const errs = rs.filter((r) => r.err).map((r) => r.err);
    if (errs.length) out[n].errs = [...new Set(errs)];
  }
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────
const appJs = await fetch(env.base + '/apps/lattice/app/app.js', { headers: { Cookie: env.cookie } });
const result = {
  label: LABEL, ship: SHIP, base: env.base, at: new Date().toISOString(), runs: RUNS, load: LOAD,
  version: await (await fetch(env.base + '/grubbery/api/file/lattice-dev/code/version.json',
    { headers: { Cookie: env.cookie } })).json().then((j) => j.version, () => null),
  appJsKB: Math.round((await appJs.arrayBuffer()).byteLength / 1024),
};
await fixtures();
if (arg('link-host', null)) {
  process.env.PERF_LINK = (await linkFixture(arg('link-host'), arg('link-cookie'))) ? '1' : '';
  result.link = !!process.env.PERF_LINK;
}
await sleep(3000);
if (LOAD) startLoad(LOAD);
const browser = await launchBrowser({ args: ['--disable-dev-shm-usage'] });
//  each section on its own: one that throws is reported, the rest still run,
//  and with --out FILE the JSON so far is written after every section
const section = async (k, fn) => {
  try { result[k] = await fn(); } catch (e) { result[k] = { err: String(e.message).slice(0, 300) }; }
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 1));
};
try {
  if (!flag('no-scenarios')) for (const vp of VPS) {
    const runs = [];
    await section(vp, async () => {
      for (let i = 0; i < RUNS; i++) {
        try { runs.push(await oneRun(browser, vp, i)); }
        catch (e) { runs.push({ _run: { ok: false, err: String(e.message).slice(0, 160) } }); }
        process.stderr.write(`  ${vp} run ${i + 1}/${RUNS}\n`);
      }
      return medianOf(runs);
    });
    if (process.env.PERF_RAW) result[vp + 'Raw'] = runs;
  }
  if (flag('frames')) await section('frames', async () => {
    const f = await frameCost(browser);
    return { ...f, save0: medianOf(f.save0.map((s) => ({ s }))).s,
      save7: f.save7 ? medianOf(f.save7.map((s) => ({ s }))).s : null };
  });
  if (flag('pagecache')) await section('pagecache', () => pageCache(browser));
} finally {
  loading = false;
  await browser.close();
}
if (flag('routes')) await section('routes', routes);
console.log(JSON.stringify(result, null, 1));
