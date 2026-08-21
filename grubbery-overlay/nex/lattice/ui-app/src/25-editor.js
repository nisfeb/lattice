  // ── editor pane: <lat-editor> + highlighting (Prism overlay) ─────────────
  let src, hl;   // assigned when <lat-editor> upgrades (below, synchronously)
  const LMAP = { md: 'markdown', gmi: 'gemtext', html: 'markup',
                 js: 'javascript', css: 'css', hoon: 'hoon' };
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const render = () => {
    const lang = LMAP[pkind.value];
    const g = window.Prism && lang && Prism.languages[lang];
    hl.innerHTML = (g ? Prism.highlight(src.value, g, lang) : esc(src.value)) + '\n';
  };
  const sync = () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; };
  // per-keystroke highlight throttle: Prism re-tokenizes the WHOLE document on
  // every render, which drops frames on large pages. Coalesce to one render per
  // frame. Past ~60KB fall back to a trailing debounce (even one full highlight
  // per frame is too heavy there).
  let hlRaf = 0, hlTimer = 0;
  const scheduleRender = () => {
    if (src.value.length > 60000) {
      clearTimeout(hlTimer);
      hlTimer = setTimeout(() => { render(); sync(); }, 120);
    } else if (!hlRaf) {
      hlRaf = requestAnimationFrame(() => { hlRaf = 0; render(); sync(); });
    }
  };
  // +edited: announce a PROGRAMMATIC change to the editor exactly as if it had
  // been typed. Setting src.value fires no input event, so anything that only
  // called render() silently skipped the dirty flag, autosave and the preview.
  // A Tab indent was shown but never saved, and a live refresh reverted it.
  // Always route scripted edits through here.
  const edited = () => src.dispatchEvent(new Event('input'));
  customElements.define('lat-editor', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div class="edwrap">
  <div id="acmirror" aria-hidden="true"></div>
  <div id="ac" class="ac" hidden role="listbox" aria-label="page suggestions"></div>
  <pre id="hl" aria-hidden="true"></pre>
  <textarea id="src" spellcheck="false" placeholder="open a page from the tree, or name a new one and start typing"></textarea>
</div>`;
      src = $('src'); hl = $('hl');
      src.addEventListener('input', () => {
        dirty = true;
        everTyped = true;      // never cleared: see 20-state.js
        scheduleRender();
        clearTimeout(autoTimer);
        autoTimer = setTimeout(autosave, 2000);
      });
      src.addEventListener('scroll', sync);
    }
  });
  // stale-shell guard: a cached index.html predating <lat-editor> still has
  // the literal .edwrap block (and lacks the lat-* display rule). Swap it.
  if (!document.querySelector('lat-editor')) {
    const stale = document.querySelector('.edwrap');
    if (stale) stale.remove();
    const el = document.createElement('lat-editor');
    el.style.display = 'contents';
    document.getElementById('ws').appendChild(el);
  }
  pkind.addEventListener('change', () => {
    curKind = pkind.value;
    render();
    if (typeof refreshTexButton === 'function') refreshTexButton();
  });
