  // ── send the open page to orrery (ui-app/orrery.js, docs/orrery.md) ──────
  // A section of the controls pane, shown only while orrery is installed and
  // a saved page is open: a folder, or a new page not saved yet, has nothing
  // for orrery to follow. Follows every target change through +showShare.
  function orreryShow() {
    const sec = $('orrsec'), el = $('orr');
    if (!sec || !el || !window.LatticeOrrery) return;
    if (curFolder || !current) {
      LatticeOrrery.unmount(el);
      sec.hidden = true;
      return;
    }
    const path = current;
    LatticeOrrery.mount(el, path, () => {
      const n = nodes.find((x) => x.path === path);
      return { title: (n && n.dname) || path.split('/').pop(), text: src.value };
    }, sec);
  }
