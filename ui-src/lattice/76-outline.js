  // ── right pane: Outgoing, Outline, Comments, and what follows the document ─
  // The right pane's tabs are about the document in front. Outgoing and
  // Outline read its text, the rest fetch, and all of them repaint when the
  // document changes: setOpen (every open, tab switch and mode change goes
  // through it) fires 'input' on the name field, resetPanels runs on every
  // fresh paint of a page or memory, and the editor's render tells them the
  // text moved. A tab that does not apply to what is in front says so in
  // one line, and never hides: a tab strip that changes shape under the
  // pointer is worse than one that is sometimes empty.

  // The link targets the preview renderer (59-md.js) makes of a document,
  // deduped, in order. Read off its own output, so a link here is exactly a
  // link there: fences, images, unsafe schemes and escaping all come out the
  // same. A page link comes back as its page name, a urb:// link as itself.
  function outLinks(body, kind) {
    const html = kind === 'md' ? mdToHtml(body) : kind === 'gmi' ? gmiToHtml(body) : '';
    const out = [];
    for (const m of html.matchAll(/<a href="([^"]*)"/g)) {
      let t = mdUnesc(m[1]);
      const pg = /^\/apps\/lattice\/app\?name=([^&#]*)$/.exec(t);
      const urb = /^\/apps\/lattice\?url=(urb:\/\/.*)$/.exec(t);
      if (pg) { try { t = decodeURIComponent(pg[1]); } catch { continue; } }
      else if (urb) t = urb[1];
      else if (t.startsWith('#')) continue;      // an anchor in the page itself
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  // The headings of a document, by the rules the same renderer uses: md
  // #..###### with a space, gmi #..### with one, nothing inside a fence.
  // `line` counts from 1.
  function outline(body, kind) {
    const out = [];
    if (kind !== 'md' && kind !== 'gmi') return out;
    const lines = String(body == null ? '' : body).split('\n');
    let fence = null;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (kind === 'gmi') {
        if (ln.trimEnd() === '```') { fence = fence ? null : '```'; continue; }
        if (fence) continue;
      } else {
        if (fence) { if (ln.trimStart().startsWith(fence)) fence = null; continue; }
        const f = ln.match(/^\s*(```|~~~)/);
        if (f) { fence = f[1]; continue; }
      }
      const h = ln.match(kind === 'gmi' ? /^(#{1,3}) (.*)$/ : /^(#{1,6})\s+(.*)$/);
      if (h) out.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });
    }
    return out;
  }

  const rpSec = (id) => document.querySelector('#rbody > [data-pane=' + id + ']');
  const NONE = '<p class="rpnone muted" hidden>Nothing here for this tab.</p>';
  rpSec('out').innerHTML = NONE + '<div id="outsec"><h3>outgoing links</h3><div id="outlist"></div></div>';
  rpSec('outline').innerHTML = NONE + '<div id="olsec"><h3>outline</h3><div id="ollist"></div></div>';
  rpSec('comments').innerHTML = NONE + `<div id="rpcmsec">
  <h3>comments on this page</h3>
  <div id="rpcmlist"></div>
  <textarea id="rpcmbody" rows="3" placeholder="Write a comment"></textarea>
  <div class="row"><span id="rpcmnote" class="muted grow"></span><button id="rpcmpost">Post</button></div>
</div>`;
  for (const id of ['back', 'hist']) rpSec(id).insertAdjacentHTML('afterbegin', NONE);

  // What is in front, as the pane sees it: a page (named or not yet), a
  // memory, a grub, or nothing it has tabs for (a folder, an empty editor
  // after a close, a tab kind with no document such as a tool).
  const rpDoc = () => {
    if (activeTab && !['page', 'know', 'grub'].includes(activeTab.kind)) return null;
    if (grubPath) return { kind: 'grub', key: grubPath };
    if (curFolder !== null) return null;
    return { kind: mode === 'know' ? 'know' : 'page', key: current };
  };
  // Outgoing and Outline need text a renderer reads. History needs a
  // document with revisions, so a saved page or memory. Backlinks and
  // Comments are about pages.
  const rpApplies = (id, d) => !!d && (
    id === 'out' || id === 'outline' ? d.kind !== 'grub'
      : id === 'hist' ? d.kind !== 'grub' && !!d.key
        : d.kind === 'page' && !!d.key);
  const RP_BODY = { out: 'outsec', outline: 'olsec', back: 'linksec', comments: 'rpcmsec', hist: 'histsec' };
  const rpText = () => (mode === 'know' ? 'md' : pkind.value);

  // which fetched tab holds which document ('page:a/b'). A tab whose entry
  // differs from what is in front loads when it is next seen.
  const rpLoaded = {};
  let rpTimer = 0;
  let rpForce = null;
  function rpPaint() {
    rpTimer = 0;
    const force = rpForce;
    rpForce = null;
    const d = rpDoc();
    const key = d && d.key ? d.kind + ':' + d.key : null;
    for (const id of Object.keys(RP_BODY)) {
      const ok = rpApplies(id, d);
      rpSec(id).querySelector('.rpnone').hidden = ok;
      $(RP_BODY[id]).hidden = !ok;
      if (!ok || !paneShows('r', id)) continue;
      if (id === 'out') paintOut();
      else if (id === 'outline') paintOutline();
      else if (force === id || rpLoaded[id] !== key) {
        rpLoaded[id] = key;
        if (id === 'back') loadBacklinks();
        else if (id === 'hist') loadHistory();
        else loadPageComments();
      }
    }
    $('cmtrow').hidden = !(d && d.kind === 'page' && d.key);
  }
  // Always deferred: the callers are mid-paint (setOpen comes before the
  // body lands), and some run while later files are still loading.
  function rpSoon(ms = 30) {
    clearTimeout(rpTimer);
    rpTimer = setTimeout(rpPaint, ms);
  }
  pname.addEventListener('input', () => rpSoon());
  // typing repaints Outgoing and Outline once it pauses
  rpHook = () => rpSoon(300);
  // a tab brought forward shows its document now, and a fetched one fresh
  document.addEventListener('lat-pane', (e) => {
    if (e.detail.side !== 'r') return;
    rpForce = e.detail.id;
    rpSoon(0);
  });
  rpSoon(0);

  // ── Outgoing ─────────────────────────────────────────────────────────────
  // A page target opens through the tab model, so Ctrl/Cmd and the middle
  // button open it in a new tab. A page not in the tree is muted: following
  // it creates it. A web or urb:// target is an ordinary link.
  function paintOut() {
    const host = $('outlist');
    host.textContent = '';
    const links = outLinks(src.value, rpText());
    if (!links.length) {
      host.innerHTML = '<div class="muted">no outgoing links</div>';
      return;
    }
    for (const t of links) {
      const a = document.createElement('a');
      a.className = 'olrow';
      a.textContent = t;
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/')) {
        a.href = t.startsWith('urb://') ? '/apps/lattice?url=' + t : t;
        if (/^https?:/i.test(t)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      } else {
        a.href = '/apps/lattice/app?name=' + encodeURIComponent(t);
        if (!nodes.some((n) => n.page && n.path === t)) {
          a.classList.add('muted');
          a.title = t + ' does not exist yet';
        }
        tabLink(a, 'page', t);
      }
      host.append(a);
    }
  }

  // ── Outline ──────────────────────────────────────────────────────────────
  // A click puts the caret on that heading's line and brings it into view.
  // In Read the preview scrolls instead, to the heading of the same index.
  function paintOutline() {
    const host = $('ollist');
    host.textContent = '';
    const hs = outline(src.value, rpText());
    if (!hs.length) {
      host.innerHTML = '<div class="muted">no headings</div>';
      return;
    }
    hs.forEach((h, i) => {
      const a = document.createElement('a');
      a.className = 'olrow';
      a.href = '#';
      a.style.paddingLeft = (h.level - 1) * 12 + 'px';
      a.textContent = h.text || '(untitled)';
      a.onclick = (e) => { e.preventDefault(); goHeading(h.line, i); };
      host.append(a);
    });
  }
  function goHeading(line, idx) {
    if ($('ws').classList.contains('vp')) {
      let doc = null;
      try { doc = prev.contentDocument; } catch {}
      const el = doc && doc.querySelectorAll('h1, h2, h3, h4, h5, h6')[idx];
      if (el) el.scrollIntoView({ block: 'start' });
      return;
    }
    const lines = src.value.split('\n');
    let off = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) off += lines[i].length + 1;
    src.focus();
    src.setSelectionRange(off, off);
    // the textarea soft-wraps, so this is near the line, not on it. A third
    // of the way down leaves room for the error of a few wrapped lines.
    const lh = parseFloat(getComputedStyle(src).lineHeight) || 20;
    src.scrollTop = Math.max(0, (line - 1) * lh - src.clientHeight / 3);
    sync();
  }

  // ── Comments ─────────────────────────────────────────────────────────────
  // This page's share of the inbox (73-comments.js), with remove as there,
  // and a box to post one as the owner. A post only lands while comments
  // are on for the page (the ship drops it otherwise), so the box says so
  // and stays shut while they are off.
  async function loadPageComments() {
    const host = $('rpcmlist');
    const want = current;
    paintCmBox();
    host.className = 'muted';
    host.textContent = 'loading…';
    let d = null;
    try {
      const r = await fetch(api + '/comments-inbox');
      if (!r.ok) { host.textContent = ''; st('comments failed' + await errText(r), false); return; }
      d = await r.json();
    } catch { host.textContent = ''; st('comments failed', false); return; }
    if (current !== want) return;
    const items = (d.items || []).filter((c) => c.page === want);
    renderComments(items.length, {
      host, items, sum: null, pageLink: false,
      reload: () => { rpForce = 'comments'; rpSoon(0); },
      empty: 'No comments on this page.',
    });
  }
  function paintCmBox() {
    const off = cmtFor !== current || cmtOn !== true;
    $('rpcmbody').disabled = off;
    $('rpcmpost').disabled = off;
    $('rpcmnote').textContent = cmtFor === current && cmtOn === false
      ? 'Comments are off for this page. Switch them on in the Page tab.' : '';
  }
  $('rpcmpost').onclick = async () => {
    const page = current;
    const body = $('rpcmbody').value.trim();
    if (!page || !body) return;
    $('rpcmpost').disabled = true;
    // the route answers a form post with a redirect to the reader. Not
    // followed: landing is all this needs to know.
    const r = await fetch(api + '/comment?page=' + encodeURIComponent(page), {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'body=' + encodeURIComponent(body),
    }).catch(() => null);
    $('rpcmpost').disabled = false;
    if (!r || !(r.ok || r.type === 'opaqueredirect')) { st('comment failed' + await errText(r), false); return; }
    if (current === page) $('rpcmbody').value = '';
    st('comment posted');
    // the write is its own transaction behind the answer
    setTimeout(() => { if (current === page) { rpForce = 'comments'; rpSoon(0); } }, 1500);
  };
