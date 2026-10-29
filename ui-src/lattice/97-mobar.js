  // ── mobile: one bar row + a ⋯ sheet ──────────────────────────────────────
  // At phone width the bar used to wrap into three rows — the icon cluster
  // was flex-wrap overflow, and the name input held a full-width row for a
  // once-per-page action — 184px of chrome before the tab strip's content.
  //
  // Same doctrine as the desktop deskbar (96-deskmenu.js): nothing is
  // removed, and the ⋯ sheet CLICKS the page's own hidden buttons (or calls
  // the one function behind them), so there is exactly one implementation
  // of search/comments/access and nothing to drift. Everything here is
  // built unconditionally and shown or hidden by the 820px CSS block, so a
  // resize across the breakpoint just works, with no load-time isMobile
  // branching to go stale.
  {
    const bar = document.querySelector('.bar');

    // the label: which page is open. Sits where the name input was; the
    // input stays in the DOM with its value (everything reads pname.value).
    const mpath = document.createElement('div');
    mpath.id = 'mpath';
    mpath.setAttribute('aria-live', 'polite');
    pname.after(mpath);
    // the name it last showed, so a repaint with nothing new never rewrites
    // the aria-live label with the text it already holds
    let mshown = null;
    const mpaint = () => {
      const v = (pname.value || '').trim();
      if (v === mshown) return;
      mshown = v;
      mpath.textContent = v || 'no page open';
      mpath.className = v ? '' : 'muted';
    };
    mpaint();
    // setOpen (20-state.js) dispatches 'input' whenever what is open
    // changes, and typing fires it natively, so this needs no poll
    pname.addEventListener('input', mpaint);

    // tap: rename what is open (the controls pane's own move/rename flow),
    // or start a page when nothing is. Both are existing buttons.
    mpath.addEventListener('click', () => {
      if (current || curFolder) { $('mv').click(); return; }
      // current===null with text in the box is grub mode or an unsaved new
      // page — the reset newFile() does would throw that work away
      if (src.value.trim()) return;
      newFile('');
    });

    // the ⋯ button and its sheet
    const more = document.createElement('button');
    more.id = 'mmore';
    more.className = 'ico';
    more.title = 'more';
    more.innerHTML = '&#8943;';
    bar.appendChild(more);
    const sheet = document.createElement('div');
    sheet.id = 'msheet';
    sheet.hidden = true;
    // [sheet row id to create, what it does, icon, label]. Search is the
    // left pane's tab (qOpen, 79-search.js); memories are its Knowledge tab,
    // reached from the tree view's own tab row, so there is no mode row.
    const rows = [
      ['ms-q', () => qOpen(), 'search', 'search'],
      ['ms-cm', () => cmOpen(), 'comment', 'comments'],
      ['ms-acl', () => aclOpen(), 'key', 'access'],
    ];
    for (const [rid, run, icon, label] of rows) {
      const b = document.createElement('button');
      b.id = rid;
      if (icon) b.innerHTML = ico(icon) + ' ';
      b.append(label);
      b.onclick = () => { sheet.hidden = true; run(); };
      sheet.appendChild(b);
    }
    bar.appendChild(sheet);
    more.onclick = () => { sheet.hidden = !sheet.hidden; };
    // tapping anywhere else puts it away
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && e.target !== more) sheet.hidden = true;
    });

    // the unread-comments badge lives on the ribbon's inbox, which a phone
    // does not show; mirror it onto ⋯ and the sheet row so the signal stays.
    const mirror = () => {
      const un = $('rb-inbox').classList.contains('has-unread');
      more.classList.toggle('has-unread', un);
      $('ms-cm').classList.toggle('has-unread', un);
    };
    mirror();
    new MutationObserver(mirror).observe($('rb-inbox'), { attributes: true, attributeFilter: ['class'] });
  }
