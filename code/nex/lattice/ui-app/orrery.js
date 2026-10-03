/* Send a page to orrery, the assistant nexus on the same ship (/apps/orrery).
 * Orrery takes the page as a situation to look after, and follows the page's
 * edits itself, with a keep on its grub (docs/orrery.md). Lattice keeps no
 * follow state and pushes no edits. It sends once, then asks orrery how it
 * stands and shows that.
 *
 * Served standalone at /apps/lattice/app/orrery.js, and loaded by the editor
 * (its controls pane) and by the reader on the owner's own pages (#orw in
 * the bar). Lattice's perf rule is that re-opening a page costs no request,
 * so orrery is asked whether it is installed once per browser session, and
 * for a page's status once per page per session. It is asked again after a
 * send, and only while orrery is reading: every 3 s for a minute, then every
 * 30 s for half an hour. */
(function () {
  'use strict';
  const API = '/apps/orrery/api';
  const TIP = 'Orrery reads this page with its model: the text leaves your ship for the model orrery is configured with, and for nothing else.';
  const memo = (k, v) => {
    try {
      if (v === undefined) return JSON.parse(sessionStorage[k] || 'null');
      sessionStorage[k] = JSON.stringify(v);
    } catch {}
    return null;
  };

  // installed: /api/version answers 200. Asked once a session.
  let up = null;
  const present = () => up || (up = (async () => {
    const m = memo('latOrrUp');
    if (m !== null) return m;
    let ok = false;
    try { ok = (await fetch(API + '/version')).status === 200; } catch {}
    memo('latOrrUp', ok);
    return ok;
  })());

  // a page's standing, cached per path for the session. A failed ask is not
  // cached: the button shows, and the next open asks again.
  async function status(path, fresh) {
    const all = memo('latOrrSt') || {};
    if (!fresh && all[path]) return all[path];
    try {
      const r = await fetch(API + '/follow?path=' + encodeURIComponent(path));
      if (!r.ok) return { status: 'none' };
      const s = await r.json();
      const now = memo('latOrrSt') || {};
      now[path] = s;
      memo('latOrrSt', now);
      return s;
    } catch { return { status: 'none' }; }
  }

  // the lattice-internal links a page makes, as page paths, in order, once
  // each: [[name]] and [[name|label]], links to /apps/lattice/app?name=, and
  // files at /apps/lattice/f/ (uploads; orrery lists them, reads them later)
  const LINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\/apps\/lattice\/app\?(?:[^"'\s)<>#]*&)?name=([^&"'\s)<>#]+)|\/apps\/lattice\/f\/([^"'\s)<>?#]+)/g;
  function links(text, self) {
    const out = [];
    for (const m of String(text || '').matchAll(LINK)) {
      let p = m[1];
      if (p === undefined) { try { p = decodeURIComponent(m[2] !== undefined ? m[2] : m[3]); } catch { continue; } }
      p = p.trim().replace(/^\/+/, '');
      if (p && p !== self && !out.includes(p)) out.push(p);
    }
    return out;
  }

  // a page handed over: what orrery answers, as a status to show
  async function send(path, page) {
    let r, j = {};
    try {
      r = await fetch(API + '/follow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, title: page.title, text: page.text, links: links(page.text, path) }),
      });
      j = await r.json();
    } catch {}
    if (!r) return { status: 'failed', note: 'orrery did not answer' };
    if (!r.ok) return { status: 'failed', note: j.error || 'orrery refused it (' + r.status + ')' };
    return status(path, true);
  }

  // the badge: none, queued, following, resolved, failed
  function draw(el, s, act) {
    el.textContent = '';
    const span = (t, cls) => { const e = document.createElement('span'); e.textContent = t; if (cls) e.className = cls; return e; };
    const button = (t) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.title = TIP; b.onclick = act; return b; };
    if (s.status === 'queued') { el.append(span('orrery is reading…', 'orrnote')); return; }
    if (s.status === 'following') {
      const a = document.createElement('a');
      a.href = '/apps/orrery/#body/' + (s.situation || '');
      a.textContent = a.title = 'followed by orrery · ' + (s.title || 'untitled') + ' · ' + (s.open || 0) + ' open';
      el.append(a, button('send again'));
      return;
    }
    if (s.status === 'resolved') { el.append(span('resolved by orrery: ' + (s.outcome || ''), 'orrnote'), button('send again')); return; }
    if (s.status === 'failed') { el.append(span(s.note || 'orrery could not read it', 'orrnote orrbad'), button('send again')); return; }
    el.append(button('Send to orrery'));
  }

  let styled = false;
  function style() {
    if (styled) return;
    styled = true;
    const st = document.createElement('style');
    // wraps in the editor's narrow pane; one line in the reader's bar, the
    // whole of it on hover
    st.textContent = '.orr{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}'
      + '.orr a{overflow-wrap:anywhere}'
      + '.bar .orr a{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24rem}'
      + '.orrnote{color:var(--muted,#8a8a8a)}.orrbad{color:var(--error,#c0392b)}';
    document.head.append(st);
  }

  // Show `path`'s standing in `el`, and `box` (el by default) only while
  // orrery is installed. A later mount on the same el wins; an earlier one
  // still in flight draws nothing. getPage() -> { title, text }, asked only
  // on a send.
  async function mount(el, path, getPage, box) {
    box = box || el;
    const g = (el.orrGen = (el.orrGen || 0) + 1);
    const live = () => g === el.orrGen;
    if (!(await present()) || !live()) { if (live()) box.hidden = true; return; }
    style();
    el.classList.add('orr');
    box.hidden = false;
    let polls = 0;
    const show = (s) => {
      if (!live()) return;
      draw(el, s, go);
      // reading: every 3 s for a minute (a read takes seconds), then every
      // 30 s for half an hour (orrery retries a down model every five)
      if (s.status === 'queued' && polls++ < 78) setTimeout(async () => { if (live()) show(await status(path, true)); }, polls <= 20 ? 3000 : 30000);
    };
    async function go() {
      polls = 0;
      draw(el, { status: 'queued' }, go);
      const page = await getPage();
      show(await send(path, page));
    }
    show(await status(path, false));
  }
  const unmount = (el) => { el.orrGen = (el.orrGen || 0) + 1; };

  // the reader: #orw sits in the bar of a page view. Only the owner's own
  // pages: the address is urb://<our ship>/<path>.
  async function reader(el) {
    const m = /^urb:\/\/(~[a-z-]+)\/(.+)$/.exec((document.querySelector('.bar input[name=url]') || {}).value || '');
    if (!m) return;
    let ship = null;
    try { ship = localStorage.latShip || null; } catch {}
    if (!ship) {
      try { ship = (await (await fetch('/~/host')).text()).trim(); localStorage.latShip = ship; } catch {}
    }
    if (ship !== m[1]) return;
    const path = m[2].replace(/\/+$/, '');
    mount(el, path, async () => {
      // the page's own source, or, for a page only ever published, its body
      let text = '';
      try {
        const r = await fetch('/apps/lattice/page-source?name=' + encodeURIComponent(path));
        if (r.ok) text = (await r.json()).body || '';
        else text = (await (await fetch('/apps/lattice/fetch?url=' + encodeURIComponent(m[0]))).json()).body || '';
      } catch {}
      return { title: document.title || path, text };
    });
  }

  window.LatticeOrrery = { mount, unmount, links };
  const w = document.getElementById('orw');
  if (w) reader(w);
})();
