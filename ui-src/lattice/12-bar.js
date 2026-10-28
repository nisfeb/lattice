  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The shell frame (13-frame.js) took the bar's job on desktop: the corner
  // toggles, the status line and its spinner live there now, and this bar
  // shows only at phone width. Its other controls stay in the DOM, hidden,
  // until later steps give each one its home, because handlers and the
  // desktop menu still find them by id.
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <!-- the icon-only controls carry aria-labels: their glyph is their whole
       text content, which is no accessible name at all -->
  <a class="home" href="/apps/lattice" title="lattice home" aria-label="lattice home">&#8962;</a>
  <button id="modet" hidden title="switch pages / knowledge">&#9998; pages</button>
  <input id="pname" hidden placeholder="page name (e.g. notes/todo)" autocomplete="off" spellcheck="false">
  <select id="pkind" hidden title="page kind">
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
  <span class="grow"></span>
  <button id="wrapt" class="ico" hidden title="toggle line wrap" aria-label="toggle line wrap">&#8617;</button>
  <button id="qt" class="ico" hidden title="search your pages and notes (ctrl-K)" aria-label="search your pages and notes (ctrl-K)">${ico('search')}</button>
  <button id="cmt" class="ico" hidden title="comments from other ships" aria-label="comments from other ships">${ico('comment')}</button>
  <!-- a save that replaced an edit from elsewhere keeps the losing body as a
       conflicts/ page. Those are invisible unless you already know to look,
       which is the one failure a conflict design must not have. This badge
       counts them and opens the resolve pane. -->
  <button id="cflt" class="ico" title="sync conflicts to resolve" aria-label="sync conflicts to resolve" hidden>&#9873;</button>
  <button id="aclt" class="ico" hidden title="access control &mdash; groups, sharing, banned ships" aria-label="access control &mdash; groups, sharing, banned ships">${ico('key')}</button>
  <!-- edit | split | preview is ONE three-way choice, not two toggles: an
       editor-less, preview-less layout is not a layout. State and handlers
       in 85-layout.js; the desktop View menu clicks these very buttons. -->
  <span id="viewseg" hidden role="group" aria-label="editor layout">
    <button id="viewedit" class="ico" title="editor only">edit</button>
    <button id="viewsplit" class="ico" title="editor and preview">split</button>
    <button id="viewprev" class="ico" title="preview only">preview</button>
  </span>
</header>`;
      pname = $('pname'); pkind = $('pkind');
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
