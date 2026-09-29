#!/usr/bin/env node
// Unit tests for ui-app/theme.js: Talon's palette derivation, which theme
// wins (Talon's, then lattice's own, then a forced light/dark), and what a
// ship with nothing, or no ship at all, leaves behind. theme.js runs as-is in
// a vm with a stub document and a fake %settings behind fetch.
import { readFileSync } from 'fs';
import vm from 'vm';

const src = readFileSync(new URL('../code/nex/lattice/ui-app/theme.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
};

// ship: scry path -> JSON body (absent = 404). offline: every fetch throws.
async function boot({ ship = {}, cache = {}, offline = false } = {}) {
  const props = {}, asked = [];
  const style = {
    setProperty: (k, v) => { props[k] = v; },
    removeProperty: (k) => { delete props[k]; },
    get colorScheme() { return props['color-scheme'] || ''; },
  };
  const localStorage = Object.assign({}, cache);
  const reply = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => body });
  const fetch = async (url) => {
    asked.push(url);
    if (offline) throw new Error('offline');
    const p = /^\/~\/scry\/settings\/(.*)\.json$/.exec(url)[1];
    return p in ship ? reply(200, ship[p]) : reply(404);
  };
  vm.runInNewContext(src, {
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    document: { documentElement: { style }, querySelectorAll: () => [], getElementById: () => null },
    localStorage, fetch,
  });
  await new Promise((r) => setTimeout(r, 20));
  return { props, asked, vars: JSON.parse(localStorage.latThemeVars || 'null') };
}

// Talon's own dark palette as a custom theme, and a lattice one
const dusk = { id: 'd', name: 'Dusk', dark: true, primary: '#FBBF24', secondary: '#A5B4FC',
  tertiary: '#34D399', background: '#0F0D1A', surface: '#1A1625' };
const moss = { id: 'm', name: 'Moss', dark: false, primary: '#2F6B3A', secondary: '#7A5AF8',
  tertiary: '#0A9A6A', background: '#FAFAF9', surface: '#FFFFFF' };
const talon = (activeId) => ({ entry: JSON.stringify({ themes: [dusk], activeId }) });
const mine = (extra = {}) => ({ bucket: Object.assign({ themes: JSON.stringify({ themes: [moss], activeId: 'm' }) }, extra) });

{
  const { props } = await boot({ ship: { 'bucket/lattice/ui-prefs': mine(), 'entry/talon/ui-prefs/themes': talon('d') } });
  check("Talon's active theme wins by default", props['--bg'] === '#0f0d1a', props['--bg']);
  check('a custom theme brings its own dark', props['color-scheme'] === 'dark');
  check('on-colours come from luminance (ink on amber, paper on dusk)',
    props['--on-accent'] === '#1c1917' && props['--text'] === '#fafaf9', props['--on-accent'] + ' ' + props['--text']);
  check('popups take the surface colour', props['--pop'] === '#1a1625');
}
{
  const { props, asked } = await boot({ ship: {
    'bucket/lattice/ui-prefs': mine({ 'use-talon-theme': JSON.stringify({ enabled: false }) }),
    'entry/talon/ui-prefs/themes': talon('d') } });
  check("turned off, lattice's own theme applies", props['--accent'] === '#2f6b3a', props['--accent']);
  check("turned off, Talon is not even asked", !asked.some((u) => u.includes('/talon/')));
}
{
  const { props } = await boot({ ship: { 'bucket/lattice/ui-prefs': mine(), 'entry/talon/ui-prefs/themes': talon(null) } });
  check("Talon on its built-in theme leaves lattice's own", props['--accent'] === '#2f6b3a', props['--accent']);
}
{
  const { props, vars } = await boot({ cache: { latTheme: JSON.stringify({ mode: 'dark' }) } });
  check('nothing on the ship + dark mode: the built-in dark, forced',
    props['color-scheme'] === 'dark' && props['--bg'] === '#1a1a1a' && !props['--accent'], JSON.stringify(props));
  check('...and cached for the next first paint', vars && vars['--bg'] === '#1a1a1a');
}
{
  const { props } = await boot({ ship: {} });
  check('nothing anywhere: nothing set, the stylesheets decide', Object.keys(props).length === 0, JSON.stringify(props));
}
{
  const cached = { latTheme: JSON.stringify({ mine: { themes: [moss], activeId: 'm' } }) };
  const { props } = await boot({ cache: cached, offline: true });
  check('ship unreachable: the cached theme stands', props['--accent'] === '#2f6b3a', JSON.stringify(props));
  const fresh = { latTheme: JSON.stringify({ mine: {}, at: Date.now() }) };
  const { asked } = await boot({ cache: fresh });
  check('asked less than a minute ago: not asked again', asked.length === 0, asked.join());
}
{
  const broken = Object.assign({}, dusk, { primary: 'amber' });
  const { props } = await boot({ ship: { 'bucket/lattice/ui-prefs': mine(),
    'entry/talon/ui-prefs/themes': { entry: JSON.stringify({ themes: [broken], activeId: 'd' }) } } });
  check('a theme with a bad colour is skipped, not half-applied', props['--accent'] === '#2f6b3a', props['--accent']);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
