  // ── top bar + mobile tabs: <lat-bar>, <lat-tabs> ─────────────────────────
  // The shell frame (13-frame.js) took the bar's job on desktop: the corner
  // toggles, the status line and its spinner live there now, and this bar
  // shows only at phone width. Its other controls stay in the DOM, hidden,
  // until later steps give each one its home, because handlers and the
  // desktop menu still find them by id. Home, comments, conflicts and
  // access are the ribbon's now (24-tools.js).
  customElements.define('lat-bar', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<header class="bar">
  <!-- the icon-only controls carry aria-labels: their glyph is their whole
       text content, which is no accessible name at all -->
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
