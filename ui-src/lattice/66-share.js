  // ── sharing panel: <lat-share> (pages and folder trees share it) ─────────
  let cwurl;
  customElements.define('lat-share', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="sharesec">
<h3>sharing</h3>
<div class="share" id="share">
  <button data-m="private" data-action="share-private">private</button>
  <button data-m="shared" data-action="share-shared">shared</button>
  <button data-m="clearweb" data-action="share-clearweb">clearweb</button>
</div>
<div id="sharewhat" class="muted sharewhat"></div>
<div id="cwurl" class="muted"></div>
<h3>give a ship access</h3>
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
<h3 class="grouphead">give a group access <a id="aclopen" data-action="aclopen" title="create and edit groups">manage &rarr;</a></h3>
<div id="grouplist" class="muted"></div>
<h3>sensitive</h3>
<!-- only the box toggles: the words beside it are plain text, not a label
     around both, so a click on them changes nothing. They describe it. -->
<div class="chk"><input type="checkbox" id="shsens" data-action="shsens" aria-label="Mark sensitive" aria-describedby="shsensd">
<span id="shsensd" class="muted">mark sensitive: agents without clearance can't see or write it</span></div>
<div id="shsensres" class="muted"></div>
</div>
<div id="orrsec" hidden><h3>orrery</h3><div id="orr"></div></div>`;
      cwurl = $('cwurl');
    }
  });
  // ── what each mode does, said where it is picked ─────────────────────────
  // The three read as a set, and each says who can read the page and where
  // (apply-share in app.hoon): private is in no published copy at all;
  // shared puts a copy under /pub, which is publicly granted, so any ship
  // reads it over ames at its urb:// address; clearweb is shared plus the
  // unauthenticated /c/ route. A ship or group granted below reads a
  // private page too (share-file grants the code grub itself), so private
  // says so.
  //
  // The addresses are the real ones for the target. cwUrl is the one the
  // public link below shows and the Published pages list (72-acl.js)
  // copies, so the two can never disagree. urb:// has no folder form, so a
  // folder's copy points at its pages instead of printing one.
  const cwUrl = (target) => location.origin + api + '/c/' + target;
  // our own ship, for the urb:// address: Eyre's /~/host, asked once. ''
  // while it is on its way, null if it failed. Until then there is no
  // address, never a made-up one: nothing shows or copies a placeholder.
  let ourShip = '';
  const urbUrl = (target) => (ourShip ? 'urb://' + ourShip + '/' + target : null);
  const urbMissing = () => (ourShip === null ? 'address unavailable' : 'loading address');
  let shareShown = null;
  fetch('/~/host').then((r) => (r.ok ? r.text() : '')).catch(() => '').then((t) => {
    ourShip = t.trim() || null;
    if (shareShown) paintShareCopy(shareShown);
    renderPublished();
  });
  const at = (u) => (u ? 'at ' + u : '(' + urbMissing() + ')');
  const SHARE_COPY = {
    private: () => 'Private: only you, and any ship or group you give access below. '
      + 'Not published anywhere.',
    shared: (u) => 'Shared: any ship can read it over Urbit ' + at(u) + '. Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read it over Urbit ' + at(u) + '.',
  };
  const FOLDER_COPY = {
    private: SHARE_COPY.private,
    shared: () => 'Shared: any ship can read every page in it over Urbit, each at its '
      + 'own urb:// address (Access & groups lists them). Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read every page in it over Urbit.',
    mixed: () => 'Mixed: the pages in this folder are not all shared the same way. '
      + 'Access & groups lists the published ones.',
  };
  function paintShareCopy(m) {
    shareShown = m;
    const target = curFolder || current;
    const copy = curFolder ? FOLDER_COPY : SHARE_COPY;
    const t = target ? target + (curFolder ? '/' : '') : 'this-page';
    const u = curFolder ? null : urbUrl(t), w = cwUrl(t);
    for (const b of document.querySelectorAll('.share button')) b.title = copy[b.dataset.m](u, w);
    $('sharewhat').textContent = copy[m] ? copy[m](u, w) : '';
  }

  function showShare(m) {
    // the grant result names "this page", so it MUST NOT outlive the page it
    // was about. Every target change (page open, new file, folder select,
    // beacon sync) routes through here. A fuzz run caught it claiming
    // "~nec can now edit this page" while a different page was open, which
    // is a permissions UI telling the user something false.
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
    // the group toggles are about THIS file, so they follow the same
    // every-target-change hook the grant message does
    renderGroupAccess();
    paintShareCopy(m);
    orreryShow();
    refreshSensitive(curFolder || current);
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    // Build the public link as DOM, never innerHTML: a page/folder name is
    // content (the codebase rule everywhere else), and interpolating it into
    // markup makes this sink depend on every name source staying sane-%ta.
    cwurl.textContent = '';
    if (m === 'clearweb' && target) {
      const url = cwUrl(target + suffix);
      cwurl.appendChild(document.createTextNode('public: '));
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '/c/' + target + suffix;   // textContent: names are content
      cwurl.appendChild(a);
    } else if (m === 'mixed') {
      cwurl.textContent = 'mixed: pages under this folder differ';
    }
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      const m = b.dataset.m;
      // going public from private (or from a folder, which may be mixed)
      // asks first; moving between the two public modes does not
      const was = curFolder ? null
        : (nodes.find((x) => x.page && x.path === current) || {}).share;
      const pub = (x) => x === 'shared' || x === 'clearweb';
      if (pub(m) && !pub(was) && !(await askPublish())) return;
      // a share write is a real round trip (0.3-2s), and all three buttons
      // stayed clickable through it — enough time for a second click to fire
      // a second mutation against the same target. Freeze the row for the
      // duration; the st() calls below already end the spin either way.
      const btns = document.querySelectorAll('.share button');
      for (const x of btns) x.disabled = true;
      stWork('setting ' + m + '…');
      try {
        if (curFolder) {
          const r = await mutate(api + '/page-share-tree?name=' + encodeURIComponent(curFolder) +
            '&mode=' + m);
          if (!r.ok) { st('share failed' + await errText(r), false); return; }
          showShare(m);
          st(m === 'clearweb' ? 'published tree at /c/' + curFolder + '/' : 'tree set ' + m);
          // share-tree sets every page under the folder. Mirror that locally
          // instead of refetching the tree to learn what we just did.
          for (const n of nodes)
            if (n.page && n.path.startsWith(curFolder + '/')) n.share = m;
          snapTree();
          renderTree();
          return;
        }
        if (!current) { st('save the page first', false); return; }
        const r = await mutate(api + '/page-share?name=' + encodeURIComponent(current) +
          '&mode=' + m);
        if (!r.ok) { st('share failed' + await errText(r), false); return; }
        showShare(m);
        st('sharing: ' + m);
        const n = nodes.find((x) => x.page && x.path === current);
        if (n) n.share = m;
        snapTree();
        renderTree();
      } finally {
        for (const x of btns) x.disabled = false;
      }
    };
  }

  // ── per-file share-with: grant one ship read/edit on the OPEN page ───────
  // Writes through the same usergroups as the peers panel (an auto-group named
  // after the ship), then notifies them. The response says whether the notice
  // arrived. The grant is durable either way.
  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    // NAME the page rather than saying "this page". The editor's target can
    // change from eleven places (mode toggle, grub mode, memory open, rename,
    // …) and only four of them route through showShare, so a clear-on-change
    // hook is whack-a-mole. A fuzz run caught the message surviving the
    // pages/knowledge toggle. A message that names its own subject cannot go
    // false no matter what the editor does next, which is the property that
    // actually matters for a permissions UI.
    const page = current;
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(page) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      $('shres').textContent = '';
      st('share failed' + await errText(r), false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' ' + page +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');

  // ── mark-sensitive: the OPEN page or folder's OWN sensitive flag ─────────
  // A sensitive page (or folder, inherited by its pages) is invisible to an
  // agent key without the sensitive clearance, and such a key cannot write it.
  // The checkbox shows and sets this page's own marker; refreshed on every
  // target change through showShare, like the grant row above.
  // the target whose toggle is on the wire: the box shows the ask until
  // the answer, and no refresh meanwhile paints the flag from before it
  let sensSetting = null;
  const refreshSensitive = async (target) => {
    const cb = $('shsens');
    if (!cb) return;
    if (target && target === sensSetting) return;
    $('shsensres').textContent = '';
    if (!target) { cb.checked = false; cb.disabled = true; return; }
    cb.disabled = false;
    // known: no request. In flight with the open's page-source: that
    // answer brings it and comes back here (openPage).
    if (sensKnown.has(target)) { cb.checked = sensKnown.get(target); return; }
    if (sensWait === target) { cb.checked = false; return; }
    try {
      const r = await fetch(api + '/page-sensitive?name=' + encodeURIComponent(target));
      const on = r.ok && (await r.json()).on === true;
      if (r.ok) sensKnown.set(target, on);
      // the target can change while this GET is in flight (same bug class the
      // showShare comment documents): only apply if it is still current.
      if ((curFolder || current) !== target) return;
      cb.checked = on;
    } catch { if ((curFolder || current) === target) cb.checked = false; }
  };
  $('shsens').onchange = async () => {
    const target = curFolder || current;
    const cb = $('shsens');
    if (!target) { st('open a page first', false); cb.checked = false; return; }
    cb.disabled = true;
    // what was asked for, not what the box says when the answer lands
    const want = cb.checked;
    sensSetting = target;
    let r = null;
    try {
      r = await mutate(api + '/page-sensitive?name=' + encodeURIComponent(target) +
        '&on=' + (want ? '1' : '0'));
    } finally { sensSetting = null; }
    const here = (curFolder || current) === target;
    if (here) cb.disabled = false;
    if (!r || !r.ok) {
      if (here) cb.checked = !want;
      st('sensitive failed' + await errText(r), false);
      return;
    }
    sensKnown.set(target, want);
    if (!here) return;
    cb.checked = want;
    $('shsensres').textContent = want
      ? target + ' is sensitive'
      : target + ' is no longer sensitive';
  };

  // ── per-file group access ────────────────────────────────────────────────
  // The same read/edit grant as the ship row above, but pointed at a group
  // rather than one ship. This pane only SETS existing groups on this file.
  // Creating and editing the groups themselves is the ACL pane's job (there is
  // a link), which is what took the busy chip editor out of this narrow
  // column. Grants go through permSave, so both surfaces agree.
  //
  // A group's grant on a page is the page's own ball path in its peek/make,
  // exactly what the server's share-file writes, so a per-ship grant and a
  // per-group grant are the same kind of rule and read back the same way.
  // selfBase is set before permsLoaded, and nothing here runs before that.
  const pagePath = (name) => selfBase + '/page/' + name;

  function renderGroupAccess() {
    const host = $('grouplist');
    if (!host) return;
    host.textContent = '';
    const target = curFolder || current;
    if (!target) {
      host.className = 'muted';
      host.textContent = 'open a page to grant access.';
      return;
    }
    if (!permsLoaded) {
      host.className = 'muted';
      host.textContent = 'loading groups…';
      return;
    }
    if (!permGroups.length) {
      host.className = 'muted';
      host.textContent = 'no groups yet — use manage → to make one.';
      return;
    }
    host.className = '';
    const path = pagePath(target);
    for (const g of permGroups) {
      const row = document.createElement('div');
      row.className = 'grow-row';
      const nm = document.createElement('span');
      nm.className = 'gname';
      nm.textContent = g.name;
      row.appendChild(nm);
      const mk = (label, on, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (on) b.className = 'on';
        b.onclick = fn;
        row.appendChild(b);
      };
      const canRead = g.peek.includes(path);
      const canEdit = g.make.includes(path);
      mk('read', canRead, () => {
        if (canRead) {
          // dropping read drops edit. Edit without read cannot be exercised
          g.peek = g.peek.filter((x) => x !== path);
          g.make = g.make.filter((x) => x !== path);
        } else g.peek.push(path);
        permSave(g);
      });
      mk('edit', canEdit, () => {
        if (canEdit) g.make = g.make.filter((x) => x !== path);
        else {
          if (!g.peek.includes(path)) g.peek.push(path);   // edit implies read
          g.make.push(path);
        }
        permSave(g);
      });
      host.appendChild(row);
    }
  }
  $('aclopen').onclick = () => aclOpen();
  // the panel's palette actions. Going public still asks (askPublish),
  // since the action is the button's own click.
  clickAction('share-private', 'Make private', 'Right pane › Page');
  clickAction('share-shared', 'Share over Urbit', 'Right pane › Page');
  clickAction('share-clearweb', 'Publish to the clearweb', 'Right pane › Page');
  clickAction('shsens', 'Mark sensitive', 'Right pane › Page');
  clickAction('aclopen', 'Manage groups', 'Right pane › Page');
