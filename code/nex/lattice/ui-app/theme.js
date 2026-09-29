/* Lattice theming, the same model as Talon's (composeApp ui/theme/*.kt):
 *   - a per-device mode: system, light or dark
 *   - user-made themes: five colours picked, everything else derived. They
 *     live in the ship's %settings (desk lattice, bucket ui-prefs, entry
 *     themes, Talon's exact shape), so they follow the user to every device
 *   - "use Talon's theme", on unless turned off: Talon's active custom theme,
 *     read from its own %settings entry, wins over lattice's.
 * A custom theme brings its own light or dark, as it does in Talon.
 *
 * Served standalone at /apps/lattice/app/theme.js and loaded (defer) by every
 * owner document: the editor shell and the reader chrome (+pwa-head). First
 * paint never waits on it. Each <head> inlines one line that applies the last
 * resolved theme from localStorage.latThemeVars, which this file writes.
 * On the settings page it also renders the controls into #themeui. */
(function () {
  'use strict';

  // ── palette: Talon's customScheme, for the roles lattice draws ─────────────
  const FIVE = ['primary', 'secondary', 'tertiary', 'background', 'surface'];
  const hex6 = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim()); return m && m[1]; };
  const rgb = (s) => { const h = hex6(s); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const css = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  // Compose's Color.luminance(): linear sRGB, Rec. 709 weights
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const INK = [0x1c, 0x19, 0x17], PAPER = [0xfa, 0xfa, 0xf9];
  const on = (c) => (lum(c) > 0.4 ? INK : PAPER);
  const valid = (t) => !!t && String(t.name || '').trim() !== '' && FIVE.every((k) => hex6(t[k]));
  // the inline properties a theme may set on <html>; each stylesheet reads
  // them as var(--x, <its own colour>), so an unset one changes nothing
  const KEYS = ['color-scheme', '--bg', '--text', '--muted', '--pop', '--accent', '--accent-deep',
    '--on-accent', '--accent-tint', '--secondary', '--tertiary'];
  function themeVars(t) {
    const p = rgb(t.primary), bg = rgb(t.background), text = on(bg);
    return {
      'color-scheme': t.dark ? 'dark' : 'light',
      '--bg': css(bg), '--text': css(text), '--muted': css(lerp(text, bg, 0.35)),
      // Talon draws every popup in the surface colour; lattice has no cards
      '--pop': css(rgb(t.surface)),
      '--accent': css(p), '--on-accent': css(on(p)),
      '--accent-deep': css(lerp(p, [0, 0, 0], 0.2)), '--accent-tint': css(p) + '22',
      '--secondary': css(rgb(t.secondary)), '--tertiary': css(rgb(t.tertiary)),
    };
  }
  // light or dark forced over the built-in look: ground and ink only, so the
  // editor keeps its green and the reader its blue
  const FORCED = {
    light: { 'color-scheme': 'light', '--bg': '#fafafa', '--text': '#1a1a1a' },
    dark: { 'color-scheme': 'dark', '--bg': '#1a1a1a', '--text': '#e6e6e6' },
  };
  // what a new theme starts from: lattice's own colours
  const SEED = { primary: '#4a7c59', secondary: '#7a5af8', tertiary: '#0a9a6a' };
  const SEED_BG = { false: ['#fafafa', '#ffffff'], true: ['#1a1a1a', '#242424'] };

  // ── state: localStorage.latTheme, a cache of the ship's word plus the mode ─
  // mine/talon are Talon's ThemeSettings shape: { themes: [...], activeId }
  const DEFAULTS = { mode: 'system', mine: {}, useTalon: true, talon: null, at: 0 };
  const load = () => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.latTheme || '{}')); } catch { return Object.assign({}, DEFAULTS); } };
  let st = load();
  const activeOf = (ts) => (ts && Array.isArray(ts.themes) && ts.themes.find((t) => t.id === ts.activeId && valid(t))) || null;
  const talonActive = () => (st.useTalon ? activeOf(st.talon) : null);
  function resolve() {
    const t = talonActive() || activeOf(st.mine);
    return t ? themeVars(t) : FORCED[st.mode] || {};
  }

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => { const cs = document.documentElement.style.colorScheme; return cs ? cs === 'dark' : mq.matches; };
  // The window's native surfaces (the GTK menubar, the engine's own
  // scrollbars) follow the WINDOW theme, which on Linux is GTK's light
  // default whatever the desktop portal says, so a dark page sat under a
  // white menubar. The page is the one that knows which it is, so it tells
  // the desktop shell, now and on every change. Outside the desktop, or on an
  // older shell without the command, nothing happens.
  const tell = () => {
    try { window.__TAURI__.core.invoke('set_theme', { dark: isDark() }).catch(() => {}); } catch {}
  };
  function apply(v) {
    const s = document.documentElement.style;
    KEYS.forEach((k) => s.removeProperty(k));
    for (const k in v) s.setProperty(k, v[k]);
    // the installed app's status bar is painted from these, not from css
    document.querySelectorAll('meta[name=theme-color]').forEach((m) => {
      if (!m.dataset.c) m.dataset.c = m.content;
      m.content = v['--bg'] || m.dataset.c;
    });
    tell();
  }
  function commit() {
    const v = resolve();
    try { localStorage.latTheme = JSON.stringify(st); localStorage.latThemeVars = JSON.stringify(v); } catch {}
    apply(v);
    if (draw) draw();
  }

  // ── %settings, straight through eyre (same origin, the owner's cookie) ────
  // 404 is the ship saying there is nothing; anything else unreadable means
  // we could not ask, and the cached copy stands.
  const unwrap = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; } };
  async function scry(p) {
    const r = await fetch('/~/scry/settings/' + p + '.json');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  let gen = 0;          // bumped by every local edit, so a slower read cannot undo it
  let status = '';
  async function refresh() {
    const g = gen;
    const next = {};
    try {
      const b = ((await scry('bucket/lattice/ui-prefs')) || {}).bucket || {};
      next.mine = unwrap(b.themes) || {};
      next.useTalon = (unwrap(b['use-talon-theme']) || {}).enabled !== false;
    } catch { return; }
    next.talon = st.talon;
    if (next.useTalon) {
      try {
        const e = await scry('entry/talon/ui-prefs/themes');
        next.talon = e ? unwrap(e.entry) : null;
      } catch {}
    }
    if (g !== gen) return;
    Object.assign(st, next, { at: Date.now() });
    commit();
  }
  // Talon's pokePutEntry: a JSON-stringified value, fire and forget. One PUT
  // opens a channel, pokes, and deletes the channel again.
  let ship = null;
  async function put(entry, value) {
    gen++;
    try {
      if (!ship) ship = (await (await fetch('/~/host')).text()).trim().replace(/^~/, '');
      const r = await fetch('/~/channel/lattice-theme-' + Date.now().toString(36) + Math.random().toString(36).slice(2), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { id: 1, action: 'poke', ship, app: 'settings', mark: 'settings-event',
            json: { 'put-entry': { desk: 'lattice', 'bucket-key': 'ui-prefs', 'entry-key': entry, value: JSON.stringify(value) } } },
          { id: 2, action: 'delete' },
        ]),
      });
      if (!r.ok) throw new Error(String(r.status));
      status = '';
    } catch {
      status = 'Could not reach your ship: kept in this browser only.';
    }
    if (draw) draw();
  }

  // ── settings page: #themeui ───────────────────────────────────────────────
  let draw = null;
  function mount(el) {
    let draft = null;
    const sty = document.createElement('style');
    sty.textContent = '.btn.on{border-color:var(--accent,#1a6ed8);color:var(--accent,#1a6ed8)}'
      + '.thed input:not([type]){font:inherit;padding:6px 9px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}'
      + '.thed input[type=color]{width:2.2em;height:1.8em;padding:0;border:1px solid #8886;border-radius:6px;background:none;vertical-align:middle;cursor:pointer}'
      + '.thdemo{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px;margin:.4rem 0;border:1px solid #8886;border-radius:8px}'
      + '.thdemo span{padding:4px 10px;border-radius:6px}.thdemo span:first-child{border:1px solid #8886}';
    document.head.append(sty);
    const btn = (label, onclick, on) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (on ? ' on' : ''); b.textContent = label; b.onclick = onclick;
      return b;
    };
    const row = (...kids) => { const p = document.createElement('p'); p.className = 'bkrow'; p.append(...kids); return p; };
    const note = (text) => { const s = document.createElement('p'); s.className = 'muted'; s.textContent = text; return s; };
    const setMine = (mine) => { st.mine = mine; commit(); put('themes', mine); };
    draw = () => {
      const mine = st.mine || {}, themes = Array.isArray(mine.themes) ? mine.themes.filter(valid) : [];
      const ta = activeOf(st.talon);
      el.textContent = '';
      el.append(note('Light, dark, or whatever your system is set to. This browser only.'));
      el.append(row(...['system', 'light', 'dark'].map((m) =>
        btn(m[0].toUpperCase() + m.slice(1), () => { st.mode = m; commit(); }, st.mode === m))));
      const tl = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = st.useTalon;
      // turned on, go and get Talon's current theme, but only once the ship
      // has the switch: asked sooner, it answers "off" and undoes the click
      cb.onchange = () => {
        st.useTalon = cb.checked; commit();
        put('use-talon-theme', { enabled: cb.checked }).then(() => { if (st.useTalon) refresh(); });
      };
      tl.append(cb, " Use Talon's theme");
      el.append(row(tl));
      el.append(note(!st.useTalon ? 'Talon’s theme is ignored here.'
        : ta ? 'Talon is using “' + ta.name + '”, so lattice is too. Turn this off to use your own.'
          : 'Talon is on its built-in theme, so lattice uses its own below.'));
      el.append(note('Your own themes: pick five colours and the rest is worked out. Saved to your ship, so they follow you to every device.'));
      el.append(row(btn('Built-in', () => setMine(Object.assign({}, mine, { activeId: null })), !activeOf(mine)),
        ...themes.map((t) => btn(t.name, () => setMine(Object.assign({}, mine, { activeId: t.id })), mine.activeId === t.id))));
      const cur = activeOf(mine);
      el.append(row(
        btn('New theme', () => {
          const d = isDark(), [bg, sf] = SEED_BG[d];
          draft = Object.assign({ id: Math.random().toString(36).slice(2), name: '', dark: d }, SEED, { background: bg, surface: sf });
          draw();
        }),
        ...(cur ? [btn('Edit', () => { draft = Object.assign({}, cur); draw(); }),
          btn('Delete', () => setMine({ themes: themes.filter((t) => t.id !== cur.id), activeId: null }))] : [])));
      if (draft) el.append(editor());
      if (status) { const s = note(status); s.className = 'err'; el.append(s); }
    };
    function editor() {
      const box = document.createElement('div');
      box.className = 'thed';
      const name = document.createElement('input');
      name.placeholder = 'Theme name'; name.value = draft.name;
      const save = btn('Save and use', () => {
        const others = (Array.isArray(st.mine.themes) ? st.mine.themes : []).filter((t) => t.id !== draft.id);
        const d = draft; draft = null;
        setMine({ themes: others.concat(d), activeId: d.id });
      });
      const sync = () => {
        save.disabled = !valid(draft);
        const v = themeVars(draft);
        Object.assign(demo.style, { background: v['--bg'], color: v['--text'], colorScheme: v['color-scheme'] });
        Object.assign(pill.style, { background: v['--accent'], color: v['--on-accent'] });
        Object.assign(pop.style, { background: v['--pop'] });
        sec.style.color = v['--secondary']; ter.style.color = v['--tertiary'];
      };
      name.oninput = () => { draft.name = name.value; sync(); };
      box.append(row(name), row(
        btn('Light', () => { draft.dark = false; draw(); }, !draft.dark),
        btn('Dark', () => { draft.dark = true; draw(); }, draft.dark)));
      box.append(row(...FIVE.map((k) => {
        const l = document.createElement('label'), c = document.createElement('input');
        c.type = 'color'; c.value = '#' + hex6(draft[k]).toLowerCase();
        c.oninput = () => { draft[k] = c.value.toUpperCase(); sync(); };
        l.append(c, ' ' + k[0].toUpperCase() + k.slice(1));
        return l;
      })));
      // the same preview Talon's editor shows: ground, a popup, the accents
      const demo = document.createElement('div'), pop = document.createElement('span'),
        pill = document.createElement('span'), sec = document.createElement('span'), ter = document.createElement('span');
      demo.className = 'thdemo';
      pop.textContent = 'A menu on a surface.'; pill.textContent = 'Primary';
      sec.textContent = 'Secondary'; ter.textContent = 'Tertiary';
      demo.append(pop, pill, sec, ter);
      box.append(demo, row(save, btn('Cancel', () => { draft = null; draw(); })));
      sync();
      return box;
    }
    draw();
  }

  apply(resolve());
  mq.addEventListener('change', tell);
  // another tab (the settings page, usually) changed it
  window.addEventListener('storage', (e) => {
    if (e.key !== 'latTheme') return;
    st = load();
    apply(resolve());
    if (draw) draw();
  });
  const ui = document.getElementById('themeui');
  if (ui) mount(ui);
  // ponytail: a page load asks the ship at most once a minute, so a theme
  // changed in Talon shows up on the next page after that. The settings page
  // always asks. Live updates would need a %settings subscription.
  if (ui || Date.now() - st.at > 60000) refresh();
})();
