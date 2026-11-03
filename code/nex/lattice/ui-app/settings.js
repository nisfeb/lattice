/* Lattice settings: the one look and the one tab model of both settings
 * surfaces.
 *
 *   - the ship's Settings page (+settings-html in app.hoon), served at
 *     /apps/lattice/app/settings.js and loaded by that page alone, so the
 *     editor bundle (app.js) never carries it
 *   - the desktop's manager page (desktop/ui/manager.html), which must work
 *     with no node at all and so cannot load anything from a ship. It gets a
 *     byte-identical copy at desktop/ui/settings.js, written by
 *     scripts/build-ui.mjs and checked by CI, so the two cannot drift.
 *
 * The colours are lattice's theme variables (ui-app/theme.js): --bg, --text,
 * --muted, --accent, --on-accent, --accent-tint, --border, --raised, --error,
 * --font. Each is read as var(--x, fallback), so the untouched default is
 * lattice's own look in light and in dark, and a user's theme, accent or
 * font changes both pages the same way. The manager gets the ship page's
 * resolved variables through the shell (set_theme stores them, status hands
 * them back), since it is another origin and cannot read them itself.
 *
 * Markup: .st holds a nav.st-nav of .st-group blocks (an .st-gh heading and
 * .st-tab links) and an .st-body of section.st-panel blocks, one per tab. A
 * tab with href="#id" shows panel #id. A tab with data-go="name" belongs to
 * the other surface and calls window.stGo(name), which the page defines.
 * Without this script every panel shows, one long page, as before.
 *
 * Any element brought into view by scrollIntoView reveals its panel first,
 * so the editor's latOpenSettings(anchor) (24-tools.js), which scrolls the
 * frame to a section by id, lands on the right tab with no change there. */
