  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The spinner is part of the bar's own markup now (its CSS lives in the
  // shell stylesheet). The old inject-styles-and-synthesize-elements guards
  // existed only because the shell and JS could cache-skew apart.
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <a class="home" href="/apps/lattice" title="lattice home">&#8962;</a>
  <button id="modet" title="switch pages / knowledge">&#9998; pages</button>
  <input id="pname" placeholder="page name (e.g. notes/todo)" autocomplete="off" spellcheck="false">
  <select id="pkind" title="page kind">
    <option value="md">md</option>
    <option value="gmi">gmi</option>
    <option value="html">html</option>
    <option value="text">txt</option>
    <option value="js">js</option>
    <option value="css">css</option>
    <option value="hoon">hoon</option>
  </select>
  <button id="save">save</button>
  <span id="spin"></span><span id="status" class="muted"></span>
  <span class="grow"></span>
  <button id="wrapt" class="ico" title="toggle line wrap">&#8617;</button>
  <!-- a KEY, not U+26BF: that codepoint has almost no font coverage and
       rendered as an empty box, which is worse than no button at all. -->
  <button id="cmt" class="ico" title="comments from other ships">&#128172;</button>
  <button id="aclt" class="ico" title="access control &mdash; groups, sharing, banned ships">&#128273;</button>
  <button id="treet" class="ico" title="toggle tree pane">&#9776;</button>
  <button id="ctlt" class="ico" title="toggle controls pane">&#9881;</button>
</header>`;
      pname = $('pname'); pkind = $('pkind');
      status = $('status'); spinner = $('spin');
    }
  });
  customElements.define('lat-tabs', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<nav class="mtabs" id="mtabs">
  <button data-mv="tree">tree</button>
  <button data-mv="code" class="on">code</button>
  <button data-mv="prev">preview</button>
  <button data-mv="ctl">controls</button>
</nav>`;
    }
  });
  // stale-shell guard: replace a cached pre-component shell's literal bar and
  // tabs. The bar relies on source order for its grid row, so it is PREPENDED.
  if (!document.querySelector('lat-bar')) {
    for (const sel of ['header.bar', 'nav.mtabs']) {
      const stale = document.querySelector(sel);
      if (stale) stale.remove();
    }
    const wsEl = document.getElementById('ws');
    const tabs = document.createElement('lat-tabs');
    const bar = document.createElement('lat-bar');
    tabs.style.display = 'contents';
    bar.style.display = 'contents';
    wsEl.prepend(tabs);
    wsEl.prepend(bar);
  }
