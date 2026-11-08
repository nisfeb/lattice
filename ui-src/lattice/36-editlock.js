  // ── one window edits a page (navigator.locks, BroadcastChannel) ──────────
  // Two windows on one page each saved their own text, unaware of the
  // other. Now the window that opens a page first holds its edit lock
  // ('lat-edit:<name>'), and another window opens it read-only, with a bar
  // saying so and a button to edit there instead. That asks the holder,
  // over a BroadcastChannel, to save and let go; the holder then shows the
  // page read-only itself. A read-only window takes the lock once the
  // holder lets go (closes, or opens something else), and reads the page
  // again before it edits. With no navigator.locks (an older webview)
  // every window edits, and the ship's stale check (casQ, 35-pages.js)
  // still refuses the one that is behind.
  const lockCh = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lat-edit') : null;
  let lockName = null;     // the page this window holds, or waits for
  let lockHeld = false;
  let lockFree = null;     // lets go of the held lock
  let lockWait = null;     // stops the wait for it
  let lockBusy = false;    // known to be held by another window
  //  only once another window is KNOWN to hold it: while this window's
  //  request is still being answered, the page stays editable
  const editLocked = () => !!navigator.locks && lockBusy && !!lockName && current === lockName
    && !lockHeld && mode !== 'know' && !grubPath;
  const LOCK_NOTE = 'This page is open for editing in another window, so it is read-only here.';
  const lockBar = document.createElement('div');
  lockBar.id = 'lockbar';
  lockBar.className = 'lnkcf';
  lockBar.hidden = true;
  lockBar.setAttribute('role', 'status');
  lockBar.innerHTML = '<span></span> <button type="button" id="locktake">Edit here instead</button>';
  lockBar.firstChild.textContent = LOCK_NOTE;
  function paintLock() {
    const d = $('docarea');
    if (d && !lockBar.isConnected) d.before(lockBar);
    const ro = editLocked();
    lockBar.hidden = !ro;
    if (ro) src.readOnly = true;
    else if (lockName && current === lockName && viewingRev === null) src.readOnly = linkRO(current);
  }
  function letGo() {
    if (lockWait) { lockWait.abort(); lockWait = null; }
    if (lockFree) { lockFree(); lockFree = null; }
    lockHeld = false;
    lockBusy = false;
  }
  function hold(name, late) {
    lockHeld = true;
    lockBusy = false;
    paintLock();
    //  the holder may have saved since this window read it
    if (late && current === name && mode !== 'know' && !grubPath) openPage(name);
    return new Promise((res) => { lockFree = res; });
  }
  //  the editor shows `name` (null: no page): hold its lock, or wait for it
  function editLock(name) {
    if (!navigator.locks) return;
    if (name === lockName) return paintLock();
    letGo();
    lockName = name;
    paintLock();
    if (!name) return;
    const ac = new AbortController();
    lockWait = ac;
    navigator.locks.request('lat-edit:' + name, { ifAvailable: true }, (l) => {
      if (lockName !== name || ac.signal.aborted) return null;
      if (l) return hold(name);
      //  a document of this same window being navigated away from still
      //  holds it for a moment: only a holder that keeps it past a grace
      //  makes the page read-only here
      const grace = setTimeout(() => {
        if (lockName !== name || lockHeld || ac.signal.aborted) return;
        lockBusy = true;
        paintLock();
      }, 2000);
      navigator.locks.request('lat-edit:' + name, { signal: ac.signal }, () => {
        clearTimeout(grace);
        return lockName === name ? hold(name, lockBusy) : null;
      }).catch(() => clearTimeout(grace));
      return null;
    }).catch(() => {});
  }
  //  "Edit here instead": the holder saves, lets go and waits its turn
  lockBar.querySelector('button').onclick = () => lockCh && lockName && lockCh.postMessage({ give: lockName });
  if (lockCh) lockCh.onmessage = async (e) => {
    const m = e.data || {};
    if (!m.give || !lockHeld || m.give !== lockName) return;
    const name = lockName;
    await flushNoAsk();
    await savesSettled();
    if (lockName !== name || !lockHeld) return;
    letGo();
    lockName = null;
    editLock(name);
    st(name + ' is being edited in another window now, so it is read-only here', false);
  };
