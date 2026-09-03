  // ── layout toggles + mobile tabs ─────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile). The toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    ws.classList.toggle('nt', localStorage.appNT === '1');
    ws.classList.toggle('nc', localStorage.appNC === '1');
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    //  the on class is paint alone, so mirror the state in aria-pressed the
    //  way setFull below does
    for (const [id, key] of [['wrapt', 'appWrap'], ['treet', 'appNT'], ['ctlt', 'appNC']]) {
      const on = localStorage[key] === '1';
      const b = $(id);
      b.className = 'ico' + (on ? ' on' : '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  $('wrapt').onclick = () => flip('appWrap');
  $('treet').onclick = () => flip('appNT');
  $('ctlt').onclick = () => flip('appNC');
  applyToggles();

  // ── mobile: full-screen editing ──────────────────────────────────────────
  // Created here rather than in <lat-bar>, and appended to #ws, because it has
  // to survive the state it creates: full screen hides the bar, so a button
  // inside the bar would take the only way out with it.
  //
  // Labelled in words, not an icon. There is no full-screen glyph with broad
  // font coverage, and this codebase has already shipped an invisible button
  // once — the access-control key was U+26BF and drew as an empty box, which
  // every existence check passed. Two short words always render.
  //
  // The state persists: it reads as a preference ("I write full screen"),
  // matching the other layout toggles, and the way back is on screen the whole
  // time so a remembered full screen cannot trap anyone.
  const fullt = document.createElement('button');
  fullt.id = 'fullt';
  fullt.type = 'button';
  const setFull = (on) => {
    ws.classList.toggle('full', on);
    localStorage.appFull = on ? '1' : '0';
    fullt.textContent = on ? 'exit' : 'full';
    fullt.title = on ? 'leave full-screen editing' : 'full-screen editing';
    fullt.setAttribute('aria-label', fullt.title);
    fullt.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  fullt.onclick = () => setFull(!ws.classList.contains('full'));
  ws.appendChild(fullt);
  setFull(localStorage.appFull === '1');

  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  const setMv = (v) => {
    ws.dataset.mv = v;
    for (const x of document.querySelectorAll('.mtabs button'))
      x.className = x.dataset.mv === v ? 'on' : '';
    if (v === 'prev') refreshPreview();
  };
  for (const b of document.querySelectorAll('.mtabs button'))
    b.onclick = () => setMv(b.dataset.mv);
  // On a phone the code pane is the wrong place to land. With no file open it
  // is an empty box, and the tree is how you get anywhere. Start on the tree
  // and let opening a file move us. applyPage switches to 'code' on mobile,
  // so a remembered or ?name page still lands in the editor. Desktop shows
  // every pane at once, so 'code' remains right there.
  setMv(isMobile() ? 'tree' : 'code');

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css). Outer panes store px. The editor/preview boundary stores the
  // editor's fr share against the preview's fixed 1fr, so it keeps meaning
  // when the window or the outer panes change size.
  {
    let panes = {};
    try { panes = JSON.parse(localStorage.appPanes || '{}'); } catch {}
    const applyPanes = () => {
      ws.style.setProperty('--wtree', panes.tree ? panes.tree + 'px' : '');
      ws.style.setProperty('--wed', panes.ed ? panes.ed + 'fr' : '');
      ws.style.setProperty('--wctl', panes.ctl ? panes.ctl + 'px' : '');
    };
    applyPanes();
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wire = (id, key, drag) => {
      const h = $(id);
      if (!h) return;                    // stale cached shell without handles
      // the reset gesture is detected from pointerup pairs, NOT dblclick.
      // pointerdown must preventDefault (otherwise native selection starts
      // and eats the pointer stream mid-drag), and a cancelled pointerdown
      // never produces the derived click/dblclick events at all.
      let lastTap = 0;
      h.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        h.classList.add('drag');
        const x0 = e.clientX;
        let moved = false;
        const move = (ev) => {
          if (!moved && Math.abs(ev.clientX - x0) <= 3) return;   // tap jitter
          moved = true;
          drag(ev.clientX);
          applyPanes();
        };
        const up = () => {
          h.removeEventListener('pointermove', move);
          h.classList.remove('drag');
          if (!moved && Date.now() - lastTap < 450) { delete panes[key]; applyPanes(); }
          lastTap = moved ? 0 : Date.now();
          try { localStorage.appPanes = JSON.stringify(panes); } catch {}
        };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up, { once: true });
      });
    };
    wire('ph1', 'tree', (x) => { panes.tree = Math.round(lim(x, 130, 480)); });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
    wire('ph2', 'ed', (x) => {
      const ed = document.querySelector('.edwrap').getBoundingClientRect();
      const pv = document.querySelector('.prev').getBoundingClientRect();
      panes.ed = Math.round(lim((x - ed.left) / Math.max(60, pv.right - x), 0.25, 4) * 1000) / 1000;
    });
  }
  // ── ?diag=1: a live layout readout for scroll bugs reported from phones ──
  // Nothing here is reachable without the query string. It answers the
  // questions a remote debugger would: which element scrolls, how tall the
  // viewport, the document and the tree think they are, and whether those
  // numbers move when folders expand.
  if (/[?&]diag=1/.test(location.search)) {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;font:11px/1.3 ui-monospace,monospace;'
      + 'background:#000c;color:#0f0;padding:4px 6px;pointer-events:none;white-space:pre-wrap';
    document.body.append(d);
    const upd = () => {
      const t = document.querySelector('.tree');
      const se = document.scrollingElement;
      d.textContent = `scroller=${se ? se.tagName : '-'} scrollY=${scrollY | 0}`
        + ` inner=${innerHeight} vv=${window.visualViewport ? window.visualViewport.height | 0 : '-'}`
        + ` html=${document.documentElement.scrollHeight}/${document.documentElement.clientHeight}`
        + ` body=${document.body.scrollHeight}/${document.body.clientHeight}`
        + ` ws=${ws.getBoundingClientRect().height | 0}`
        + (t ? ` tree=${t.scrollHeight}/${t.clientHeight} ov=${getComputedStyle(t).overflowY} top=${t.getBoundingClientRect().top | 0}` : ' tree=-')
        + ` ua=${navigator.userAgent.replace(/^.*Chrome\//, 'Chrome/').split(' ')[0]}`;
    };
    // coalesce to one update per frame, and watch the workspace grid rather
    // than the body: the readout lives outside it, so rewriting its text is
    // not a mutation it can see (observing the body made it observe itself
    // and spin forever).
    let queued = false;
    const sched = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; upd(); }); };
    addEventListener('scroll', sched, true);
    addEventListener('resize', sched);
    new MutationObserver(sched).observe(ws, { subtree: true, childList: true, attributes: true });
    upd();
  }
