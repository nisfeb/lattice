  // ── editor pane: <lat-editor> + highlighting (Prism overlay) ─────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon', tex: 'latex' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  // Prism runs in a worker (prism.js installs a message handler there).
  // Some grammars scan to the end of the input from every start position
  // when a construct is unterminated, so 32 KiB of '[' took five seconds on
  // the main thread and froze the editor on every keystroke (security audit
  // run-1). One job in flight, the newest text queued behind it. A job slow
  // to answer leaves plain text painted, and past the deadline the worker
  // is killed and the text stays plain.
  // A fresh worker first fetches prism.js, which on the desktop goes through
  // the bridge to the ship and can take seconds, so its first job gets a
  // startup allowance on top of the deadline. Without it every new worker
  // was killed before it could answer, and the editor never highlighted.
  const HL_PLAIN = 50, HL_DEADLINE = 1500, HL_STARTUP = 10000;
  let hlWorker = null, hlFresh = false, hlCur = null, hlNext = null, hlPlain = 0, hlKill = 0;
  const hlDone = () => {
    clearTimeout(hlPlain); clearTimeout(hlKill); hlCur = null;
    if (hlNext) { const j = hlNext; hlNext = null; hlRun(j); }
  };
  // hlPainted: told after every change to the overlay's text, so the vim
  // block cursor (27-vim.js) measures the text it sits on, not the last one
  let hlPainted = () => {};
  const hlPaint = (body) => { hl.innerHTML = esc(body) + '\n'; sync(); hlPainted(); };
  // hlSplice: the typed change, put straight into the overlay's text nodes.
  // The textarea's text is invisible and the overlay's is what shows, so
  // until the highlight comes back the overlay held the text from before
  // the keystroke. Past 60 KB that is 120 ms after the LAST key, so a fast
  // typist on a long page saw every character late, the lines below an
  // Enter on their old rows, and the overlay, shorter than the textarea,
  // clamped its scrollTop below the textarea's: the caret drifted off the
  // text it was in. Splicing keeps the highlight's spans (their colours
  // lag a little), and the text and its geometry are the textarea's at once.
  const hlSplice = () => {
    const old = hl.textContent, now = src.value;
    // only over a copy of the editor's own text (not the Writer's blank)
    if (!old.endsWith('\n') || old === now + '\n') return;
    const ol = old.length - 1, nl = now.length, m = Math.min(ol, nl);
    let a = 0; while (a < m && old.charCodeAt(a) === now.charCodeAt(a)) a++;
    let z = 0; while (z < m - a && old.charCodeAt(ol - 1 - z) === now.charCodeAt(nl - 1 - z)) z++;
    // never split a surrogate pair between the kept and the replaced text
    if (a && (old.charCodeAt(a - 1) & 0xfc00) === 0xd800) a--;
    if (z && (old.charCodeAt(ol - z) & 0xfc00) === 0xdc00) z--;
    // offsets are the old text's: a deletion in one node moves no other
    const w = document.createTreeWalker(hl, NodeFilter.SHOW_TEXT);
    let n, at = 0, rest = ol - z - a, host = null, hostAt = 0;
    while ((n = w.nextNode())) {
      const len = n.length, end = at + len;
      if (!host && a <= end) { host = n; hostAt = a - at; }
      if (rest > 0 && end > a) {
        const from = Math.max(0, a - at), k = Math.min(rest, len - from);
        if (k > 0) { n.deleteData(from, k); rest -= k; }
      }
      if (host && rest <= 0) break;
      at = end;
    }
    if (host) host.insertData(hostAt, now.slice(a, nl - z));
    hlPainted();
  };
  const hlRun = (job) => {
    // newer text while a job runs shows plain until its own turn
    if (hlCur) { hlNext = job; hlPaint(job.body); return; }
    if (!hlWorker) {
      try { hlWorker = new Worker('/apps/lattice/prism.js'); } catch { hlPaint(job.body); return; }
      hlFresh = true;
      hlWorker.onmessage = (e) => {
        hlFresh = false;
        const j = hlCur;
        if (j && j.body === src.value && j.lang === LMAP[pkind.value]) {
          hl.innerHTML = e.data + '\n'; sync(); hlPainted();
        } else if (j && !hlNext) {
          // stale: the text or the kind moved on while this job ran. A
          // fast answer has already cancelled the plain paint, so paint
          // the current text plain and highlight it again, or the overlay
          // keeps the old page and the transparent textarea shows nothing
          // (a shared page opened, painted, then switched kind)
          hlPaint(src.value);
          scheduleRender();
        }
        hlDone();
      };
      hlWorker.onerror = () => { hlWorker = null; hlDone(); };
    }
    hlCur = job;
    // only while this job's text is still the editor's: newer text was
    // painted when it queued, and this must not paint over it
    hlPlain = setTimeout(() => { if (job.body === src.value) hlPaint(job.body); }, HL_PLAIN);
    hlKill = setTimeout(() => {
      if (hlWorker) hlWorker.terminate();
      hlWorker = null; hlDone();
    }, HL_DEADLINE + (hlFresh ? HL_STARTUP : 0));
    hlWorker.postMessage(JSON.stringify({ language: job.lang, code: job.body }));
  };
  // the right pane's Outline and Outgoing read the text, so every paint of
  // it, typed or scripted, tells them (rpSoon, 76-outline.js, set there)
  let rpHook = null;
  const render = () => {
    if (rpHook) rpHook();
    writerFollow();
    if (fodtHere() && !writerSourceOn()) { hl.textContent = ''; return; }
    const lang = LMAP[pkind.value];
    // the worker loads its own prism. This window's copy comes after boot
    // (99-boot.js), and every LMAP language is in it, so until it lands a
    // known language is taken as highlightable.
    const g = lang && (!window.Prism || Prism.languages[lang]);
    if (!g || typeof Worker === 'undefined') { hl.innerHTML = esc(src.value) + '\n'; hlPainted(); return; }
    hlRun({ body: src.value, lang });
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  // sync in the next frame's rAF, before it paints: for a new body, where
  // reading scrollTop at once forces a layout the rest of the open undoes
  let syncRaf = 0;
  const syncSoon = () => {
    if (!syncRaf) syncRaf = requestAnimationFrame(() => { syncRaf = 0; sync(); });
  };
  // per-keystroke highlight throttle: Prism re-tokenizes the WHOLE document on
  // every render, which drops frames on large pages. Coalesce to one render per
  // frame. Past ~60KB fall back to a trailing debounce (even one full highlight
  // per frame is too heavy there).
  let hlRaf = 0, hlTimer = 0;
  const scheduleRender = () => {
    if (src.value.length > 60000) {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => { render(); sync(); }, 120);
    } else if (!hlRaf) {
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; render(); sync(); });
    }
  };
  // +edited: announce a PROGRAMMATIC change to the editor exactly as if it had
  // been typed. Setting src.value fires no input event, so anything that only
  // called render() silently skipped the dirty flag, autosave and the preview.
  // A Tab indent was shown but never saved, and a live refresh reverted it.
  // Always route scripted edits through here.
  const edited = () => src.dispatchEvent(new Event('input'));
  // <lat-editor>: one is live, #src and #hl, the editor every module works
  // on, and it moves into whichever group is in front (28-splits.js), so
  // vim, list editing, autocomplete and the preview follow it there. With
  // `ghost` it is another group's: the same two layers, locked, painted
  // from that group's parked tab, and live once its group comes to the
  // front. Built once: a move between groups connects it again.
  customElements.define('lat-editor', class extends HTMLElement {
    connectedCallback() {
      if (this.built) return;
      this.built = true;
      if (this.hasAttribute('ghost')) {
        this.innerHTML = '<div class="edwrap"><pre class="ehl" aria-hidden="true"></pre>'
          + '<textarea class="esrc" spellcheck="false" readonly></textarea></div>';
        return;
      }
      this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" class="ehl" aria-hidden="true"></pre>
  <textarea id="src" class="esrc" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
      src = $('src'); hl = $('hl');
      src.addEventListener('input', () => {
        dirty = true;
        everTyped = true;      // never cleared: see 20-state.js
        hlSplice();
        scheduleRender();
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
      });
      src.addEventListener('scroll', sync);
    }
  });
  pkind.addEventListener('change', () => {
    if (!kindSwitchOk(pkind.value)) { pkind.value = curKind || (pkind.value === 'fodt' ? 'md' : 'fodt'); return; }
    curKind = pkind.value;
    //  an empty new page made a Writer page starts as the blank document
    if (curKind === 'fodt' && !src.value.trim()) writerBlank(); else render();
    //  the kind rides every save as a query param, so switching it on an open
    //  page must dirty the editor or navigating away silently reverts the
    //  choice. A page with no name yet gets its kind from the first save.
    if (current) edited();
    refreshTexButton();
  });
