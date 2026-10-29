  // ── shell frame: <lat-ribbon>, <lat-lpane>, <lat-rpane>, <lat-statusbar> ──
  // The ribbon down the left edge, a tabbed pane either side of the editor,
  // the status bar along the bottom and a corner toggle above each pane.
  // The panes render the old components (lat-tree, lat-ctl, lat-history,
  // lat-links) as children, so those upgrade into their sections when their
  // own files run, with every id intact.
  //
  // Every icon button is titled "Name (shortcut)" with an identical
  // aria-label: the glyph is its whole content, so the title is its name.
  const tip = (b, name, keys) => {
    const t = keys ? name + ' (' + keys + ')' : name;
    b.title = t;
    b.setAttribute('aria-label', t);
    return b;
  };
  const sbtn = (attrs, icon, name, keys) =>
    `<button type="button" class="sbtn" ${attrs} title="${name}${keys ? ' (' + keys + ')' : ''}"`
    + ` aria-label="${name}${keys ? ' (' + keys + ')' : ''}">${ico(icon)}</button>`;

  // [id, icon, name, keys] per pane tab. Their sections are filled by the
  // components below and, for the empty ones, by later steps.
  const PANES = {
    l: [['files', 'doc', 'Files'], ['know', 'know', 'Knowledge'],
      ['search', 'search', 'Search', 'Ctrl+K'], ['marks', 'mark', 'Bookmarks']],
    r: [['page', 'gear', 'Page'], ['out', 'out', 'Outgoing links'],
      ['back', 'back', 'Backlinks'], ['outline', 'list', 'Outline'],
      ['comments', 'comment', 'Comments'], ['hist', 'hist', 'History']],
  };
  const FILL = {
    files: '<lat-tree></lat-tree>', know: '<lat-know></lat-know>',
    search: '<lat-search></lat-search>', marks: '<lat-marks></lat-marks>',
    page: '<lat-ctl></lat-ctl>',
    back: '<lat-links></lat-links>', hist: '<lat-history></lat-history>',
  };
  const paneHtml = (side, label) => `
<nav id="${side}tabs" class="ptabs" role="tablist" aria-label="${label}">
  ${PANES[side].map(([id, icon, name, keys]) =>
    sbtn(`role="tab" data-pt="${id}" aria-selected="false"`, icon, name, keys)).join('\n  ')}
</nav>
<div id="${side}body" class="pbody">
  ${PANES[side].map(([id]) =>
    `<section data-pane="${id}" role="tabpanel" hidden>${FILL[id] || ''}</section>`).join('\n  ')}
</div>`;

  customElements.define('lat-ribbon', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="corner" id="lcorner">${sbtn('id="treet" aria-pressed="true"', 'pl', 'Left pane')}</div>
<nav class="ribbon" id="ribbon" aria-label="Ribbon">
  <div class="rtop"></div>
  <div class="rbot"></div>
</nav>`;
    }
  });
  customElements.define('lat-lpane', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `<aside class="pane lp" id="lpane">${paneHtml('l', 'Left pane')}</aside>`;
    }
  });
  customElements.define('lat-rpane', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="corner" id="rcorner">${sbtn('id="ctlt" aria-pressed="true"', 'pr', 'Right pane')}</div>
<aside class="pane rp" id="rpane">${paneHtml('r', 'Right pane')}</aside>`;
    }
  });
  customElements.define('lat-statusbar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<footer class="statusbar" id="statusbar">
  <!-- role=status so "saved" and every failure are announced, not just
       painted onto a line a screen reader never revisits -->
  <span id="spin"></span><span id="status" class="muted" role="status" aria-live="polite"></span>
  <!-- Offline state is a CONDITION, not an event, so it cannot live in the
       status line: the next save, render or refresh overwrites that. This
       badge stays up for as long as the condition holds. -->
  <span id="offbadge" class="offbadge" role="status" aria-live="polite" hidden></span>
  <span class="grow"></span>
  <button type="button" id="errchip" class="errchip" hidden></button>
</footer>`;
      status = $('status'); spinner = $('spin'); offbadge = $('offbadge');
      renderOffline();   // a queue can outlive a session, so show it at boot
    }
  });

  // ── pane tabs and the corner toggles ────────────────────────────────────
  // One section per pane is shown. The choice persists per side, and an id
  // this build does not know (an older or newer layout) falls back to the
  // default rather than leaving the pane blank. Showing a section announces
  // it (lat-pane on document, detail {side, id}), so a section that loads
  // its list lazily (Knowledge, Bookmarks) fetches when it is first seen.
  const TABKEY = { l: 'appLTab', r: 'appRTab' };
  const TABDEF = { l: 'files', r: 'page' };
  function paneTab(side, id) {
    if (!PANES[side].some((p) => p[0] === id)) id = TABDEF[side];
    for (const b of document.querySelectorAll('#' + side + 'tabs [data-pt]')) {
      const on = b.dataset.pt === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const s of document.querySelectorAll('#' + side + 'body > section'))
      s.hidden = s.dataset.pane !== id;
    try { localStorage[TABKEY[side]] = id; } catch {}
    document.dispatchEvent(new CustomEvent('lat-pane', { detail: { side, id } }));
  }
  // the section a pane shows right now, for a file whose listener was added
  // after the boot-time paneTab below had already announced it
  const paneShows = (side, id) =>
    !document.querySelector('#' + side + 'body > [data-pane=' + id + ']').hidden;
  // The stored keys still mean HIDDEN ('1'), as they always have, so a
  // layout saved before the frame comes back the same. The buttons say
  // whether the pane is OPEN: pressed means showing.
  const OPENKEY = { l: 'appNT', r: 'appNC' };
  function paintPanes() {
    const ws = $('ws');
    for (const [side, cls, id] of [['l', 'nt', 'treet'], ['r', 'nc', 'ctlt']]) {
      const shut = localStorage[OPENKEY[side]] === '1';
      ws.classList.toggle(cls, shut);
      const b = $(id);
      b.classList.toggle('on', !shut);
      b.setAttribute('aria-pressed', shut ? 'false' : 'true');
    }
  }
  function paneOpen(side, open) {
    if (open === undefined) open = localStorage[OPENKEY[side]] === '1';
    try { localStorage[OPENKEY[side]] = open ? '0' : '1'; } catch {}
    paintPanes();
    return open;
  }
  for (const side of ['l', 'r']) {
    for (const b of document.querySelectorAll('#' + side + 'tabs [data-pt]'))
      b.onclick = () => paneTab(side, b.dataset.pt);
    paneTab(side, localStorage[TABKEY[side]]);
  }
  $('treet').onclick = () => paneOpen('l');
  $('ctlt').onclick = () => paneOpen('r');
  paintPanes();

  // ── ribbon ──────────────────────────────────────────────────────────────
  // Items are registered here by the feature that owns them, never written
  // into the markup, so each one has exactly one home. bottom puts it in the
  // lower group (settings).
  function ribbonAdd({ id, icon, name, keys, run, bottom }) {
    const b = tip(document.createElement('button'), name, keys);
    b.type = 'button';
    b.className = 'sbtn';
    b.id = 'rb-' + id;
    b.dataset.rb = id;
    b.innerHTML = ico(icon);
    b.onclick = (ev) => run(ev);
    document.querySelector('#ribbon ' + (bottom ? '.rbot' : '.rtop')).append(b);
    return b;
  }

  // ── compile error chip ──────────────────────────────────────────────────
  // The error itself lives in the Page tab (#cerr), which may be closed or
  // behind another tab. While it holds an error the status bar says so, and
  // a click brings the Page tab forward. Watched rather than called from
  // each writer, since four files set #cerr. The watch is on the Page
  // section because #cerr does not exist yet: <lat-ctl> upgrades later.
  {
    const chip = $('errchip');
    chip.title = 'Show the error in the Page tab';
    const sync = () => {
      const c = $('cerr');
      const t = c && c.className === 'err' ? c.textContent.trim() : '';
      chip.hidden = !t;
      chip.textContent = t.split('\n')[0];
    };
    new MutationObserver(sync).observe(document.querySelector('#rbody > [data-pane=page]'),
      { childList: true, characterData: true, subtree: true, attributes: true });
    chip.onclick = () => { paneOpen('r', true); paneTab('r', 'page'); };
    sync();
  }

  // for the browser suites, which cannot reach this scope
  window.latShell = { paneTab, paneOpen, ribbonAdd };
