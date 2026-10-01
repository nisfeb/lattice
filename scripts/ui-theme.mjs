#!/usr/bin/env node
// Unit tests for ui-app/theme.js: Talon's palette derivation (Oklab mixing
// included), which theme and which accent win (Talon's, then lattice's own,
// then a forced light/dark), the %contacts profile colour, and what a ship
// with nothing, or no ship at all, leaves behind. theme.js runs as-is in a vm
// with a stub document and a fake ship behind fetch.
import { readFileSync } from 'fs';
import { createHash, webcrypto } from 'crypto';
import vm from 'vm';

const src = readFileSync(new URL('../code/nex/lattice/ui-app/theme.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  ' + detail));
  if (!ok) fails++;
};

// ship: scry path after /~/scry/ -> JSON body, or any other url -> its bytes
// (absent = 404). offline: every fetch throws. faces: the page fonts added.
async function boot({ ship = {}, cache = {}, offline = false } = {}) {
  const props = {}, asked = [], faces = [];
  const style = {
    setProperty: (k, v) => { props[k] = v; },
    removeProperty: (k) => { delete props[k]; },
    get colorScheme() { return props['color-scheme'] || ''; },
  };
  const localStorage = Object.assign({}, cache);
  const reply = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => body,
    arrayBuffer: async () => body });
  const fetch = async (url) => {
    asked.push(url);
    if (offline) throw new Error('offline');
    const m = /^\/~\/scry\/(.*)\.json$/.exec(url), p = m ? m[1] : url;
    return p in ship ? reply(200, ship[p]) : reply(404);
  };
  vm.runInNewContext(src, {
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    document: { documentElement: { style }, querySelectorAll: () => [], getElementById: () => null,
      fonts: { add: (f) => faces.push(f) } },
    FontFace: class { constructor(family, bytes, d) { Object.assign(this, { family, d }); } async load() { return this; } },
    crypto: webcrypto, localStorage, fetch,
  });
  await new Promise((r) => setTimeout(r, 60));
  return { props, asked, faces, vars: JSON.parse(localStorage.latThemeVars || 'null') };
}

const LAT = 'settings/bucket/lattice/ui-prefs', TAL = 'settings/bucket/talon/ui-prefs', ME = 'contacts/v1/self';
// a %settings bucket as the scry answers it: every entry a JSON string
const bucket = (o) => ({ bucket: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)])) });
// Talon's own dark palette as a custom theme, and a lattice one
const dusk = { id: 'd', name: 'Dusk', dark: true, primary: '#FBBF24', secondary: '#A5B4FC',
  tertiary: '#34D399', background: '#0F0D1A', surface: '#1A1625' };
const moss = { id: 'm', name: 'Moss', dark: false, primary: '#2F6B3A', secondary: '#7A5AF8',
  tertiary: '#0A9A6A', background: '#FAFAF9', surface: '#FFFFFF' };
const talon = (activeId, extra = {}) => bucket(Object.assign({ themes: { themes: [dusk], activeId } }, extra));
const mine = (extra = {}) => bucket(Object.assign({ themes: { themes: [moss], activeId: 'm' } }, extra));

