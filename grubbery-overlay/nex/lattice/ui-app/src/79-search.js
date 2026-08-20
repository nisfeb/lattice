  // ── search: <lat-search> ─────────────────────────────────────────────────
  // Grep, not an index.
  //
  // The first version queried /content-search, the term index. Two things were
  // wrong with that and only one was obvious. The obvious one: the index is
  // exact whole words, so "zaphod" does not find "zaphodbeeblebrox" and
  // "markers" does not find "marker". Searching as you type then says "nothing
  // matches" for every keystroke until you finish a word.
  //
  // The one that actually decides it: THE INDEX IS STALE. It is rebuilt by
  // /search-reindex and by nothing else, so a page written a minute ago is not
  // in it. In a tool you write into all day, the material you most want to find
  // is exactly the material the index does not have.
  //
  // The client already holds the corpus. page-dump carries every page body
  // inline and is refetched as the tree changes, so a substring scan over what
  // is already in memory is live, matches partial words and phrases, costs no
  // request per keystroke, and needs no index to maintain. For a personal store
  // this is milliseconds.
  //
  // What the dump does NOT carry is the share mode, which is why /page-scopes
  // exists. A results list that cannot say which hits are published would show
  // private notes and clearweb pages looking identical, on a screen someone may
  // be sharing. That badge is a safety signal, so it is worth one request.
  customElements.define('lat-search', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="aclwrap" id="qwrap" hidden role="dialog" aria-modal="true" aria-label="search">
  <div class="aclbar">
    <h2>Search</h2>
    <input id="qinput" placeholder="search your pages and notes" autocomplete="off" spellcheck="false">
    <span class="muted" id="qsum"></span>
    <span class="grow"></span>
    <button id="qclose">close</button>
  </div>
  <div class="aclbody">
    <div id="qlist"></div>
  </div>
</div>`;
    }
  });

  // Loaded when the panel opens, not per keystroke: the scopes and the
  // memories are two requests, and then every keystroke is local.
  let qScopes = null;          // path -> 'private' | 'urbit' | 'clearweb'
  let qKnow = [];              // [{key, body}]
  let qLoading = null;         // in-flight load, shared
  //  Opening the panel starts this, and the first keystroke wants it too. The
  //  pier serialises, so letting both fire meant four queued requests and a
  //  wait long enough to look like a hang. One load, both await it.
  function qLoadContext() {
    if (qLoading) return qLoading;
    qLoading = qLoadContextOnce().finally(() => { qLoading = null; });
    return qLoading;
  }
  async function qLoadContextOnce() {
    try {
      const r = await fetch(api + '/page-scopes');
      if (r.ok) {
        const m = new Map();
        for (const it of ((await r.json()).items || [])) m.set(it.path, it.scope);
        qScopes = m;
      }
    } catch {}
    try {
      const r = await fetch(api + '/know-all');
      if (r.ok) qKnow = (await r.json()).items || [];
    } catch {}
  }

  // non-overlapping occurrence count: split yields pieces-1 = matches. The
  // empty-needle guard stays, since split('') would count every character.
  const qCount = (hay, needle) => needle ? hay.split(needle).length - 1 : 0;
  // a line of context around the hit, the way grep shows it
  const qSnip = (body, at, len) => {
    const from = Math.max(0, at - 40);
    const to = Math.min(body.length, at + len + 40);
    return (from ? '…' : '') + body.slice(from, to).replace(/\s+/g, ' ') + (to < body.length ? '…' : '');
  };

  let qSeq = 0;
  async function runSearch(raw) {
    const host = $('qlist');
    const sum = $('qsum');
    const q = String(raw || '').trim().toLowerCase();
    if (q.length < 2) {
      host.className = 'aclempty';
      host.textContent = 'type at least two characters';
      sum.textContent = '';
      return;
    }
    const mine = ++qSeq;
    if (!qScopes) {
      //  the exposure map and the memories are fetched once per open, and on a
      //  slow pier that is seconds. Say so, rather than showing an empty panel
      //  that reads as "no results".
      host.className = 'aclempty';
      host.textContent = 'searching\u2026';
      await qLoadContext();
      if (mine !== qSeq) return;
    }

    const out = [];
    let skipped = 0;
    for (const n of nodes) {
      if (!n.page) continue;
      // A body over the dump's inline cap is not here, only its size. Say so
      // rather than quietly returning a result set that is missing pages.
      if (typeof n.body !== 'string') { skipped += 1; continue; }
      const hay = n.body.toLowerCase();
      const at = hay.indexOf(q);
      const inPath = n.path.toLowerCase().includes(q);
      if (at < 0 && !inPath) continue;
      out.push({
        key: n.path,
        // NOT defaulted to 'private'. If the exposure lookup failed, or the
        // page is newer than it, calling it private would be a false safety
        // signal on a clearweb page: exactly the misread this badge exists to
        // prevent. Unknown says unknown.
        scope: (qScopes && qScopes.get(n.path)) || 'unknown',
        hits: at < 0 ? 0 : qCount(hay, q),
        inPath,
        snip: at < 0 ? '' : qSnip(n.body, at, q.length),
        know: false,
      });
    }
    for (const k of qKnow) {
      const body = String(k.body || '');
      const key = String(k.key || '').replace(/^\/+/, '');
      const hay = body.toLowerCase();
      const at = hay.indexOf(q);
      const inPath = key.toLowerCase().includes(q);
      if (at < 0 && !inPath) continue;
      out.push({
        key, scope: 'knowledge', hits: at < 0 ? 0 : qCount(hay, q),
        inPath, snip: at < 0 ? '' : qSnip(body, at, q.length), know: true,
      });
    }

    // a name match is what you meant more often than a body match, then
    // whichever mentions it most
    out.sort((a, b) => (b.inPath - a.inPath) || (b.hits - a.hits) || a.key.localeCompare(b.key));

    sum.textContent = (out.length ? out.length + ' result' + (out.length === 1 ? '' : 's') : '')
      + (skipped ? (out.length ? ' · ' : '') + skipped + ' large page(s) not scanned' : '');
    host.textContent = '';
    if (!out.length) {
      host.className = 'aclempty';
      host.textContent = 'nothing matches that';
      return;
    }
    host.className = '';
    const ul = document.createElement('ul');
    ul.className = 'qlist';
    for (const h of out.slice(0, 100)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      const b = document.createElement('span');
      b.className = 'qbadge ' + h.scope;
      b.textContent = h.scope;
      const n = document.createElement('span');
      n.className = 'qname';
      n.textContent = h.key;                 // textContent: names are content
      a.appendChild(b);
      a.appendChild(n);
      if (h.snip) {
        const s = document.createElement('span');
        s.className = 'qprev muted';
        s.textContent = h.snip;              // and so are bodies
        a.appendChild(s);
      }
      a.onclick = (e) => {
        e.preventDefault();
        qClose();
        if (h.know) openKnow(h.key); else openPage(h.key);
      };
      li.appendChild(a);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

  const qClose = () => { $('qwrap').hidden = true; };
  const qOpen = () => {
    $('qwrap').hidden = false;
    const i = $('qinput');
    i.value = '';
    i.focus();
    $('qlist').className = 'aclempty';
    $('qlist').textContent = 'type at least two characters';
    $('qsum').textContent = '';
    qScopes = null;                          // refresh exposure each open
    qLoadContext();
  };

  // Local now, so this can be short. It exists to avoid rescanning on every
  // keystroke of a fast typist, not to avoid requests.
  let qTimer = null;
  $('qinput').oninput = () => {
    clearTimeout(qTimer);
    const v = $('qinput').value;
    qTimer = setTimeout(() => runSearch(v), 80);
  };
  $('qinput').onkeydown = (e) => {
    if (e.key === 'Enter') { clearTimeout(qTimer); runSearch($('qinput').value); }
  };
  $('qclose').onclick = qClose;
  $('qt').onclick = qOpen;

  // CAPTURE phase on window, so nothing downstream can swallow it. Vim mode's
  // handler is capture-phase on the textarea and consumes normal-mode keys
  // whole; being ahead of it is more robust than listing exemptions there.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('qwrap').hidden) { qClose(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      e.stopPropagation();
      if ($('qwrap').hidden) qOpen(); else qClose();
    }
  }, true);
