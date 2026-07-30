  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch — that function is wired into the
  // tree, kind picker, chips and history panes, and a third mode would mean
  // touching every one of them. This is a thin overlay: same textarea and save
  // button, its own two endpoints.
  let grubPath = null;
  async function openGrub(p) {
    grubPath = p;
    current = null;
    curFolder = null;
    pname.value = p;
    pname.readOnly = true;
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    st('loading ' + p + '…');
    let r = null;
    try { r = await fetch(api + '/grub-source?path=' + encodeURIComponent(p)); } catch {}
    if (!r || !r.ok) { st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false); return; }
    const d = await r.json();
    src.value = d.text || '';
    // a binary/opaque grub has no text form — show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    st(d.editable ? 'grub ' + d.blot : 'read-only — ' + d.blot + ' has no text form');
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    const sent = src.value;
    let r = null;
    try {
      r = await fetch(api + '/grub-save?path=' + encodeURIComponent(grubPath),
                      { method: 'POST', body: sent });
    } catch {}
    saving = false;
    if (!r || !r.ok) {
      // the mark can reject the source; show ITS error, since the stored grub
      // still holds the previous content and the user needs to know why
      let msg = r ? ' ' + r.status : '';
      if (r) { try { const j = await r.json(); if (j && j.error) msg = ': ' + j.error; } catch {} }
      st('save rejected' + msg, false);
      return;
    }
    if (src.value === sent) dirty = false;
    st('saved');
    if (savePending) { savePending = false; if (dirty) saveGrub(); }
  }

