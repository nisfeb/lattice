  // ── editing an arbitrary grub (?grub=<ball path>) ────────────────────────
  // Any file in the ball, not just a lattice page: an app's html/js/css/hoon.
  // Deliberately NOT a third setMode branch. That function is wired into the
  // tree, kind picker, chips and history panes, and a third mode would mean
  // touching every one of them. This is a thin overlay: same textarea and save
  // button, its own two endpoints.
  let grubPath = null;
  let grubShip = null;   // '~ship' when the grub lives on ANOTHER ship; null = local
  // the host's rev this editor read (or last wrote), a remote save's base:
  // a host page that moved past it answers a conflict, never an overwrite
  let grubRev = null;
  // the picker's value before a grub took it over, restored on exitGrub. Set
  // only on the FIRST entry (see the guard in openGrub), so browsing straight
  // from one grub to another still remembers the page kind that came before.
  let grubPrevKind = null;
  // Every editor reset that leaves grub mode MUST call this: Save gives
  // grubPath top precedence, so a reset that forgets it leaves Save pointed
  // at the app file while the textarea fills with unrelated content — an
  // overwrite wearing a 'saved' status. openPage clears inline; newFile,
  // selectFolder and setMode route through here.
  const exitGrub = () => {
    grubPath = null; grubShip = null; grubRev = null;
    if (grubPrevKind !== null) { pkind.value = grubPrevKind; grubPrevKind = null; }
  };
  // Answers false when the open failed, like openPage (35-pages.js).
  async function openGrub(p, ship) {
    const my = ++openSeq;
    enterGrub(p, ship);
    st('loading ' + p + '…');
    // remote files ride /browse-file (bounded cross-ship peek). Its JSON says
    // body/mark where grub-source says text/blot. Normalize here, not there,
    // since both routes have other consumers.
    const url = grubShip
      ? api + '/browse-file?ship=' + encodeURIComponent(grubShip) + '&path=' + encodeURIComponent(p)
      : api + '/grub-source?path=' + encodeURIComponent(p);
    let r = null;
    try { r = await fetch(url); } catch {}
    if (my !== openSeq) return;
    if (!r || !r.ok) {
      // the editor stays as enterGrub left it, empty and locked
      st('could not open ' + p + (r ? ' (' + r.status + ')' : ''), false);
      return false;
    }
    const d = await r.json();
    if (my !== openSeq) return;
    src.value = d.text || d.body || '';
    if (grubShip && typeof d.rev === 'number') grubRev = d.rev;
    // a binary/opaque grub has no text form. Show it, never offer to save it
    src.readOnly = !d.editable;
    dirty = false;
    render();
    const blot = d.blot || d.mark || '';
    // the picker drives syntax highlighting (LMAP) and list-continuation
    // rules (proseFlavor), so it needs to follow this file's real language.
    // Left alone it keeps whatever page kind was open before, and editing
    // calendar.html ends up highlighted and indented as that stale kind.
    // a shared lattice page arrives as its prose, with the builder it is
    // wrapped in, which is its page kind
    const mk = d.builder || extKind(String(blot).split('/').pop()) || 'hoon';
    if ([...pkind.options].some((o) => o.value === mk)) pkind.value = mk;
    //  setOpen ran before this file's kind was known, so tell the desktop
    //  label (its tip names the kind) the same way setOpen does
    pname.dispatchEvent(new Event('input'));
    curKind = mk;
    st(!d.editable ? 'read-only — ' + blot + ' has no text form'
       : grubShip ? 'on ' + grubShip + ': saves need its permission'
       : 'grub ' + blot + ', no autosave here: Ctrl+S to save');
    return true;
  }
  // grub mode on, for `p` (on `ship`, or here), with its label and address,
  // and an empty locked editor until its text is in: openGrub's first half,
  // and all a tab's own unsaved grub buffer needs to come back (21-tabs.js).
  // Empty, because grubPath is what Save and the tab model go by. Left
  // showing the document before it while the grub loaded, the editor
  // offered that text to Save as this grub's, and a tab switch in that
  // window filed it as the grub's unsaved buffer.
  function enterGrub(p, ship) {
    src.value = '';
    src.readOnly = true;
    dirty = false;
    render();
    grubPath = p;
    grubShip = ship || null;
    grubRev = null;
    if (grubPrevKind === null) grubPrevKind = pkind.value;
    curFolder = null;
    // a shared lattice page reads as "~ship: its/name", not its whole ball
    // path; the name field is only a label here (Save goes by grubPath)
    const pg = /\/page\/(.+)\/code$/.exec(p);
    setOpen(null, { shown: grubShip ? grubShip + ': ' + (pg ? pg[1] : p) : p, readOnly: true,
      url: '/apps/lattice/app?grub=' + encodeURIComponent(p) +
        (grubShip ? '&ship=' + encodeURIComponent(grubShip) : '') });
  }
  async function saveGrub() {
    if (!grubPath || src.readOnly) return;
    //  queued for this grub: a page or memory in front by then is not it
    if (saving) {
      const p = grubPath, s = grubShip;
      queueSave(() => { if (grubPath === p && grubShip === s) return saveGrub(); });
      return;
    }
    saving = true;
    st('saving…');
    const sent = src.value;
    const p = grubPath, s = grubShip;
    let r = null;
    try {
      // a remote save is verified server-side by revision bump. A peer that
      // never granted make ACKS the poke and silently drops the write, and
      // "saved" on a dropped write is the one lie an editor must not tell.
      // Bounded: the ship answers a remote save within ~30s (three ~10s
      // steps at worst), and one that never answers must not hold `saving`
      // and every save queued behind it.
      r = await tfetch(s
        ? api + '/remote-save?ship=' + encodeURIComponent(s) +
          '&path=' + encodeURIComponent(p) +
          (grubRev !== null ? '&base=' + grubRev : '')
        : api + '/grub-save?path=' + encodeURIComponent(p),
        { method: 'POST', body: sent }, s ? 45000 : 30000);
    } catch {}
    saving = false;
    // a remote save names its outcome (+remote-save-respond); one with an
    // outcome is our ship's answer about the HOST, never our ship's absence
    let j = null;
    if (s && r) { try { j = await r.clone().json(); } catch {} }
    const out = j && j.outcome;
    const here = grubPath === p && grubShip === s;
    if (out && out !== 'landed') {
      const say = {
        unverified: 'sent — ' + s + ' took it but did not confirm; reload to check',
        conflict: 'not saved — ' + s + ' changed this page since you opened it; copy your text and reopen',
        unreachable: 'not saved — ' + (j.error || s + ' did not answer'),
        refused: 'not saved — ' + s + ' refused the write' + (j.error ? ': ' + j.error : ''),
      }[out] || 'save rejected: ' + (j.error || r.status);
      if (here) st(say, false);
      flushPending();
      return;
    }
    if (!r || !r.ok) {
      // 'rejected' is the mark's word, and a 502 is the ship's absence, not
      // the mark's opinion of the content. Grub edits have nowhere to queue
      // the way page saves do, so the text just stays here until Save runs
      // again with the ship back.
      // the save queued behind this one still runs (flushPending, 35-pages.js)
      if (shipGone(r)) {
        // no answer at all: the request may still have reached the ship
        st(r ? 'ship unreachable — grub edits do not queue'
          : 'no answer — the save may still land; Ctrl+S to try again', false);
        flushPending();
        return;
      }
      // the mark can reject the source. Show ITS error, since the stored grub
      // still holds the previous content and the user needs to know why
      st('save rejected' + await errText(r), false);
      flushPending();
      return;
    }
    if (here && j && typeof j.rev === 'number') grubRev = j.rev;
    if (here && src.value === sent) dirty = false;
    if (here) st('saved');
    // bust the page DIRECTORY, not the grub: the cached views are the /x/
    // dir listing and page view, and none of their URLs name '/code'
    bustPages(String(p).replace(/\/[^/]*$/, ''));
    flushPending();
  }

