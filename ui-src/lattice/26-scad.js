  // ── OpenSCAD pages (scad) ────────────────────────────────────────────────
  // A scad page's text is OpenSCAD source, edited in the plain editor. All
  // the rest is scad.js (ui-src/scad/), loaded only when a scad page shows:
  // the install bar, the 3D pane (Read, and beside the editor in Edit) and
  // the customizer's edits (ui-src/scad/shell.js). The OpenSCAD runtime is
  // the owner's optional install on the ship (app.hoon, +scad-install-run).
  // Until it is there the preview shows the source. The ship never runs
  // OpenSCAD.
  //
  // This is all app.js carries for it: the lazy load and the hand-off. Even
  // a new page's template is in scad.js (scadBlank). Nothing here runs for
  // a page of another kind, and scad.js and the runtime are never asked for.

  let scadG = null, scadQ = false, scadLoad = null, scadLive = false;
  const scadHere = () => mode !== 'know' && !grubPath && curFolder === null && pkind.value === 'scad';
  //  the 3D pane covers the preview (the runtime is installed)
  const scadOn = () => scadLive && scadHere();
  const scadReady = () => (window.LatScad ? Promise.resolve(window.LatScad)
    : scadLoad || (scadLoad = new Promise((ok, no) => {
      const s = document.createElement('script');
      const fail = () => { scadLoad = null; s.remove(); no(); };
      s.src = '/apps/lattice/app/scad.js?h=' + SCAD_H;
      s.onload = () => (window.LatScad ? ok(window.LatScad) : fail());
      s.onerror = fail;
      document.head.append(s);
    })));
  //  an empty page made a scad page: the box template, from scad.js
  async function scadBlank() {
    let L;
    try { L = await scadReady(); } catch { st('the OpenSCAD template did not load', false); return false; }
    if (!src.value.trim()) { src.value = L.blank; render(); }
    return true;
  }
  //  after render(), and Edit or Read: any new text, kind, page or pane
  function scadFollow() {
    if (!scadQ && (scadG || scadHere())) { scadQ = true; queueMicrotask(scadApply); }
  }
  async function scadApply() {
    scadQ = false;
    if (!scadHere()) { if (scadG) scadG.off(); return; }
    let L;
    try { L = await scadReady(); } catch { st('the OpenSCAD pane did not load', false); return; }
    if (!scadG) {
      scadG = L.shell({
        api, $, st, stWork, errText, isMobile, pageCache, edited,
        here: scadHere,
        src: () => src,
        current: () => current,
        name: () => current || (pname.value || '').trim() || 'untitled',
        editable: () => !src.readOnly && viewingRev === null && !!current,
        live: () => scadLive,
        setLive: (on) => { scadLive = !!on; },
        refresh: () => refreshPreview(),
        toEdit: () => { if (activeTab && activeTab.read) setRead(false); },
        //  fresh: the page is not there yet. The ship refuses (409) to
        //  make one over a page that is, and that is not retried.
        savePage: async (name, kind, body, fresh) => {
          const known = nodes.some((n) => n.page && n.path === name);
          const url = api + '/page-save?name=' + encodeURIComponent(name) + '&type=' + kind;
          const r = await mutate(url + (fresh ? '&new=1' : ''), { method: 'POST', body });
          if (r && r.ok) {
            if (!known) { addTreeNode(name, kind); snapTree(); renderTree(); }
            bustPages(name);
          }
          return r;
        },
      });
    }
    scadG.follow();
  }
  addEventListener('lattheme', () => { if (scadG) scadG.retheme(); });
