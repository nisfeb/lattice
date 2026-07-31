  // ── sharing panel: <lat-share> (pages and folder trees share it) ─────────
  let cwurl;
  customElements.define('lat-share', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="sharesec">
<h3>sharing</h3>
<div class="share" id="share">
  <button data-m="private">private</button>
  <button data-m="shared">shared</button>
  <button data-m="clearweb">clearweb</button>
</div>
<div id="cwurl" class="muted"></div>
<div class="row"><input id="shwith" placeholder="~ship" autocomplete="off"><button id="shread">read</button><button id="shedit">edit</button></div>
<div id="shres" class="muted"></div>
</div>`;
      cwurl = $('cwurl');
    }
  });
  function showShare(m) {
    // the grant result names "this page", so it MUST NOT outlive the page it
    // was about — every target change (page open, new file, folder select,
    // beacon sync) routes through here. A fuzz run caught it claiming
    // "~nec can now edit this page" while a different page was open, which
    // is a permissions UI telling the user something false.
    $('shres').textContent = '';
    for (const b of document.querySelectorAll('.share button'))
      b.className = b.dataset.m === m ? 'on' : '';
    const target = curFolder || current;
    const suffix = curFolder ? '/' : '';
    cwurl.innerHTML =
      m === 'clearweb' && target
        ? 'public: <a href="' + api + '/c/' + target + suffix +
          '" target="_blank">/c/' + target + suffix + '</a>'
      : m === 'mixed' ? 'mixed — pages under this folder differ'
      : '';
  }
  for (const b of document.querySelectorAll('.share button')) {
    b.onclick = async () => {
      const m = b.dataset.m;
      if (curFolder) {
        const r = await mutate(api + '/page-share-tree?name=' + encodeURIComponent(curFolder) +
          '&mode=' + m);
        if (!r.ok) { st('share failed ' + r.status, false); return; }
        showShare(m);
        st(m === 'clearweb' ? 'published tree at /c/' + curFolder + '/' : 'tree set ' + m);
        // share-tree sets every page under the folder — mirror that locally
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
      if (!r.ok) { st('share failed ' + r.status, false); return; }
      showShare(m);
      st('sharing: ' + m);
      const n = nodes.find((x) => x.page && x.path === current);
      if (n) n.share = m;
      snapTree();
      renderTree();
    };
  }

  // ── per-file share-with: grant one ship read/edit on the OPEN page ───────
  // Writes through the same usergroups as the peers panel (an auto-group named
  // after the ship), then notifies them; the response says whether the notice
  // arrived — the grant is durable either way.
  const shareWith = async (mode) => {
    const shp = $('shwith').value.trim();
    if (!current) { st('open a page first', false); return; }
    if (!shp) { st('enter a ship', false); return; }
    // NAME the page rather than saying "this page". The editor's target can
    // change from eleven places (mode toggle, grub mode, memory open, rename,
    // …) and only four of them route through showShare, so a clear-on-change
    // hook is whack-a-mole — a fuzz run caught the message surviving the
    // pages/knowledge toggle. A message that names its own subject cannot go
    // false no matter what the editor does next, which is the property that
    // actually matters for a permissions UI.
    const page = current;
    $('shres').textContent = 'granting…';
    const r = await mutate(api + '/share-file?name=' + encodeURIComponent(page) +
      '&ship=' + encodeURIComponent(shp) + '&mode=' + mode);
    if (!r || !r.ok) {
      let msg = r ? r.status : 'network';
      if (r) { try { const j = await r.json(); if (j.error) msg = j.error; } catch {} }
      $('shres').textContent = '';
      st('share failed: ' + msg, false);
      return;
    }
    const j = await r.json();
    $('shres').textContent = shp + ' can now ' + mode + ' ' + page +
      (j.notified ? ' — notified.' : ' — could not notify (offline?); the grant holds.');
    loadPerms();          // the peers panel shows the auto-group
  };
  $('shread').onclick = () => shareWith('read');
  $('shedit').onclick = () => shareWith('edit');
