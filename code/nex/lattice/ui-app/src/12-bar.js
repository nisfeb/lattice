  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The spinner is part of the bar's own markup now (its CSS lives in the
  // shell stylesheet). The old inject-styles-and-synthesize-elements guards
  // existed only because the shell and JS could cache-skew apart.
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <!-- the icon-only controls carry aria-labels: their glyph is their whole
       text content, which is no accessible name at all -->
  <a class="home" href="/apps/lattice" title="lattice home" aria-label="lattice home">&#8962;</a>
  <button id="modet" title="switch pages / knowledge">&#9998; pages</button>
  <input id="pname" placeholder="page name (e.g. notes/todo)" autocomplete="off" spellcheck="false">
  <select id="pkind" title="page kind">
    <option value="md">md</option>
    <option value="gmi">gmi</option>
    <option value="html">html</option>
    <option value="text">txt</option>
    <option value="js">js</option>
    <option value="css">css</option>
    <option value="tex">tex</option>
    <option value="hoon">hoon</option>
  </select>
  <button id="save">save</button>
  <!-- LaTeX conversion runs on the user's own machine (71-latex.js),
       so this is hidden on the web and on non-tex pages. -->
  <button id="texconv" hidden>convert to html</button>
  <!-- role=status so "saved" and every failure are announced, not just
       painted onto a line a screen reader never revisits -->
  <span id="spin"></span><span id="status" class="muted" role="status" aria-live="polite"></span>
  <!-- Offline state is a CONDITION, not an event, so it cannot live in the
       status line: the next save, render or refresh overwrites that. This
       badge stays up for as long as the condition holds. -->
  <span id="offbadge" class="offbadge" role="status" aria-live="polite" hidden></span>
  <span class="grow"></span>
  <button id="wrapt" class="ico" title="toggle line wrap" aria-label="toggle line wrap">&#8617;</button>
  <!-- a KEY, not U+26BF: that codepoint has almost no font coverage and
       rendered as an empty box, which is worse than no button at all. -->
  <button id="qt" class="ico" title="search your pages and notes (ctrl-K)" aria-label="search your pages and notes (ctrl-K)">&#128269;</button>
  <button id="cmt" class="ico" title="comments from other ships" aria-label="comments from other ships">&#128172;</button>
  <!-- a save that replaced an edit from elsewhere keeps the losing body as a
       conflicts/ page. Those are invisible unless you already know to look,
       which is the one failure a conflict design must not have. This badge
       counts them and opens the resolve pane. -->
  <button id="cflt" class="ico" title="sync conflicts to resolve" aria-label="sync conflicts to resolve" hidden>&#9873;</button>
  <button id="aclt" class="ico" title="access control &mdash; groups, sharing, banned ships" aria-label="access control &mdash; groups, sharing, banned ships">&#128273;</button>
  <button id="treet" class="ico" title="toggle tree pane" aria-label="toggle tree pane">&#9776;</button>
  <button id="ctlt" class="ico" title="toggle controls pane" aria-label="toggle controls pane">&#9881;</button>
</header>`;
      pname = $('pname'); pkind = $('pkind');
      status = $('status'); spinner = $('spin'); offbadge = $('offbadge');
      renderOffline();   // a queue can outlive a session, so show it at boot
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
