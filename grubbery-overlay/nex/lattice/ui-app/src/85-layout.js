  // ── layout toggles + mobile tabs ─────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile); the toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    ws.classList.toggle('nt', localStorage.appNT === '1');
    ws.classList.toggle('nc', localStorage.appNC === '1');
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    $('wrapt').className = 'ico' + (localStorage.appWrap === '1' ? ' on' : '');
    $('treet').className = 'ico' + (localStorage.appNT === '1' ? ' on' : '');
    $('ctlt').className = 'ico' + (localStorage.appNC === '1' ? ' on' : '');
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  $('wrapt').onclick = () => flip('appWrap');
  $('treet').onclick = () => flip('appNT');
  $('ctlt').onclick = () => flip('appNC');
  applyToggles();

  const isMobile = () => matchMedia('(max-width: 820px)').matches;
  const setMv = (v) => {
    ws.dataset.mv = v;
    for (const x of document.querySelectorAll('.mtabs button'))
      x.className = x.dataset.mv === v ? 'on' : '';
    if (v === 'prev') refreshPreview();
  };
  for (const b of document.querySelectorAll('.mtabs button'))
    b.onclick = () => setMv(b.dataset.mv);
  // On a phone the code pane is the wrong place to land: with no file open it
  // is an empty box, and the tree is how you get anywhere. Start on the tree
  // and let opening a file move us — applyPage switches to 'code' on mobile,
  // so a remembered or ?name page still lands in the editor. Desktop shows
  // every pane at once, so 'code' remains right there.
  setMv(isMobile() ? 'tree' : 'code');

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css). Outer panes store px; the editor/preview boundary stores the
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
      // the reset gesture is detected from pointerup pairs, NOT dblclick:
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
