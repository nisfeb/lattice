  // ── knowledge tags panel: <lat-knowtags> ─────────────────────────────────
  // Wiring and rendering live in 95-know.js (they are know-mode logic); this
  // component only owns the markup. 95 runs later, so its $-lookups resolve.
  customElements.define('lat-knowtags', class extends HTMLElement {
    connectedCallback() {
      this.innerHTML = `
<div id="knowmeta" hidden>
  <h3>tags</h3>
  <div id="ktags" class="chips"></div>
  <div class="row"><input id="ktag" placeholder="add tag" autocomplete="off"><button id="ktagadd">tag</button></div>
  <div id="kupd" class="muted"></div>
</div>`;
    }
  });
