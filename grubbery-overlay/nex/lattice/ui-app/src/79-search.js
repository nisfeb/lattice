  // ── search: <lat-search> ─────────────────────────────────────────────────
  // The editor had no search. A tool you write everything into, with no way to
  // find any of it from the place you write, sends you to the reader or to
  // guessing at the tree. The index was already there and already covered the
  // right things, so this is the way in.
  //
  // /content-search is OUR index: pages and knowledge entries, each row
  // carrying the scope recorded when it was indexed. /catalog-search is the
  // crawler's, for peers, and is deliberately NOT queried here. This panel is
  // for finding your own work, and mixing peer results into that makes the
  // common case worse to read.
  //
  // Reuses .aclwrap/.aclbar/.aclbody like the comments panel, rather than
  // growing a third set of overlay styles that would drift from the other two.
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

  // Obelisk has no OR and no LIKE, so a phrase is one request per word and the
  // union happens here. The reader's omnibar already settled this shape; the
  // ranking is the same, and matching it means two surfaces that agree about
  // what "best result" means.
  const qWords = (s) => String(s || '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 2);

  let qSeq = 0;                    // a slower earlier query must not overwrite
  async function runSearch(raw) {
    const host = $('qlist');
    const sum = $('qsum');
    const words = qWords(raw);
    if (!words.length) {
      host.className = 'aclempty';
      host.textContent = 'type at least one word of two letters or more';
      sum.textContent = '';
      return;
    }
    const mine = ++qSeq;
    host.className = 'aclempty';
    host.textContent = 'searching…';

    const hits = new Map();
    const one = async (w) => {
      try {
        const r = await fetch(api + '/content-search?term=' + encodeURIComponent(w));
        if (!r.ok) return;
        const j = await r.json();
        const c = j.columns || [];
        const si = c.indexOf('scope'), ki = c.indexOf('key'), ti = c.indexOf('tf');
        for (const row of (j.rows || [])) {
          const scope = row[si], key = row[ki];
          if (!scope || !key) continue;
          const k = scope + '|' + key;
          const h = hits.get(k) || { scope, key, terms: 0, tf: 0 };
          h.terms += 1;
          h.tf += parseInt(row[ti], 10) || 0;
          hits.set(k, h);
        }
      } catch {}
    };
    await Promise.all(words.map(one));
    if (mine !== qSeq) return;     // superseded while in flight

    // most query words matched first, then raw frequency. Matching two words
    // beats matching one a lot, which is what people expect from a phrase.
    const list = [...hits.values()].sort((a, b) => b.terms - a.terms || b.tf - a.tf);
    sum.textContent = list.length ? list.length + ' result' + (list.length === 1 ? '' : 's') : '';
    host.textContent = '';
    if (!list.length) {
      host.className = 'aclempty';
      host.textContent = 'nothing matches that';
      return;
    }
    host.className = '';
    const ul = document.createElement('ul');
    ul.className = 'qlist';
    for (const h of list.slice(0, 100)) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      // The badge is not decoration. These results put private notes next to
      // things published on the open web, so each row states its exposure.
      const b = document.createElement('span');
      b.className = 'qbadge ' + (h.scope === 'knowledge' ? 'knowledge' : h.scope);
      b.textContent = h.scope;
      const n = document.createElement('span');
      n.className = 'qname';
      n.textContent = h.key;              // textContent: page names are content
      a.appendChild(b);
      a.appendChild(n);
      a.onclick = (e) => {
        e.preventDefault();
        qClose();
        if (h.scope === 'knowledge') { openKnow(h.key); return; }
        openPage(h.key);
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
    $('qlist').textContent = 'type at least one word of two letters or more';
    $('qsum').textContent = '';
  };

  // typing searches, but not on every keystroke: each one is a request per
  // word against a pier that serialises
  let qTimer = null;
  $('qinput').oninput = () => {
    clearTimeout(qTimer);
    const v = $('qinput').value;
    qTimer = setTimeout(() => runSearch(v), 250);
  };
  $('qinput').onkeydown = (e) => {
    if (e.key === 'Enter') { clearTimeout(qTimer); runSearch($('qinput').value); }
  };
  $('qclose').onclick = qClose;
  $('qt').onclick = qOpen;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('qwrap').hidden) { qClose(); return; }
    // ctrl/cmd-K from anywhere, including the editor. Not "/" : that types.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if ($('qwrap').hidden) qOpen(); else qClose();
    }
  });