(function () {
  'use strict';
  const CSS = [
    ':root{color-scheme:light dark;--bg:#fafafa;--text:#111}',
    '@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--text:#e6e6e6}}',
    'html{background:var(--bg)}',
    'body.st-page{margin:0;color:var(--text);background:var(--bg);font:16px/1.6 var(--font,system-ui,sans-serif)}',
    'body.st-page main{max-width:64rem}',
    '.st-top{display:flex;justify-content:space-between;align-items:baseline;gap:1rem}',
    '.st-top h1{font-size:1.5rem;margin:.3rem 0 1rem}',
    '.st{display:grid;grid-template-columns:12rem minmax(0,1fr);gap:2rem;align-items:start}',
    '.st-nav{position:sticky;top:1rem;display:flex;flex-direction:column;gap:1.1rem}',
    '.st-group{display:flex;flex-direction:column;gap:2px}',
    '.st-group[hidden]{display:none}',
    '.st-gh{font-size:.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted,#8a8a8a);padding:0 10px 4px}',
    '.st-tab{display:block;padding:6px 10px;border-radius:6px;color:inherit;text-decoration:none;cursor:pointer}',
    '.st-tab:hover{background:var(--raised,#8881)}',
    '.st-tab[aria-current]{background:var(--accent-tint,#1a6ed822);color:var(--accent,#1a6ed8);font-weight:500}',
    '.st-tab[data-go]::after{content:" \\2197";color:var(--muted,#8a8a8a);font-size:.85em}',
    '.st-tab:focus-visible{outline:2px solid var(--accent,#1a6ed8);outline-offset:-2px}',
    '.st-panel>h2:first-child,.st-panel>:first-child>h2:first-child{margin-top:0}',
    '.st-panel h2{font-size:1.15rem;margin:2rem 0 .5rem}',
    '.st-panel[hidden]{display:none}',
    '.st-card{border:1px solid var(--border-soft,#8883);border-radius:8px;padding:14px;background:var(--raised,#8881);margin:.8rem 0}',
    '.st-card h2{margin-top:0}',
    '.st-card p{margin:.3rem 0 .7rem}',
    '.st-card summary{cursor:pointer;color:var(--muted,#8a8a8a)}',
    // the buttons below set display, which would beat the hidden attribute
    ':where(.st,.st-top) [hidden]{display:none!important}',
    ':where(.st,.st-top) :where(button,.btn){font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#8886);border-radius:8px;padding:7px 14px;cursor:pointer;text-decoration:none;display:inline-block;line-height:1.4}',
    ':where(.st,.st-top) :where(button,.btn):hover{border-color:var(--accent,#1a6ed8)}',
    ':where(.st,.st-top) :where(button,.btn):disabled{opacity:.5;cursor:default}',
    ':where(.st) :where(button.primary){background:var(--accent,#1a6ed8);border-color:var(--accent-deep,var(--accent,#1a6ed8));color:var(--on-accent,#fff)}',
    ':where(.st) :where(button.primary):hover{background:var(--accent-deep,var(--accent,#1a6ed8))}',
    ':where(.st) :where(input:not([type=checkbox],[type=radio],[type=range]),select){font:inherit;color:inherit;background:transparent;border:1px solid var(--border,#8886);border-radius:6px;padding:6px 9px;color-scheme:inherit}',
    ':where(.st) :where(input,select):focus{outline:none;border-color:var(--accent,#1a6ed8)}',
    ':where(.st) :where(input[type=checkbox],input[type=range]){accent-color:var(--accent,#1a6ed8)}',
    '.st .muted{color:var(--muted,#8a8a8a)}',
    '.st .err{color:var(--error,#c0392b);white-space:pre-wrap}',
    '.st .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:.4rem 0}',
    '.st .mono{font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
    '.st-list{list-style:none;padding:0;margin:.5rem 0}',
    '.st-list li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--border-soft,#8883);margin:0}',
    '.st-list li>code{flex:1;font-size:.9em}',
    '.st .dot{width:10px;height:10px;border-radius:50%;flex:none;background:var(--muted,#8a8a8a)}',
    '.st .dot.on{background:var(--accent,#1a6ed8)}.st .dot.off{background:#d68910}.st .dot.err{background:var(--error,#c0392b)}',
    '.st .chip{font-size:.78rem;padding:2px 9px;border-radius:999px;border:1px solid var(--border,#8886);color:var(--muted,#8a8a8a)}',
    '.st .chip.running{border-color:var(--accent,#1a6ed8);color:var(--accent,#1a6ed8)}',
    '.st .chip.ok{background:var(--accent,#1a6ed8);border-color:var(--accent,#1a6ed8);color:var(--on-accent,#fff)}',
    '.st .chip.failed{border-color:var(--error,#c0392b);color:var(--error,#c0392b)}',
    '.st pre.cmd{background:var(--raised,#8881);border:1px solid var(--border-soft,#8883);border-radius:8px;padding:10px 12px;overflow-x:auto;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;margin:.5rem 0}',
    '@media(max-width:640px){.st{grid-template-columns:minmax(0,1fr);gap:1rem}',
    '.st-nav{position:static;flex-direction:row;overflow-x:auto;gap:.6rem;padding-bottom:4px;border-bottom:1px solid var(--border-soft,#8883)}',
    '.st-group{flex-direction:row;align-items:center}.st-gh{display:none}.st-tab{white-space:nowrap}}',
  ].join('');
  const style = document.createElement('style');
  style.id = 'st-css';
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  const panels = () => [...document.querySelectorAll('.st-panel')];
  const tabs = () => [...document.querySelectorAll('.st-tab')];
  // show one panel and mark its tab. The address keeps the tab, so a reload
  // or a link (#keys) comes back to it.
  function show(id, keep) {
    const p = document.getElementById(id);
    if (!p || !p.classList.contains('st-panel')) return false;
    for (const q of panels()) q.hidden = q !== p;
    for (const t of tabs()) {
      if (t.getAttribute('href') === '#' + id) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
    if (!keep && location.hash !== '#' + id) {
      try { history.replaceState(history.state, '', '#' + id); } catch {}
    }
    return true;
  }
  // the panel an element sits in, shown
  function reveal(el) {
    const p = el && el.closest && el.closest('.st-panel');
    if (p && p.hidden) show(p.id);
  }
  const into = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) {
    reveal(this);
    return into.apply(this, a);
  };
  function init() {
    if (!document.querySelector('.st')) return;
    document.body.classList.add('st-page');
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.st-tab');
      if (!t) return;
      e.preventDefault();
      const go = t.dataset.go;
      if (go) { if (typeof window.stGo === 'function') window.stGo(go); return; }
      const id = (t.getAttribute('href') || '').slice(1);
      if (show(id)) window.scrollTo(0, 0);
    });
    // the hash names a panel, or an element inside one
    const pick = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      const el = id && document.getElementById(id);
      if (el && el.classList.contains('st-panel')) return show(id, true);
      if (el && el.closest('.st-panel')) { reveal(el); el.scrollIntoView({ block: 'start' }); return true; }
      return false;
    };
    window.addEventListener('hashchange', pick);
    if (!pick()) {
      const first = panels()[0];
      if (first) show(first.id, true);
    }
  }
  window.latSettings = { show };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
