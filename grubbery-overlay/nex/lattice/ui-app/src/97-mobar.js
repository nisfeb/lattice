  // ── mobile: one bar row + a ⋯ sheet ──────────────────────────────────────
  // At phone width the bar used to wrap into three rows — the icon cluster
  // was flex-wrap overflow, and the name input held a full-width row for a
  // once-per-page action — 184px of chrome before the tab strip's content.
  //
  // Same doctrine as the desktop deskbar (96-deskmenu.js): nothing is
  // removed, and the ⋯ sheet CLICKS the page's own hidden buttons, so there
  // is exactly one implementation of search/comments/access/mode and nothing
  // to drift. Everything here is built unconditionally and shown or hidden
  // by the 820px CSS block, so a resize across the breakpoint just works —
  // no load-time isMobile branching to go stale.
  {
    const bar = document.querySelector('.bar');

    // the label: which page is open. Sits where the name input was; the
    // input stays in the DOM with its value (everything reads pname.value).
    const mpath = document.createElement('div');
    mpath.id = 'mpath';
    mpath.setAttribute('aria-live', 'polite');
    pname.after(mpath);
    const mpaint = () => {
      const v = (pname.value || '').trim();
      mpath.textContent = v || 'no page open';
      mpath.className = v ? '' : 'muted';
    };
    mpaint();
    pname.addEventListener('input', mpaint);
    pname.addEventListener('change', mpaint);
    setInterval(mpaint, 500);

    // tap: rename what is open (the controls pane's own move/rename flow),
    // or start a page when nothing is. Both are existing buttons.
    mpath.addEventListener('click', () => {
      if (current || curFolder) $('mv').click();
      else newFile('');
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
    // [sheet row id to create, real button id to click, label]
    const rows = [
      ['ms-q', 'qt', '\u{1F50D} search'],
      ['ms-cm', 'cmt', '\u{1F4AC} comments'],
      ['ms-acl', 'aclt', '\u{1F511} access'],
      ['ms-mode', 'modet', ''],   // label mirrors the live mode button
    ];
    for (const [rid, target, label] of rows) {
      const b = document.createElement('button');
      b.id = rid;
      b.textContent = label;
      b.onclick = () => { sheet.hidden = true; $(target).click(); };
      sheet.appendChild(b);
    }
    bar.appendChild(sheet);
    more.onclick = () => {
      // the mode row's label is whatever the real button says right now
      $('ms-mode').textContent = $('modet').textContent;
      sheet.hidden = !sheet.hidden;
    };
    // tapping anywhere else puts it away
    document.addEventListener('click', (e) => {
      if (!sheet.hidden && !sheet.contains(e.target) && e.target !== more) sheet.hidden = true;
    });

    // the unread-comments badge lives on the hidden #cmt; mirror it onto ⋯
    // and the sheet row so hiding the button does not hide the signal.
    const mirror = () => {
      const un = $('cmt').classList.contains('has-unread');
      more.classList.toggle('has-unread', un);
      $('ms-cm').classList.toggle('has-unread', un);
    };
    mirror();
    new MutationObserver(mirror).observe($('cmt'), { attributes: true, attributeFilter: ['class'] });
  }
