  // ── history + backlinks panels: <lat-history>, <lat-links> ───────────────
  // Defined here (before this file's own $-lookups). They upgrade inside the
  // <lat-ctl> frame rendered at 65.
  customElements.define('lat-history', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="histsec" hidden>
  <h3 id="histh">history &#9656;</h3>
  <div id="histview" class="row" hidden>
    <button id="hrestore">restore</button>
    <button id="hback">back to latest</button>
  </div>
  <div id="histlist" class="chips"></div>
</div>`;
    }
  });
  customElements.define('lat-links', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="linksec" hidden>
  <h3 id="linkh">linked from &#9656;</h3>
  <div id="linklist" class="chips"></div>
</div>`;
    }
  });

  // ── backlinks: pages that wikilink [[this page]] ─────────────────────────
  // fetched ONLY when the panel is expanded. This and history were two more
  // ~2s round-trips paid on every page open whether or not anyone looked.
  const linkSec = $('linksec'), linkList = $('linklist');
  async function loadBacklinks() {
    linkList.textContent = '';
    if (!current || mode === 'know') return;
    let j = null;
    // a panel nobody can see is not worth a rejection: an unreachable ship
    // leaves the list empty, the same as a refused request already does
    try {
      const r = await fetch(api + '/page-backlinks?name=' + encodeURIComponent(current));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    const links = (j.links || []).filter((p) => p !== current);
    if (!links.length) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'nothing links here yet';
      linkList.appendChild(d);
      return;
    }
    for (const pth of links) {
      const a = document.createElement('a');
      a.textContent = pth;
      a.onclick = () => openPage(pth);
      linkList.appendChild(a);
    }
  }

  // collapsed-by-default panels. First expand does the fetch
  let histOpen = false, linksOpen = false;
  const panelArrow = (el, base, open) => { el.textContent = base + (open ? ' ▾' : ' ▸'); };
  function resetPanels() {
    histOpen = false; linksOpen = false;
    histList.textContent = ''; linkList.textContent = '';
    histList.hidden = true; linkList.hidden = true;
    histView.hidden = true;
    const on = !!current && mode !== 'know';
    histSec.hidden = !on;
    linkSec.hidden = !on;
    panelArrow($('histh'), 'history', false);
    panelArrow($('linkh'), 'linked from', false);
  }
  $('histh').onclick = () => {
    if (histSec.hidden) return;
    histOpen = !histOpen;
    panelArrow($('histh'), 'history', histOpen);
    histList.hidden = !histOpen;
    if (!histOpen) histView.hidden = true;
    else if (!histList.childElementCount) loadHistory();
  };
  $('linkh').onclick = () => {
    if (linkSec.hidden) return;
    linksOpen = !linksOpen;
    panelArrow($('linkh'), 'linked from', linksOpen);
    linkList.hidden = !linksOpen;
    if (linksOpen && !linkList.childElementCount) loadBacklinks();
  };

  // ── version history (born keeps every save; autosave makes it dense) ────
  const histSec = $('histsec'), histList = $('histlist'), histView = $('histview');
  let revKind = null;
  const exitRev = () => {
    viewingRev = null;
    revKind = null;
    src.readOnly = false;
    histView.hidden = true;
  };
  async function loadHistory() {
    histList.textContent = '';
    if (!current || mode === 'know') return;
    let j = null;
    // same rule as loadBacklinks: an unreachable ship leaves the panel empty
    try {
      const r = await fetch(api + '/page-history?name=' + encodeURIComponent(current));
      if (!r.ok) return;
      j = await r.json();
    } catch { return; }
    const revs = j.revisions || [];
    if (revs.length < 2) {               // a single revision is just "now"
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'no history yet';
      histList.appendChild(d);
      return;
    }
    for (const v of revs.slice(0, 30)) {
      const a = document.createElement('a');
      // ~2026.7.27..19.12.23..xxxx -> 7.27 19:12
      const m = (v.updated || '').match(/\.(\d+\.\d+)\.\.(\d+)\.(\d+)/);
      a.textContent = '#' + v.rev + (m ? ' \u00b7 ' + m[1] + ' ' + m[2] + ':' + m[3] : '');
      a.className = v.rev === viewingRev ? 'on' : '';
      a.onclick = () => openRev(v.rev);
      histList.appendChild(a);
    }
  }
  async function openRev(rev) {
    let d = null;
    try {
      const r = await fetch(api + '/page-source-at?name=' + encodeURIComponent(current) +
        '&rev=' + rev);
      if (!r.ok) { st('revision load failed ' + r.status, false); return; }
      d = await r.json();
    } catch { st('revision load failed (network)', false); return; }
    viewingRev = rev;
    revKind = d.kind === 'index' ? 'md' : d.kind;   // restore under the REVISION's kind
    dirty = false;
    src.value = d.body;
    src.readOnly = true;
    render(); sync();
    histView.hidden = false;
    for (const a of histList.children)
      a.className = a.textContent.split(' ')[0] === '#' + rev ? 'on' : '';
    st('viewing rev ' + rev + ' \u00b7 read-only');
    if (CONTENT()) refreshPreview();
  }
  $('hback').onclick = () => { exitRev(); openPage(current); };
  $('hrestore').onclick = async () => {
    if (viewingRev === null) return;
    const rev = viewingRev, kind = revKind;
    exitRev();
    dirty = true;          // the historical body is now an unsaved local edit
    await save(kind);      // under the revision's OWN kind, not the current select
    // save() reports its own failures and leaves dirty SET on every path
    // that did not durably hold the body — do not paint success over that
    if (!dirty) st('restored rev ' + rev + ' as the newest revision');
    loadHistory();
  };

  $('mv').onclick = async () => {
    if (curFolder) { moveFolder(curFolder); return; }
    if (!current) { st('open something first', false); return; }
    const to = await ask('move ' + (mode === 'know' ? 'memory' : 'page') + ' ' + current + ' to:',
      current, 'move');
    if (!to || to === current) return;
    const newName = to.trim().replace(/^\/+|\/+$/g, '');
    if (!newName) return;
    if (mode === 'know') {
      const r = await mutate(api + '/know-move?from=' + encodeURIComponent(current) +
        '&to=' + encodeURIComponent(newName));
      if (!r.ok) { st('move failed ' + r.status, false); return; }
      // the body is already in the editor. Rename in place, no refetch
      knowGen++;
      const k = knowKeys.find((x) => x.key.replace(/^\//, '') === current);
      if (k) k.key = newName;
      current = newName;
      pname.value = newName;
      renderKnowChips();
      renderKnowTree();
      st('moved to ' + newName);
      return;
    }
    if (await movePage(current, newName)) {
      st('moved to ' + newName);
      openPage(newName);
    }
  };
