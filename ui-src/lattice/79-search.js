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
  let qKnowFailed = false;     // /know-all never answered this panel-open
  let qLoading = null;         // in-flight load, shared
  // never-loaded and load-failed are different states. qCtxAttempts counts
  // how many times qLoadContextOnce has actually run since the panel opened,
  // capped at two: the open-time load and one retry. A failure short of that
  // cap is worth trying again; past it, every keystroke would otherwise fire
  // the same doomed pair of requests forever.
  let qCtxAttempts = 0;
  // last painted hits and their rows, so ArrowUp/Down + Enter can act on
  // what is actually on screen without rescanning
  let qResults = [];
  let qRows = [];
  let qSel = -1;
  //  Opening the panel starts this, and the first keystroke wants it too. The
  //  pier serialises, so letting both fire meant four queued requests and a
  //  wait long enough to look like a hang. One load, both await it.
  function qLoadContext() {
    if (qLoading) return qLoading;
    qLoading = qLoadContextOnce().finally(() => { qLoading = null; });
    return qLoading;
  }
  async function qLoadContextOnce() {
    qCtxAttempts += 1;
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
      if (r.ok) { qKnow = (await r.json()).items || []; qKnowFailed = false; }
      else qKnowFailed = true;
    } catch { qKnowFailed = true; }
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

  //  one hit builder for both corpora. A page and a memory differ only in
  //  where the key and the body come from, and in what the badge says.
  const qHit = (key, body, q, scope, know) => {
    const hay = body.toLowerCase();
    const at = hay.indexOf(q);
    const inPath = key.toLowerCase().includes(q);
    if (at < 0 && !inPath) return null;
    return {
      key, scope, inPath, know,
      hits: at < 0 ? 0 : qCount(hay, q),
      snip: at < 0 ? '' : qSnip(body, at, q.length),
    };
  };

  //  the scan is pure: it reads the corpora already in memory and returns the
  //  ranked hits plus how many pages it could not look inside.
  function qScan(q) {
    const out = [];
    let skipped = 0;
    for (const n of nodes) {
      if (!n.page) continue;
      // A body over the dump's inline cap is not here, only its size. Say so
      // rather than quietly returning a result set that is missing pages.
      if (typeof n.body !== 'string') { skipped += 1; continue; }
      // NOT defaulted to 'private'. If the exposure lookup failed, or the
      // page is newer than it, calling it private would be a false safety
      // signal on a clearweb page: exactly the misread this badge exists to
      // prevent. Unknown says unknown.
      const h = qHit(n.path, n.body, q, (qScopes && qScopes.get(n.path)) || 'unknown', false);
      if (h) out.push(h);
    }
    for (const k of qKnow) {
      const h = qHit(String(k.key || '').replace(/^\/+/, ''),
        String(k.body || ''), q, 'knowledge', true);
      if (h) out.push(h);
    }
    // a name match is what you meant more often than a body match, then
    // whichever mentions it most
    out.sort((a, b) => (b.inPath - a.inPath) || (b.hits - a.hits) || a.key.localeCompare(b.key));
    return { out, skipped };
  }

  // opening a hit is the same move whether the mouse clicked it or Enter
  // picked it off the highlighted row
  const qOpenResult = (h) => {
    qClose();
    if (h.know) openKnow(h.key); else openPage(h.key);
  };

  // the highlighted row alone, no rebuild: an inline background rather than
  // a class, since the app's .on styling is defined per-component and this
  // list has none of its own yet
  function qHighlight() {
    qRows.forEach((a, i) => { a.style.background = i === qSel ? 'var(--surface)' : ''; });
  }

  //  the summary line and the list. Names and bodies are content, so every
  //  string here goes in through textContent.
  function qPaint(host, sum, out, skipped) {
    const parts = [];
    if (out.length) parts.push(out.length + ' result' + (out.length === 1 ? '' : 's'));
    if (skipped) parts.push(skipped + ' large page(s) not scanned');
    if (qKnowFailed) parts.push('memories not searched');
    sum.textContent = parts.join(' · ');
    host.textContent = '';
    // a fresh result set starts with nothing highlighted
    qSel = -1;
    qRows = [];
    if (!out.length) {
      qResults = [];
      host.className = 'aclempty';
      // nodes starts empty and fills once the page-dump lands, seconds away
      // on a cold load. Zero hits against an empty corpus is not the same
      // claim as zero hits against the real one.
      host.textContent = nodes.some((n) => n.page) ? 'nothing matches that' : 'pages still loading…';
      return;
    }
    host.className = '';
    qResults = out.slice(0, 100);
    const ul = document.createElement('ul');
    ul.className = 'qlist';
    for (const h of qResults) {
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
      a.onclick = (e) => { e.preventDefault(); qOpenResult(h); };
      qRows.push(a);
      li.appendChild(a);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }

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
    // qScopes stays null both before the first load and after a failed one,
    // so gate on the attempt count instead: one retry, then search on with
    // scopes unknown rather than firing the same pair of requests every
    // keystroke a slow or unreachable pier ever gets typed at.
    if (!qScopes && qCtxAttempts < 2) {
      //  the exposure map and the memories are fetched once per open, and on a
      //  slow pier that is seconds. Say so, rather than showing an empty panel
      //  that reads as "no results".
      host.className = 'aclempty';
      host.textContent = 'searching\u2026';
      await qLoadContext();
      if (mine !== qSeq) return;
    }
    const { out, skipped } = qScan(q);
    qPaint(host, sum, out, skipped);
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
    qCtxAttempts = 0;                        // this open gets its own retry
    qResults = [];
    qRows = [];
    qSel = -1;
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
    // the omnibar's pattern: arrows move a highlighted row, Enter opens it.
    // With nothing highlighted, Enter falls through to its old job of
    // re-running the scan.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && qResults.length) {
      e.preventDefault();
      qSel = e.key === 'ArrowDown'
        ? (qSel + 1) % qResults.length
        : (qSel - 1 + qResults.length) % qResults.length;
      qHighlight();
      qRows[qSel].scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      clearTimeout(qTimer);
      if (qSel >= 0 && qResults[qSel]) { e.preventDefault(); qOpenResult(qResults[qSel]); return; }
      runSearch($('qinput').value);
    }
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
