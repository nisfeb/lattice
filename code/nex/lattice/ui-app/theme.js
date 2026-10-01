/* Lattice theming, the same model as Talon's (composeApp ui/theme/*.kt):
 *   - a per-device mode: system, light or dark
 *   - user-made themes: five colours picked, everything else derived, and
 *     six more a theme may set instead of having them derived (MORE: text,
 *     muted, raised, error, selection, link; "" or absent is derived). They
 *     live in the ship's %settings (desk lattice, bucket ui-prefs, entry
 *     themes, Talon's exact shape), so they follow the user to every device
 *   - an accent, as Talon's: off, the %contacts profile colour, or any
 *     colour, laid over whichever theme is in use (entry accent)
 *   - "use Talon's theme", on unless turned off: Talon's active custom theme
 *     and its accent, read from its own %settings bucket, win over lattice's
 *     wherever Talon has one.
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
  const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const toByte = (v) => Math.min(255, Math.max(0, 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  // Compose's lerp(Color, Color, Float) mixes in Oklab, so the derived
  // shades come out as Talon's do (Björn Ottosson's matrices)
  const oklab = (c) => {
    const [r, g, b] = c.map(toLin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  const fromOklab = ([L, A, B]) => {
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(toByte);
  };
  const lerp = (a, b, t) => { const x = oklab(a), y = oklab(b); return fromOklab(x.map((v, i) => v + (y[i] - v) * t)); };
  // Compose's Color.luminance(): linear sRGB, Rec. 709 weights
  const lum = (c) => { const [r, g, b] = c.map(toLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const INK = [0x1c, 0x19, 0x17], PAPER = [0xfa, 0xfa, 0xf9];
  const on = (c) => (lum(c) > 0.4 ? INK : PAPER);
  const valid = (t) => !!t && String(t.name || '').trim() !== '' && FIVE.every((k) => hex6(t[k]));
  // the six a theme may set instead of having them derived, Talon's names.
  // Writers write all six, "" for derived, so an absent one means an older
  // writer dropped it (see keepMore)
  const MORE = ['text', 'muted', 'raised', 'error', 'selection', 'link'];
  // links under a custom theme: Talon's link blue, unless the theme says
  const LINK = '#2962ff';
  // the inline properties a theme may set on <html>; each stylesheet reads
  // them as var(--x, <its own colour>), so an unset one changes nothing
  const KEYS = ['color-scheme', '--bg', '--text', '--muted', '--pop', '--accent', '--accent-deep',
    '--on-accent', '--accent-tint', '--secondary', '--tertiary', '--link', '--raised', '--error', '--selection',
    '--border', '--border-soft'];
  // Talon's highlight on the open row: the primary at 22% (DmListScreen)
  const TINT = '38';
  // Talon draws its screens in the SURFACE colour, and popups too; its
  // background only shows in its own theme editor. So the ground here is
  // the surface, with Talon's onSurface, onSurfaceVariant, outline and
  // outlineVariant on it.
  function themeVars(t) {
    const p = rgb(t.primary), sf = rgb(t.surface);
    const text = hex6(t.text) ? rgb(t.text) : on(sf);
    const v = {
      'color-scheme': t.dark ? 'dark' : 'light',
      '--bg': css(sf), '--text': css(text), '--muted': css(hex6(t.muted) ? rgb(t.muted) : lerp(text, sf, 0.35)),
      '--pop': css(sf),
      '--border': css(lerp(sf, text, 0.4)), '--border-soft': css(lerp(sf, text, 0.15)),
      '--accent': css(p), '--on-accent': css(on(p)),
      '--accent-deep': css(lerp(p, [0, 0, 0], 0.2)), '--accent-tint': css(p) + TINT,
      '--secondary': css(rgb(t.secondary)), '--tertiary': css(rgb(t.tertiary)),
      '--link': hex6(t.link) ? css(rgb(t.link)) : LINK,
    };
    // the rest only when named: unset, each stylesheet keeps its own
    for (const k of ['raised', 'error', 'selection']) if (hex6(t[k])) v['--' + k] = css(rgb(t[k]));
    return v;
  }
  // A theme the ship sends back with one of MORE missing was rewritten by an
  // older writer that did not know it: keep ours. "" is a real answer.
  function keepMore(arrived, local) {
    const ours = new Map(((local && local.themes) || []).map((t) => [t.id, t]));
    ((arrived && arrived.themes) || []).forEach((t) => {
      const o = ours.get(t.id);
      if (o) MORE.forEach((k) => { if (!(k in t) && k in o) t[k] = o[k]; });
    });
    return arrived;
  }
  // Talon's accentOverride: the primary colour and the text on it (ink or
  // white, by its own threshold). A tint and a pressed shade follow it.
  const tinted = (v, a) => Object.assign({}, v, {
    '--accent': css(a), '--on-accent': lum(a) > 0.5 ? '#1c1917' : '#ffffff',
    '--accent-deep': css(lerp(a, [0, 0, 0], 0.2)), '--accent-tint': css(a) + TINT,
  });
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
  // mine/talon are Talon's ThemeSettings shape: { themes: [...], activeId };
  // accent/talonAccent its AccentSettings: { enabled, mode, customHex };
  // profile the %contacts profile colour, when an accent asked for it
  const DEFAULTS = { mode: 'system', mine: {}, accent: {}, useTalon: true, talon: null,
    talonAccent: null, profile: null, at: 0 };
  const load = () => { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.latTheme || '{}')); } catch { return Object.assign({}, DEFAULTS); } };
  let st = load();
  const activeOf = (ts) => (ts && Array.isArray(ts.themes) && ts.themes.find((t) => t.id === ts.activeId && valid(t))) || null;
  const talonActive = () => (st.useTalon ? activeOf(st.talon) : null);
  // an accent's colour, when it is on and has one. Unset reads as off: Talon
  // turns it on by itself only for a multi-ship login, which we cannot see.
  // An unknown mode reads as Profile, as Talon reads it.
  const wantsProfile = (a) => !!a && a.enabled === true && a.mode !== 'Custom' && a.mode !== 'Brand';
  const accentOf = (a) => {
    if (!a || a.enabled !== true || a.mode === 'Brand') return null;
    const h = a.mode === 'Custom' ? a.customHex : st.profile;
    return hex6(h) ? rgb(h) : null;
  };
  const talonAccent = () => (st.useTalon ? accentOf(st.talonAccent) : null);
  function resolve() {
    const t = talonActive() || activeOf(st.mine);
    const v = t ? themeVars(t) : FORCED[st.mode] || {};
    const a = talonAccent() || accentOf(st.accent);
    return a ? tinted(v, a) : v;
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
  // what the page last drew with: the head line's paint, from the cache. A
  // change is announced, so the editor can repaint its preview frame, which
  // is its own document and keeps the colours it was written with.
  let shown = (() => { try { return JSON.stringify(JSON.parse(localStorage.latThemeVars || '{}')); } catch { return '{}'; } })();
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
    const sig = JSON.stringify(v);
    if (sig !== shown) {
      shown = sig;
      try { window.dispatchEvent(new Event('lattheme')); } catch {}
    }
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
    const r = await fetch('/~/scry/' + p + '.json');
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
      const b = ((await scry('settings/bucket/lattice/ui-prefs')) || {}).bucket || {};
      next.mine = keepMore(unwrap(b.themes) || {}, st.mine);
      next.accent = unwrap(b.accent) || {};
      next.useTalon = (unwrap(b['use-talon-theme']) || {}).enabled !== false;
    } catch { return; }
    next.talon = st.talon; next.talonAccent = st.talonAccent;
    if (next.useTalon) {
      try {
        const b = ((await scry('settings/bucket/talon/ui-prefs')) || {}).bucket || {};
        next.talon = unwrap(b.themes) || null;
        next.talonAccent = unwrap(b.accent) || null;
      } catch {}
    }
    // %contacts, v1: { color: { type: 'tint', value: 'ff.5050' } }. Asked
    // only when an accent wants it; a %contacts that cannot answer leaves the
    // last colour we had.
    next.profile = st.profile;
    if ((next.useTalon && wantsProfile(next.talonAccent)) || wantsProfile(next.accent)) {
      try {
        const c = ((await scry('contacts/v1/self')) || {}).color;
        const h = String((c && typeof c === 'object' ? c.value : c) || '').replace(/^(0x|#)/i, '').replace(/\./g, '');
        next.profile = /^[0-9a-f]{1,6}$/i.test(h) ? '#' + h.padStart(6, '0') : null;
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
    let draft = null, moreOpen = false;
    const sty = document.createElement('style');
    sty.textContent = '.btn.on{border-color:var(--accent,#1a6ed8);color:var(--accent,#1a6ed8)}'
      + '.thed input:not([type]){font:inherit;padding:6px 9px;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}'
      + '.thed input[type=color]{width:2.2em;height:1.8em;padding:0;border:1px solid #8886;border-radius:6px;background:none;vertical-align:middle;cursor:pointer}'
      + '.thdemo{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px;margin:.4rem 0;border:1px solid #8886;border-radius:8px}'
      + '.thdemo span{padding:4px 10px;border-radius:6px}.thdemo span:first-child{border:1px solid #8886}'
      + '.thdemo ::selection{background:var(--selection,Highlight)}.thed summary{cursor:pointer;margin:.4rem 0}'
      + '.thwell{width:2.6em;height:2.2em;padding:0;border:1px solid #8886;border-radius:6px;background:none;vertical-align:middle;cursor:pointer}';
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
          draft = Object.assign({ id: Math.random().toString(36).slice(2), name: '', dark: d }, SEED, { background: bg, surface: sf },
            Object.fromEntries(MORE.map((k) => [k, ''])));
          draw();
        }),
        ...(cur ? [btn('Edit', () => { draft = Object.assign({}, cur); draw(); }),
          btn('Delete', () => setMine({ themes: themes.filter((t) => t.id !== cur.id), activeId: null }))] : [])));
      if (draft) el.append(editor());
      el.append(...accentSection());
      if (status) { const s = note(status); s.className = 'err'; el.append(s); }
    };
    // Talon's accent: off, the profile colour, or any colour. A pick in the
    // colour well paints as it moves and reaches the ship once it settles.
    // mid-drag only repaints: a redraw would take the well, and the open
    // picker with it, out from under the pointer
    const setAccent = (a, send = true) => {
      st.accent = a;
      if (!send) { apply(resolve()); return; }
      commit();
      put('accent', a).then(() => { if (wantsProfile(a)) refresh(); });
    };
    function accentSection() {
      const a = st.accent || {}, lit = a.enabled === true && a.mode !== 'Brand';
      const how = !lit ? 'off' : a.mode === 'Custom' ? 'custom' : 'profile';
      const hex = hex6(a.customHex) ? '#' + hex6(a.customHex).toLowerCase() : '#4a7c59';
      const custom = (h) => ({ enabled: true, mode: 'Custom', customHex: h.toUpperCase() });
      const well = document.createElement('input');
      well.type = 'color'; well.value = hex; well.className = 'thwell';
      well.oninput = () => setAccent(custom(well.value), false);
      well.onchange = () => setAccent(custom(well.value));
      const out = [note('An accent: one colour over whichever theme is in use, as in Talon.'),
        row(btn('Off', () => setAccent({ enabled: false, mode: a.mode || 'Profile', customHex: a.customHex }), how === 'off'),
          btn('Profile colour', () => setAccent({ enabled: true, mode: 'Profile', customHex: a.customHex }), how === 'profile'),
          btn('Custom', () => setAccent(custom(hex)), how === 'custom'),
          ...(how === 'custom' ? [well] : []))];
      if (how === 'profile') {
        out.push(note(st.profile ? 'Your %contacts profile colour is ' + st.profile + '.' : 'Your %contacts profile has no colour.'));
      }
      if (talonAccent()) out.push(note('Talon’s accent is on, so lattice wears it. Turn off “Use Talon’s theme” to use this one.'));
      return out;
    }
    function editor() {
      const box = document.createElement('div');
      box.className = 'thed';
      const name = document.createElement('input');
      name.placeholder = 'Theme name'; name.value = draft.name;
      const save = btn('Save and use', () => {
        const others = (Array.isArray(st.mine.themes) ? st.mine.themes : []).filter((t) => t.id !== draft.id);
        const d = draft; draft = null;
        MORE.forEach((k) => { d[k] = hex6(d[k]) ? '#' + hex6(d[k]).toUpperCase() : ''; });
        setMine({ themes: others.concat(d), activeId: d.id });
      });
      const sync = () => {
        save.disabled = !valid(draft);
        const v = themeVars(draft);
        // Talon's editor preview: the background, with a card of surface on it
        const bg = rgb(draft.background);
        Object.assign(demo.style, { background: css(bg), colorScheme: v['color-scheme'],
          color: hex6(draft.text) ? css(rgb(draft.text)) : css(on(bg)) });
        Object.assign(pill.style, { background: v['--accent'], color: v['--on-accent'] });
        Object.assign(pop.style, { background: v['--pop'] });
        sec.style.color = v['--secondary']; ter.style.color = v['--tertiary'];
        lnk.style.color = v['--link']; er.style.color = v['--error'] || '#c0392b';
        Object.assign(rz.style, { background: v['--raised'] || '#8881' });
        if (v['--selection']) demo.style.setProperty('--selection', v['--selection']);
        else demo.style.removeProperty('--selection');
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
      // the six Talon lets a theme name instead of deriving: Auto until set
      const LABEL = { text: 'Text', muted: 'Muted text', raised: 'Raised', error: 'Error', selection: 'Selection', link: 'Links' };
      const more = document.createElement('details'), sum = document.createElement('summary');
      sum.textContent = 'More colours';
      more.open = moreOpen || MORE.some((k) => hex6(draft[k]));
      more.ontoggle = () => { moreOpen = more.open; };
      more.append(sum, ...MORE.map((k) => {
        const l = document.createElement('label'), c = document.createElement('input');
        const v = themeVars(draft), shown = { text: v['--text'], muted: v['--muted'], raised: v['--pop'],
          error: '#c0392b', selection: v['--accent'], link: v['--link'] }[k];
        c.type = 'color'; c.value = '#' + (hex6(draft[k]) || hex6(shown)).toLowerCase();
        const auto = btn('Auto', () => { draft[k] = ''; draw(); }, !hex6(draft[k]));
        c.oninput = () => { draft[k] = c.value.toUpperCase(); auto.classList.remove('on'); sync(); };
        l.append(c, ' ' + LABEL[k]);
        return row(l, auto);
      }));
      box.append(more);
      // the same preview Talon's editor shows: ground, a popup, the accents
      const demo = document.createElement('div'), pop = document.createElement('span'),
        pill = document.createElement('span'), sec = document.createElement('span'), ter = document.createElement('span'),
        lnk = document.createElement('a'), er = document.createElement('span'), rz = document.createElement('span');
      demo.className = 'thdemo';
      pop.textContent = 'A menu on a surface.'; pill.textContent = 'Primary';
      sec.textContent = 'Secondary'; ter.textContent = 'Tertiary';
      lnk.textContent = 'A link'; er.textContent = 'An error'; rz.textContent = 'Raised';
      demo.append(pop, pill, sec, ter, lnk, er, rz);
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
  // ponytail: a page load asks the ship at most once a minute, so a theme or
  // accent changed in Talon (or a new profile colour) shows up on the next
  // page after that. The settings page
  // always asks. Live updates would need a %settings subscription.
  if (ui || Date.now() - st.at > 60000) refresh();
})();
