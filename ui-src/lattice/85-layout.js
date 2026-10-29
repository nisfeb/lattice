  // ── layout toggles ────────────────────────────────────────────────────────
  const ws = $('ws');
  // soft-wrap is the default (long lines running off-screen are unusable on
  // mobile). The toggle still turns it off, and a saved preference wins.
  if (!('appWrap' in localStorage)) localStorage.appWrap = '1';
  const applyToggles = () => {
    paintPanes();   // the side panes and their corner toggles (13-frame.js)
    ws.classList.toggle('wrap', localStorage.appWrap === '1');
    // Edit or Read, per tab (23-tabhead.js)
    applyRead();
    //  the on class is paint alone, so mirror the state in aria-pressed
    {
      const on = localStorage.appWrap === '1';
      const b = $('wrapt');
      b.className = 'ico' + (on ? ' on' : '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // keep the vim indicator in step with the view: it reads PREVIEW in
    // preview-only. setInd is exposed by 27-vim.js (it lives in that file's
    // own IIFE); guard in case that file is absent. A no-op when vim is off.
    if (window.latVimSetInd) window.latVimSetInd();
  };
  const flip = (k) => { localStorage[k] = localStorage[k] === '1' ? '0' : '1'; applyToggles(); };
  $('wrapt').onclick = () => flip('appWrap');
  // A throw in this boot-time layout pass must NOT halt the rest of app boot:
  // the initial tree load and navigation wiring run in a later file (90-sync),
  // so an uncaught error here blanks the whole app (that was the setInd bug).
  // Contain it — a broken layout widget is survivable; a dead tree is not.
  try { applyToggles(); } catch (e) { console.error('[lattice] layout init failed', e); }

  // The phone's old one-pane switcher and its full-screen mode are gone
  // (the drawers in 97-mobar.js replaced them). Their stored state goes too.
  try { localStorage.removeItem('appMv'); localStorage.removeItem('appFull'); } catch {}

  // ── pane resize: drag a boundary, double-click it to reset ───────────────
  // Widths live in CSS custom properties on #ws (see .psplit in the shell
  // css), in px. The left pane's handle measures from the ribbon's edge, so
  // the stored width is the pane's own.
  {
    let panes = {};
    try { panes = JSON.parse(localStorage.appPanes || '{}'); } catch {}
    const applyPanes = () => {
      ws.style.setProperty('--wtree', panes.tree ? panes.tree + 'px' : '');
      ws.style.setProperty('--wctl', panes.ctl ? panes.ctl + 'px' : '');
    };
    applyPanes();
    const lim = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wire = (id, key, drag) => {
      const h = $(id);
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
    wire('ph1', 'tree', (x) => {
      panes.tree = Math.round(lim(x - $('ribbon').getBoundingClientRect().right, 130, 480));
    });
    wire('ph3', 'ctl', (x) => { panes.ctl = Math.round(lim(innerWidth - x, 190, 520)); });
  }

  // ── ?diag=1: a swipe readout for scroll bugs reported from phones ───────
  // On with ?diag=1, off with ?diag=0. The setting is kept, and an installed
  // PWA shares this storage with the browser, so turning it on in a Chrome
  // tab shows it in the app too. After each touch it names what scrolled and
  // by how much, and every scroller with room to move: a swipe latches to
  // the innermost one that can move, however little. Read-only, so it
  // cannot change the gesture it reports. Temporary: out once it has done
  // its job, like the last one.
  {
    const q = location.search.match(/[?&]diag=([01])/);
    try { if (q) localStorage.latDiag = q[1]; } catch {}
    let diag = false;
    try { diag = localStorage.latDiag === '1'; } catch {}
    if (diag) {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;'
        + 'font:11px/1.3 ui-monospace,monospace;background:#000d;color:#0f0;'
        + 'padding:4px 6px;pointer-events:none;white-space:pre-wrap';
      document.body.append(d);
      const name = (el) => el === document.scrollingElement ? 'ROOT'
        : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
          + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
      const scrollers = () => [document.scrollingElement, ...[...document.querySelectorAll('*')]
        .filter((el) => el.offsetParent !== null && /(auto|scroll)/.test(getComputedStyle(el).overflowY))];
      let before = [];
      const show = (moved) => {
        const can = scrollers().filter((el) => el.scrollHeight > el.clientHeight)
          .map((el) => `${name(el)} ${el.scrollTop.toFixed(2)}/${el.scrollHeight - el.clientHeight}`
            + ` h=${el.getBoundingClientRect().height.toFixed(2)}`);
        d.textContent = `last swipe moved: ${moved}\nscrollers (at/max): ${can.join(', ') || 'none'}`
          + `\ninner=${innerHeight} vv=${window.visualViewport ? visualViewport.height.toFixed(1) : '-'}`
          + ` ${navigator.userAgent.replace(/^.*Chrome\//, 'Chrome/').split(' ')[0]}`;
      };
      addEventListener('touchstart', () => { before = scrollers().map((el) => [el, el.scrollTop]); },
        { passive: true, capture: true });
      addEventListener('touchend', () => setTimeout(() => {
        const moved = before.filter(([el, t]) => el.scrollTop !== t)
          .map(([el, t]) => `${name(el)} ${(el.scrollTop - t).toFixed(2)}`);
        show(moved.join(', ') || 'nothing');
      }, 800), { passive: true, capture: true });
      show('(no swipe yet)');
    }
  }
