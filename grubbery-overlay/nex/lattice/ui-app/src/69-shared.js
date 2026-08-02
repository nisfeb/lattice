  // ── shared with me: <lat-shared> — files other ships granted us ──────────
  // Fed by their share notices (claims, not capabilities — the entry proves
  // itself when opened, and a stale one can just be removed).
  customElements.define('lat-shared', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="swmsec">
<h3>shared with me</h3>
<div id="swmlist" class="muted">loading…</div>
</div>`;
    }
  });
  async function loadShared() {
    let r = null;
    try { r = await fetch(api + '/shared-with-me'); } catch {}
    if (!r || !r.ok) { $('swmlist').textContent = 'could not load'; return; }
    const items = await r.json();
    const host = $('swmlist');
    host.textContent = '';
    if (!items.length) {
      host.className = 'muted';
      host.textContent = 'nothing yet — when a peer shares a file with you it appears here.';
      return;
    }
    host.className = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'chips';
      const a = document.createElement('a');
      a.textContent = it.host + ' ' + shortPath(it.path, items.map((x) => x.path)) +
        ' (' + it.mode + ')';
      a.title = it.path + ' — open in the editor';
      a.href = '/apps/lattice/app?grub=' + encodeURIComponent(it.path) +
        '&ship=' + encodeURIComponent(it.host);
      const x = document.createElement('a');
      x.textContent = '×';
      x.title = 'remove from this list (does not touch their grant)';
      x.onclick = async () => {
        await fetch(api + '/shared-with-me-del?host=' + encodeURIComponent(it.host) +
          '&path=' + encodeURIComponent(it.path), { method: 'POST' }).catch(() => null);
        loadShared();
      };
      row.appendChild(a); row.appendChild(x);
      host.appendChild(row);
    }
  }
  // deferred to boot, same reason as loadPerms — see 67-perms.js.
