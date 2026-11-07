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
<div id="shvia" class="muted" hidden></div>
<div class="row"><button id="shcopy" type="button" data-action="share-copylink">copy link</button></div>
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
  // copies, so the two can never disagree. A folder's setting is folder
  // sharing (app.hoon %share-dir): its pages take it, and its address is
  // its index, urb://<ship>/<folder>/.
  const cwUrl = (target) => location.origin + api + '/c/' + target;
  // our own ship, for the urb:// address: Eyre's /~/host, asked once. ''
  // while it is on its way, null if it failed. Until then there is no
  // address, never a made-up one: nothing shows or copies a placeholder.
  let ourShip = '';
  const urbUrl = (target) => (ourShip ? 'urb://' + ourShip + '/' + target : null);
  const urbMissing = () => (ourShip === null ? 'address unavailable' : 'loading address');
  // ── copy link: a page's urb:// address on the clipboard ─────────────────
  // navigator.clipboard first. It can be missing or refuse (a page that is
  // not a secure context, an older WebKitGTK in the desktop app), so the
  // fallback copies from a hidden textarea with execCommand, which works
  // inside the click that asked. Neither needs a Tauri permission: only
  // the clipboard-manager plugin does, and this uses no plugin.
  async function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch {}
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    const back = document.activeElement;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    if (back && back.focus) back.focus();
    return ok;
  }
  // The address a page answers at: mine at urb://<our ship>/<name>, a page
  // linked in from another ship at the host's own address (linkFrom), and
  // a shared with me entry at urb://<host>/<name>. A private page answers
  // only to the ships it is shared with.
  const pageUrb = (name) => {
    const lk = linkOf(name);
    return lk ? 'urb://' + linkFrom(lk) : urbUrl(name);
  };
  const swmUrb = (it) => 'urb://' + linkFrom(it);
  // a grub open from another ship is a shared page when it is a page's code
  const grubUrb = () => {
    const m = grubShip && /\/page\/(.+)\/code$/.exec(grubPath || '');
    return m ? 'urb://' + grubShip + '/' + m[1] : null;
  };
  async function copyLink(u) {
    if (!u) { st('no link to copy: ' + urbMissing(), false); return false; }
    if (await copyText(u)) { st('link copied: ' + u); return true; }
    st('could not copy ' + u, false);
    return false;
  }
  let shareShown = null;
  // (asked from a microtask, off app.js's top level: see boot, 99-boot.js)
  queueMicrotask(() => fetch('/~/host').then((r) => (r.ok ? r.text() : '')).catch(() => '').then((t) => {
    ourShip = t.trim() || null;
    if (shareShown) paintShareCopy(shareShown);
    renderPublished();
  }));
  const at = (u) => (u ? 'at ' + u : '(' + urbMissing() + ')');
  const SHARE_COPY = {
    private: () => 'Private: only you, and any ship or group you give access below. '
      + 'Not published anywhere.',
    shared: (u) => 'Shared: any ship can read it over Urbit ' + at(u) + '. Not on the web.',
    clearweb: (u, w) => 'Clearweb: anyone with the link can read it on the web at '
      + w + ', no login needed. Any ship can also read it over Urbit ' + at(u) + '.',
  };
  const KEEP = ' Pages added or moved in later are shared too. A page with its own '
    + 'setting, or marked sensitive, keeps its own.';
  const FOLDER_COPY = {
    private: () => 'Private: the folder shares nothing. Its pages keep their own settings.',
    shared: (u) => 'Shared: any ship can read every page in it over Urbit, with an index '
      + at(u) + '. Not on the web.' + KEEP,
    clearweb: (u, w) => 'Clearweb: anyone with the link can read every page in it on the web at '
      + w + ', no login needed, and any ship over Urbit ' + at(u) + '.' + KEEP,
  };
  function paintShareCopy(m) {
    shareShown = m;
    const target = curFolder || current;
    const copy = curFolder ? FOLDER_COPY : SHARE_COPY;
    const t = target ? target + (curFolder ? '/' : '') : 'this-page';
    const u = urbUrl(t), w = cwUrl(t);
    for (const b of document.querySelectorAll('.share button')) b.title = copy[b.dataset.m](u, w);
    $('sharewhat').textContent = copy[m] ? copy[m](u, w) : '';
    // a folder answers at its index once it is shared, and an unsaved page
    // has no address yet
    $('shcopy').hidden = curFolder ? m === 'private' : !current;
  }
  $('shcopy').onclick = () => copyLink(curFolder ? urbUrl(curFolder + '/')
    : current ? pageUrb(current) : null);

  // ── shared via folder ────────────────────────────────────────────────────
  // A page with no setting of its own takes its nearest folder's (the
  // tree's `via`); one with its own setting under a shared folder may go
  // back to the folder's. Either way the folder's settings are a click.
  const folderOf = (path) => {
    for (let p = path; p.includes('/');) {
      p = p.slice(0, p.lastIndexOf('/'));
      const f = nodes.find((x) => !x.page && x.path === p);
      if (f && f.dshare) return f;
    }
    return null;
  };
  function paintVia() {
    const el = $('shvia');
    el.textContent = '';
    const n = !curFolder && current ? nodes.find((x) => x.page && x.path === current) : null;
    const f = n ? (n.via ? nodes.find((x) => !x.page && x.path === n.via) || { path: n.via }
      : folderOf(n.path)) : null;
    el.hidden = !f;
    if (!f) return;
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = f.path + '/';
    a.title = 'Open the folder\u2019s settings';
    a.onclick = (e) => { e.preventDefault(); pickFolder(f.path); };
    if (n.via) {
      el.append('Shared via folder ', a, '. Pick a mode above to give this page its own.');
      return;
    }
    el.append('Its own setting. Folder ', a, ' is ' + f.dshare + '. ');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'use folder setting';
    b.onclick = async () => {
      const name = current;
      const r = await mutate(api + '/page-share-clear?name=' + encodeURIComponent(name));
      if (!r.ok) { st('share failed' + await errText(r), false); return; }
      st('sharing: from folder ' + f.path);
      await loadTree();
      const m = nodes.find((x) => x.page && x.path === name);
      if (name === current) showShare((m && m.share) || 'private');
    };
    el.append(b);
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
    paintVia();
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
      const was = curFolder ? (nodes.find((x) => !x.page && x.path === curFolder) || {}).dshare
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
          // the folder's own setting (folder sharing): its pages take it,
          // later ones too, and which do is the server's to say, so the
          // tree is fetched again rather than guessed
          const f = curFolder;
          const r = await mutate(api + '/page-share-dir?name=' + encodeURIComponent(f) +
            '&mode=' + m);
          if (!r.ok) { st('share failed' + await errText(r), false); return; }
          const fn = nodes.find((x) => !x.page && x.path === f);
          if (fn) { if (m === 'private') delete fn.dshare; else fn.dshare = m; }
          if (curFolder === f) showShare(m);
          st(m === 'private' ? 'folder ' + f + ' shares nothing'
            : m === 'clearweb' ? 'folder shared at /c/' + f + '/' : 'folder ' + f + ' shared');
          await loadTree();
          return;
        }
        // the page this was asked for: another may be open by the answer
        const name = current;
        if (!name) { st('save the page first', false); return; }
        const r = await mutate(api + '/page-share?name=' + encodeURIComponent(name) +
          '&mode=' + m);
        if (!r.ok) { st('share failed' + await errText(r), false); return; }
        if (current === name && !curFolder) showShare(m);
        st('sharing: ' + m);
        const n = nodes.find((x) => x.page && x.path === name);
        if (n) { n.share = m; delete n.via; }
        paintVia();
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
      (j.notified ? ' — notified.' : j.folder ? ', and they are told of the folder.'
        : ' — could not notify (offline?); the grant holds.');
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
    const gen = sensGen;
    try {
      const r = await fetch(api + '/page-sensitive?name=' + encodeURIComponent(target));
      const on = r.ok && (await r.json()).on === true;
      if (r.ok && gen === sensGen) sensKnown.set(target, on);
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
    // marking takes back folder and group grants, but the page's own share
    // stays: say so, since it still leaves this ship
    let shared = false;
    try { shared = (await r.json()).shared === true; } catch {}
    if (!here) return;
    cb.checked = want;
    $('shsensres').textContent = !want
      ? target + ' is no longer sensitive'
      : shared
        ? target + ' is sensitive, but still shared on its own: unshare it to keep it here'
        : target + ' is sensitive';
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