{
  const { props } = await boot({ ship: { [LAT]: mine(), [TAL]: talon('d') } });
  check("Talon's active theme wins by default, grounded on its surface as Talon is", props['--bg'] === '#1a1625', props['--bg']);
  check('a custom theme brings its own dark', props['color-scheme'] === 'dark');
  check('on-colours come from luminance (ink on amber, paper on dusk)',
    props['--on-accent'] === '#1c1917' && props['--text'] === '#fafaf9', props['--on-accent'] + ' ' + props['--text']);
  check('popups take the surface colour', props['--pop'] === '#1a1625');
}
{
  const { props } = await boot({ ship: { [LAT]: mine({ 'use-talon-theme': { enabled: false } }), [TAL]: talon('d') } });
  check("turned off, lattice's own theme applies", props['--accent'] === '#2f6b3a', props['--accent']);
  const { asked } = await boot({ ship: { [LAT]: mine({ 'use-talon-theme': { enabled: false }, 'use-talon-font': { enabled: false } }),
    [TAL]: talon('d') } });
  check("theme and font both turned off: Talon is not even asked", !asked.some((u) => u.includes('/talon/')));
}
{
  const { props } = await boot({ ship: { [LAT]: mine(), [TAL]: talon(null) } });
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
  const { props } = await boot({ ship: { [LAT]: mine(), [TAL]: bucket({ themes: { themes: [broken], activeId: 'd' } }) } });
  check('a theme with a bad colour is skipped, not half-applied', props['--accent'] === '#2f6b3a', props['--accent']);
}
{
  // white toward black by 0.2 in Oklab is L 0.8: 0.512 linear, byte 190.
  // Mixed in sRGB it would be #cccccc.
  const white = Object.assign({}, moss, { primary: '#FFFFFF' });
  const { props } = await boot({ ship: { [LAT]: bucket({ themes: { themes: [white], activeId: 'm' } }) } });
  check('shades mix in Oklab, as Compose does', props['--accent-deep'] === '#bebebe', props['--accent-deep']);
}
{
  const { props } = await boot({ ship: { [LAT]: mine({ accent: { enabled: true, mode: 'Custom', customHex: '#aa3377' } }),
    [TAL]: talon('d', { accent: { enabled: true, mode: 'Custom', customHex: '#336699' } }) } });
  check("Talon's custom accent repaints its theme's primary, over lattice's own",
    props['--accent'] === '#336699' && props['--bg'] === '#1a1625', props['--accent']);
  check("text on an accent is Talon's: white, not paper", props['--on-accent'] === '#ffffff', props['--on-accent']);
}
{
  const { props, asked } = await boot({ ship: { [LAT]: mine(),
    [TAL]: talon('d', { accent: { enabled: true, mode: 'Profile' } }),
    [ME]: { nickname: { type: 'text', value: 'x' }, color: { type: 'tint', value: 'ff.5050' } } } });
  check('a profile accent takes the %contacts colour', props['--accent'] === '#ff5050', props['--accent']);
  check('...asking %contacts once', asked.filter((u) => u.includes('contacts')).length === 1, asked.join());
}
{
  const { props, asked } = await boot({ ship: {
    [LAT]: mine({ accent: { enabled: true, mode: 'Custom', customHex: '#aa3377' } }),
    [TAL]: talon(null, { accent: { mode: 'Custom', customHex: '#336699' } }) } });
  check("Talon's accent left unset is off, so lattice's own applies", props['--accent'] === '#aa3377', props['--accent']);
  check('no accent wants the profile colour: %contacts not asked', !asked.some((u) => u.includes('contacts')), asked.join());
}
{
  const { props } = await boot({ ship: {
    [LAT]: bucket({ accent: { enabled: true, mode: 'Custom', customHex: '#aa3377' }, 'use-talon-theme': { enabled: false } }),
    [TAL]: talon('d', { accent: { enabled: true, mode: 'Custom', customHex: '#336699' } }) } });
  check("turned off, Talon's accent is ignored too", props['--accent'] === '#aa3377', props['--accent']);
  check('an accent over the built-in theme forces nothing else', !props['color-scheme'] && !props['--bg'], JSON.stringify(props));
}
{
  const { props } = await boot({ ship: { [LAT]: mine({ accent: { enabled: true, mode: 'Profile' } }),
    [ME]: { color: { type: 'tint', value: 'zz' } } } });
  check('a profile with no readable colour leaves the theme alone', props['--accent'] === '#2f6b3a', props['--accent']);
}

