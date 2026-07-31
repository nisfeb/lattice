  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch — that function is wired into the
  // tree, kind picker, chips and history panes, and a third mode would mean
  // touching every one of them. This is a thin overlay: same textarea and save
  // button, its own two endpoints.
  let grubPath = null;
  let grubShip = null;   // '~ship' when the grub lives on ANOTHER ship; null = local
  async function openGrub(p, ship) {
    grubPath = p;
    grubShip = ship || null;
    current = null;
    curFolder = null;
    pname.value = (grubShip ? grubShip + ' ' : '') + p;
    pname.readOnly = true;
    $('histsec').hidden = true;
    $('linksec').hidden = true;
    st('loading ' + p + '…');
    // remote files ride /browse-file (bounded cross-ship peek); its JSON says
    // body/mark where grub-source says text/blot — normalize here, not there:
    // both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (!r || !r.ok) { st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false); return; }
    const d = await r.json();
    src.value = d.text || d.body || '';
    // a binary/opaque grub has no text form — show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    const blot = d.blot || d.mark || '';
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'remote grub on ' + grubShip + ' — saves need their permission'
       : 'grub ' + blot);
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    if (saving) { savePending = true; return; }
    saving = true;
    st('saving…');
    const sent = src.value;
    let r = null;
    try {
      // a remote save is verified server-side by revision bump: a peer that
      // never granted make ACKS the poke and silently drops the write, and
      // "saved" on a dropped write is the one lie an editor must not tell.
      r = await fetch(grubShip
        ? api + '/remote-save?ship=' + encodeURIComponent(grubShip) +
          '&path=' + encodeURIComponent(grubPath)
        : api + '/grub-save?path=' + encodeURIComponent(grubPath),
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

