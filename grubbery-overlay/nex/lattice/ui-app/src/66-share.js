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
</div>`;
      cwurl = $('cwurl');
    }
  });
  function showShare(m) {
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