// ── the six a theme may name instead of deriving ─────────────────────────────
const talonWith = (t) => ({ [LAT]: { bucket: {} }, [TAL]: bucket({ themes: { themes: [t], activeId: t.id } }) });
{
  // today's variables, exactly, for a theme with none of the six (as
  // theme.js drew Dusk before the six). Muted and the pressed accent are
  // mixed in Oklab, as Compose mixes them; the values were checked against a
  // separate Oklab implementation, not read back from this one.
  // Grounded on the surface since Talon is (its background shows only in
  // its theme editor), with its outline and outlineVariant as the borders.
  const want = { 'color-scheme': 'dark', '--bg': '#1a1625', '--text': '#fafaf9', '--muted': '#a3a2a8',
    '--pop': '#1a1625', '--border': '#6a6772', '--border-soft': '#363241',
    '--accent': '#fbbf24', '--on-accent': '#1c1917', '--accent-deep': '#ba8d18',
    '--accent-tint': '#fbbf2438', '--secondary': '#a5b4fc', '--tertiary': '#34d399' };
  const { props } = await boot({ ship: talonWith(dusk) });
  const got = Object.assign({}, props); delete got['--link'];
  check("a theme without the six draws as it did", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  check('a custom theme without a link colour takes the link blue', props['--link'] === '#2962ff', props['--link']);
  check('unnamed raised, error and selection leave the stylesheets their own',
    !('--raised' in props) && !('--error' in props) && !('--selection' in props));
  const blank = Object.assign({}, dusk, { text: '', muted: '', raised: '', error: '', selection: '', link: '' });
  const { props: p2 } = await boot({ ship: talonWith(blank) });
  check('"" is the same as not naming it', JSON.stringify(p2) === JSON.stringify(props), JSON.stringify(p2));
}
{
  const all = Object.assign({}, dusk, { text: '#E0E0FF', muted: '#777799', raised: '#223344',
    error: '#FF5555', selection: '#445566', link: '#88CCFF' });
  const { props } = await boot({ ship: talonWith(all) });
  check('each named colour lands in its variable',
    props['--text'] === '#e0e0ff' && props['--muted'] === '#777799' && props['--raised'] === '#223344'
      && props['--error'] === '#ff5555' && props['--selection'] === '#445566' && props['--link'] === '#88ccff',
    JSON.stringify(props));
  const textOnly = Object.assign({}, dusk, { text: '#E0E0FF' });
  const { props: p2 } = await boot({ ship: talonWith(textOnly) });
  check('muted follows a named text colour', p2['--muted'] === '#9492ac', p2['--muted']);
}
{
  const { props } = await boot({ cache: { latTheme: JSON.stringify({ mode: 'dark' }) } });
  check('the built-in look sets no link colour: the reader keeps its blue, the editor its green', !('--link' in props));
}
{
  // an older lattice rewrote the theme without the six: ours stand; "" clears
  const local = Object.assign({}, moss, { link: '#AA0000', text: '#111111' });
  const arrived = Object.assign({}, moss, { text: '' });
  const cached = { latTheme: JSON.stringify({ mine: { themes: [local], activeId: 'm' }, useTalon: false }) };
  const ship = { [LAT]: { bucket: {
    themes: JSON.stringify({ themes: [arrived], activeId: 'm' }), 'use-talon-theme': JSON.stringify({ enabled: false }) } } };
  const { props } = await boot({ cache: cached, ship });
  check('a colour an older writer dropped is kept', props['--link'] === '#aa0000', props['--link']);
  check('a colour cleared with "" stays cleared', props['--text'] === '#1c1917', props['--text']);
}

{
  // a real theme ("green", on ricsul 2026-10-01) against Talon's own pixels
  // in a screenshot of it: ground #091d25, divider #283940, and the open
  // row #274e32, which is the primary at 0x38 over the ground
  const green = { id: 'g', name: 'green', dark: true, primary: '#90FB60', secondary: '#A5B4FC',
    tertiary: '#34D399', background: '#121E03', surface: '#091D25' };
  const { props } = await boot({ ship: talonWith(green) });
  check("as Talon draws it: the surface for ground, outlineVariant for dividers, the open row's tint",
    props['--bg'] === '#091d25' && props['--border-soft'] === '#283940' && props['--accent-tint'] === '#90fb6038',
    JSON.stringify(props));
}

// ── Talon's font ────────────────────────────────────────────────────────────
const fontFile = new Uint8Array([0, 1, 0, 0, 7, 7, 7]).buffer;   // stands in for a .ttf
const fontId = createHash('sha256').update(Buffer.from(fontFile)).digest('hex');
const fontUrl = (id) => '/grubbery/api/file/talon/fonts/' + id + '.font';
const berkeley = (extra = {}) => Object.assign({ fonts: [{ id: fontId, family: 'Berkeley Mono', weight: 700, italic: false }],
  family: 'Berkeley Mono', removed: [] }, extra);
{
  const { props, faces } = await boot({ ship: { [LAT]: { bucket: {} }, [TAL]: bucket({ fonts: berkeley() }), [fontUrl(fontId)]: fontFile } });
  check("Talon's installed font is lattice's, with a fallback", props['--font'] === '"Berkeley Mono", system-ui, sans-serif', props['--font']);
  check('...its file fetched from the ship and made a page font at its weight',
    faces.length === 1 && faces[0].family === 'Berkeley Mono' && faces[0].d.weight === '700', JSON.stringify(faces));
}
{
  const bad = 'f'.repeat(64);
  const { props, faces } = await boot({ ship: { [LAT]: { bucket: {} },
    [TAL]: bucket({ fonts: berkeley({ fonts: [{ id: bad, family: 'Berkeley Mono', weight: 700 }] }) }), [fontUrl(bad)]: fontFile } });
  check("a file that is not the one listed (its sha256 is not its id) is not used",
    faces.length === 0 && props['--font'].startsWith('"Berkeley Mono"'), JSON.stringify(faces));
}
{
  const { props, asked } = await boot({ ship: { [LAT]: { bucket: {} }, [TAL]: bucket({ fonts: { fonts: [], family: 'monospace' } }) } });
  check("Talon's monospace is the generic stack, and no file is asked for",
    props['--font'] === 'ui-monospace, Menlo, Consolas, monospace' && !asked.some((u) => u.includes('/fonts/')), props['--font']);
}
{
  const { props } = await boot({ ship: { [LAT]: { bucket: {} }, [TAL]: bucket({ fonts: { fonts: [], family: null } }) } });
  check("Talon on the system's font sets nothing", !('--font' in props), JSON.stringify(props));
}
{
  const { props, faces, asked } = await boot({ ship: { [LAT]: bucket({ 'use-talon-font': { enabled: false } }),
    [TAL]: bucket({ fonts: berkeley() }), [fontUrl(fontId)]: fontFile } });
  check("turned off, Talon's font is ignored and no file fetched",
    !('--font' in props) && faces.length === 0 && !asked.some((u) => u.includes('/fonts/')), JSON.stringify(props));
}
{
  const { props } = await boot({ ship: { [LAT]: bucket({ 'use-talon-theme': { enabled: false } }),
    [TAL]: talon('d', { fonts: berkeley() }), [fontUrl(fontId)]: fontFile } });
  check("the font is its own setting: Talon's theme off, its font still followed",
    props['--font'] === '"Berkeley Mono", system-ui, sans-serif' && !props['--bg'], JSON.stringify(props));
}
{
  const { faces } = await boot({ ship: { [LAT]: { bucket: {} }, [TAL]: bucket({ fonts: berkeley({ removed: [fontId] }) }),
    [fontUrl(fontId)]: fontFile } });
  check('a file Talon says was removed is not fetched', faces.length === 0, JSON.stringify(faces));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
