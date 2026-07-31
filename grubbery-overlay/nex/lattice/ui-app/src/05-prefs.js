  // ── typography preferences ───────────────────────────────────────────────
  // Set on the settings page, stored in localStorage, applied here. Two vars
  // only (--ed-font, --ed-size), because #src and #hl must keep byte-identical
  // metrics — see the note beside them in index.html.
  //
  // Costs ZERO requests: preferences are a client concern, so they never touch
  // the pier. This file sorts first so the editor paints in the chosen font
  // rather than flashing the default and re-laying out.
  const FONTS = {
    mono: 'ui-monospace, Menlo, Consolas, monospace',
    system: 'system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    humanist: '"Iosevka", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
  };
  function applyPrefs() {
    const r = document.documentElement.style;
    let f = null, s = null;
    try { f = localStorage.latFont; s = localStorage.latFontSize; } catch {}
    // an unknown key must fall back rather than write `undefined` into CSS
    if (f && FONTS[f]) r.setProperty('--ed-font', FONTS[f]);
    else r.removeProperty('--ed-font');
    const n = parseInt(s, 10);
    if (n >= 9 && n <= 32) r.setProperty('--ed-size', n + 'px');
    else r.removeProperty('--ed-size');
  }
  applyPrefs();
  // the settings page is a SEPARATE document on the same origin, so its writes
  // reach an open editor through the storage event — no reload, no polling.
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === 'latFont' || e.key === 'latFontSize') applyPrefs();
  });
