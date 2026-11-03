//  wd-page.mjs: the few puppeteer Page calls the preview fuzzer makes,
//  over W3C WebDriver, so the same walk runs on WebKitGTK (the desktop
//  app's engine) through WebKitWebDriver and its MiniBrowser.
//
//    xvfb-run -a WebKitWebDriver --port=4455 &
//    WD=http://localhost:4455 node scripts/fuzz-preview.mjs --webkit
//
//  Only what the fuzzer needs: evaluate, $('#prev').contentFrame(), a
//  clipped screenshot, a viewport, and keys sent as DOM events (the app's
//  shortcuts listen for keydown, so a synthetic one reaches them).
const MINI = '/usr/libexec/webkit2gtk-4.1/MiniBrowser';

//  WebKitGTK sends a navigation without the session's cookies when it is
//  in a service worker's scope, the worker leaves it to the network (no
//  respondWith), and the session is ephemeral, which a WebDriver session
//  always is. Lattice's worker leaves every reader page to the network
//  (directly, or after its 303 to u=sw<time> on a cache miss), so eyre
//  sees no cookie, mints a guest session, and its Set-Cookie replaces the
//  login: the page and every request after it are a guest's. Fetches from
//  the page and the worker's own fetches keep the cookie, and a persistent
//  session (the desktop app's, any browser window that is not private)
//  keeps it on navigations too. The desktop app's bridge also drops
//  Set-Cookie and signs every request itself, so users do not meet this;
//  only the harness does. So goto() lets the worker go before it opens a
//  lattice page other than the shell, which brings it back on the next
//  load of the app, and fails loudly if the login is gone after a load.
const SHELL = new Set(['/apps/lattice/app', '/apps/lattice/clip', '/apps/lattice/share']);
const underSw = (url) => {
  const u = new URL(url);
  return u.pathname.startsWith('/apps/lattice') && !SHELL.has(u.pathname);
};

export async function wdSession(base = process.env.WD || 'http://localhost:4455') {
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('webdriver ' + path + ': ' + JSON.stringify(j.value || j).slice(0, 200));
    return j.value;
  };
  const s = await call('POST', '/session', { capabilities: { alwaysMatch: {
    'webkitgtk:browserOptions': { binary: process.env.MINIBROWSER || MINI, args: ['--automation'] } } } });
  const sid = '/session/' + s.sessionId;
  const C = (m, p, b) => call(m, sid + p, b);
  //  a function and its arguments as a script body. Returning a promise is
  //  fine: execute/async resolves it.
  const run = (fn, args) => C('POST', '/execute/async', {
    script: 'var done = arguments[arguments.length - 1]; var a = Array.prototype.slice.call(arguments, 0, -1);'
      + 'Promise.resolve().then(function () { return (' + fn.toString() + ').apply(null, a); })'
      + '.then(function (v) { done({ v: v === undefined ? null : v }); }, function (e) { done({ e: String(e && e.message || e) }); });',
    args });
  const evaluate = async (fn, ...args) => {
    const r = await run(fn, args);
    if (r && r.e) throw new Error(r.e);
    return r ? r.v : null;
  };
  await C('POST', '/timeouts', { script: 30000 });
  let onNew = [];
  let login = null;   // the session cookie setCookie wrote, as name=value
  const kept = async () => {
    if (login && !(await evaluate((c) => document.cookie.split('; ').includes(c), login).catch(() => true)))
      throw new Error('wd-page: the session cookie was replaced (a guest session?) at '
        + await evaluate(() => location.href).catch(() => '?'));
  };
  const page = {
    _sid: sid,
    async goto(url) {
      if (underSw(url)) await evaluate(async () => {
        const rs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
        await Promise.all(rs.map((r) => r.unregister()));
      }).catch(() => {});
      await C('POST', '/url', { url });
      for (const f of onNew) await evaluate(f).catch(() => {});
      await kept();
    },
    async reload() {
      await C('POST', '/refresh', {});
      for (const f of onNew) await evaluate(f).catch(() => {});
      await kept();
    },
    evaluate,
    async evaluateOnNewDocument(fn) { onNew.push(fn); },
    //  WebKitWebDriver's add and delete cookie answer success and change
    //  nothing here (2.50), so the session cookie goes in from the page
    //  ...and a late answer (the favicon) can still set a guest session
    //  over it, so it is written until it stays
    async setCookie({ name, value, path }) {
      for (let i = 0; i < 10; i++) {
        await evaluate((n, v, p) => { document.cookie = n + '=' + v + '; path=' + p + '; max-age=86400'; }, name, value, path || '/');
        await new Promise((r) => setTimeout(r, 1000));
        if (await evaluate((n, v) => document.cookie.includes(n + '=' + v), name, value)) {
          login = name + '=' + value;
          return;
        }
      }
      throw new Error('wd-page: the session cookie would not stay');
    },
    async setViewport({ width, height }) {
      //  the window's outer size; the fuzzer reads the inner one anyway
      await C('POST', '/window/rect', { width, height: height + 40 });
    },
    async waitForFunction(fn, { timeout = 30000 } = {}, ...args) {
      const t0 = Date.now();
      for (;;) {
        if (await evaluate(fn, ...args).catch(() => false)) return true;
        if (Date.now() - t0 > timeout) throw new Error('waitForFunction timed out');
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    async focus(sel) { await evaluate((s) => document.querySelector(s).focus(), sel); },
    keyboard: {
      mods: new Set(),
      async down(k) { this.mods.add(k); },
      async up(k) { this.mods.delete(k); },
      async press(k) {
        const ctrl = this.mods.has('Control');
        await evaluate((key, c) => {
          const map = { Backslash: ['\\', 'Backslash'] };
          const [kk, code] = map[key] || [key, 'Key' + key.toUpperCase()];
          const t = document.activeElement || document.body;
          t.dispatchEvent(new KeyboardEvent('keydown', { key: kk, code, ctrlKey: c, bubbles: true, cancelable: true }));
          t.dispatchEvent(new KeyboardEvent('keyup', { key: kk, code, ctrlKey: c, bubbles: true }));
        }, k, ctrl);
      },
      async type(text) {
        await evaluate((t) => {
          const s = document.getElementById('src');
          for (const ch of t) {
            const a = s.selectionStart;
            s.value = s.value.slice(0, a) + ch + s.value.slice(s.selectionEnd);
            s.setSelectionRange(a + 1, a + 1);
            s.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
          }
        }, text);
      },
    },
    async $(sel) {
      if (sel !== '#prev') throw new Error('wd-page: only #prev');
      return {
        contentFrame: async () => ({
          evaluate: async (fn) => {
            const el = await C('POST', '/element', { using: 'css selector', value: '#prev' });
            await C('POST', '/frame', { id: el });
            try { return await evaluate(fn); } finally { await C('POST', '/frame/parent', {}); }
          },
        }),
      };
    },
    async screenshot({ clip }) {
      //  the whole viewport, cropped in the page: WebKitWebDriver has no clip
      const b64 = await C('GET', '/screenshot');
      return { b64, clip };
    },
    async bringToFront() {},
    async close() { await C('DELETE', '', undefined).catch(() => {}); },
    on() {},
    async setRequestInterception() {},
  };
  return page;
}
