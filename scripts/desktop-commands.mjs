#!/usr/bin/env node
//  desktop-commands.mjs — a Tauri command is registered in THREE places.
//
//  Miss one and the command is denied at runtime with "not allowed. Command
//  not found", which reads like anything except what it is. This has now cost
//  three separate debugging sessions in this repo:
//
//    save_vault / pick_vault   vault export and restore could never have run
//    the seven queue_* ones    the desktop offline queue had never once worked
//    pandoc_probe/convert_tex  told people with pandoc installed they had none
//
//  Nothing caught any of them, because the browser suites stub or skip the
//  bridge and never invoke for real. So this checks the three lists agree:
//
//    1. src/main.rs      generate_handler![..]   the command exists
//    2. build.rs         AppManifest::commands   it may be permitted at all
//    3. capabilities/*   allow-<kebab-case>      someone may actually call it
//
//  Rule 2 is unforgiving in a way worth restating: opting ANY command into the
//  manifest gates them ALL, so an unlisted command is denied everywhere.
//
//  Usage: node scripts/desktop-commands.mjs
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { makeCheck } from './lib/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const D = join(here, '..', 'desktop');

const check = makeCheck();
const kebab = (s) => s.replace(/_/g, '-');

//  1. what the app actually exposes
const main = readFileSync(join(D, 'src', 'main.rs'), 'utf8');
const handler = main.match(/generate_handler!\s*\[([\s\S]*?)\]/);
if (!handler) {
  console.log('  FAIL - could not find generate_handler! in src/main.rs');
  process.exit(1);
}
const handled = [...handler[1].matchAll(/(?:^|\s)(?:[a-z_]+::)?([a-z][a-z0-9_]*)\s*,/g)]
  .map((m) => m[1]);

//  2. what the manifest permits to exist
const build = readFileSync(join(D, 'build.rs'), 'utf8');
const manifest = build.match(/\.commands\(&\[([\s\S]*?)\]\)/);
if (!manifest) {
  console.log('  FAIL - could not find AppManifest commands in build.rs');
  process.exit(1);
}
const declared = [...manifest[1].matchAll(/"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]);

//  3. what any window is allowed to call
const capDir = join(D, 'capabilities');
const granted = new Set();
for (const f of readdirSync(capDir).filter((n) => n.endsWith('.json'))) {
  for (const p of JSON.parse(readFileSync(join(capDir, f), 'utf8')).permissions || []) {
    if (typeof p === 'string' && p.startsWith('allow-')) granted.add(p.slice(6));
  }
}

console.log('handler: %d   manifest: %d   granted: %d\n',
  handled.length, declared.length, granted.size);

//  every exposed command must be in the manifest, or it is denied everywhere
const missingFromManifest = handled.filter((c) => !declared.includes(c));
check('every handled command is in build.rs', missingFromManifest.length === 0,
  'denied everywhere until added to build.rs: ' + JSON.stringify(missingFromManifest));

//  ...and reachable by at least one window, or nothing can call it
const missingGrant = handled.filter((c) => !granted.has(kebab(c)));
check('every handled command is granted to some window', missingGrant.length === 0,
  'no capability grants these: ' + JSON.stringify(missingGrant));

//  the reverse direction is a typo detector: a grant or a manifest entry for a
//  command that does not exist is dead config, and hides a rename
const ghostManifest = declared.filter((c) => !handled.includes(c));
check('build.rs names no command the handler lacks', ghostManifest.length === 0,
  'in build.rs but not handled: ' + JSON.stringify(ghostManifest));

const handledKebab = new Set(handled.map(kebab));
const ghostGrants = [...granted].filter((g) => !handledKebab.has(g));
check('capabilities grant no command the handler lacks', ghostGrants.length === 0,
  'granted but not handled: ' + JSON.stringify(ghostGrants));

//  ── shortcuts click a button in the page ──────────────────────────────
//  keys.rs maps each shortcut id to an element id and clicks it. Rename the
//  button and the key silently does nothing. Every mapping is checked, read
//  straight out of the match, so a new one is checked too.
const keys = readFileSync(join(D, 'src', 'keys.rs'), 'utf8');
const appJs = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'app.js'), 'utf8');
const menu = [...keys.matchAll(/"((?:file|view)-[a-z-]+)" => "([a-z]+)"/g)];
check('the shortcuts map their ids to page elements', menu.length >= 4,
  'found ' + menu.length + ' mappings in src/keys.rs');
for (const [, item, id] of menu) {
  check('shortcut ' + item + ' clicks #' + id + ', which the shipped UI has',
    appJs.includes('id="' + id + '"'));
}

//  Edit and Read are the tab header's two states (23-tabhead.js). Those two
//  call latSetRead instead of clicking a button, and the page must expose it.
for (const [item, arg] of [['view-editor', 'false'], ['view-preview', 'true']]) {
  const m = keys.match(new RegExp('"' + item + '"\\s*=>\\s*Some\\("latSetRead\\(' + arg + '\\)'));
  check('shortcut ' + item + ' calls latSetRead(' + arg + ')', !!m);
}
check('the shipped UI exposes window.latSetRead', appJs.includes('window.latSetRead'));

//  No menubar. Only macOS sets a menu, for WKWebView's Edit items, and the
//  page is no longer told there is a File menu to hide its buttons behind.
check('only macOS builds a menu',
  /#\[cfg\(target_os = "macos"\)\]\s*build_menu\(app\)\?;/.test(main)
  && /#\[cfg\(target_os = "macos"\)\]\s*fn build_menu/.test(main));
const cmdsRs = readFileSync(join(D, 'src', 'commands.rs'), 'utf8');
check('the page is not told to hide its buttons for a File menu',
  !cmdsRs.includes('__LATTICE_FILE_MENU__'));
check('the workspace window gets the shortcuts', cmdsRs.includes('crate::keys::attach(&w)'));
check('the shipped UI exposes window.latOpenManager', appJs.includes('window.latOpenManager'));
check('the shipped UI exposes window.latOpenSettings', appJs.includes('window.latOpenSettings'));

//  The settings page is ship-served, so on the desktop it runs at the
//  bridge origin and only workspace-remote applies to it. Its This computer
//  tabs (settings.js latSettings.desk) call the shell's commands from
//  there, so each one that changes something must put the change to the
//  user in a native dialog first (ship_page_asks in commands.rs), or a page
//  the ship serves could move the app to another ship, mount into a folder
//  of its choosing, or add, pause or remove a backup schedule unseen. The
//  ship-software commands stay off the list: a ship serving the page has
//  its software, and install_grubbery installs from a ship the caller names.
const remote = new Set(JSON.parse(readFileSync(join(capDir, 'workspace-remote.json'), 'utf8'))
  .permissions.filter((p) => typeof p === 'string' && p.startsWith('allow-')).map((p) => p.slice(6)));
const rustSrc = ['commands.rs', 'mounts.rs']
  .map((f) => readFileSync(join(here, '..', 'desktop', 'src', f), 'utf8')).join('\n');
const body = (name) => {
  const i = rustSrc.search(new RegExp('pub (async )?fn ' + name + '\\b'));
  if (i < 0) return '';
  const j = rustSrc.indexOf('\n}\n', i);
  return rustSrc.slice(i, j);
};
const asked = ['connect', 'add_mount', 'set_backup_schedules', 'clear_reader_history', 'set_map_token'];
const unasked = asked.filter((c) => !remote.has(kebab(c)) || !body(c).includes('ship_page_asks('));
check('every change the ship page may make is asked in a native dialog first', unasked.length === 0,
  JSON.stringify(unasked));
const managerOnly = ['stack_status', 'install_grubbery', 'go_home'];
const leaked = managerOnly.filter((c) => remote.has(kebab(c)));
check('the ship-software commands are not granted to the ship page', leaked.length === 0, JSON.stringify(leaked));
const hoon = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'app.hoon'), 'utf8');
const vaultJs = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'vault.js'), 'utf8');
const settingsJs = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'settings.js'), 'utf8');
const shipCalls = new Set([...(vaultJs + hoon + settingsJs).matchAll(/invoke\(\s*["']([a-z_]+)["']/g)]
  .map((m) => m[1]).filter((c) => !managerOnly.includes(c)));
const notRemote = [...shipCalls].filter((c) => !remote.has(kebab(c)));
check('every command the settings page invokes is granted to the ship page',
  shipCalls.has('connection_status') && notRemote.length === 0,
  JSON.stringify({ calls: [...shipCalls], notRemote }));
check('settings-html shows This computer in its own tab, and the manager only on an older shell',
  hoon.includes('latSettings.desk({invoke:t.core.invoke') && hoon.includes('open_manager",{section:s}'));

//  One settings surface: the ship's Settings page and the manager page
//  share ui-app/settings.js, and the manager carries a byte-identical copy
//  (scripts/build-ui.mjs writes it) because it must work with no ship. Each
//  side's tabs name only what the other side accepts: the ship page's
//  "This computer" tabs are open_manager's sections, the manager's
//  "Lattice" tabs are go_home's Settings tabs and the ship page's panels.
const shared = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'settings.js'), 'utf8');
const copy = readFileSync(join(here, '..', 'desktop', 'ui', 'settings.js'), 'utf8');
check('the manager carries the ship\'s settings.js byte for byte (node scripts/build-ui.mjs)', shared === copy);
const manager = readFileSync(join(here, '..', 'desktop', 'ui', 'manager.html'), 'utf8');
const cmds = readFileSync(join(here, '..', 'desktop', 'src', 'commands.rs'), 'utf8');
const list = (name) => [...(cmds.match(new RegExp('const ' + name + ': &\\[&str\\] = &\\[([^\\]]*)\\]')) || ['', ''])[1]
  .matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
const sections = list('MANAGER_SECTIONS'), tabsOk = list('SETTINGS_TABS');
const shipPanels = [...hoon.matchAll(/class=\\"st-panel\\" id=\\"([a-z]+)\\"/g)].map((m) => m[1]);
const mgrGo = [...manager.matchAll(/data-go="([a-z]+)"/g)].map((m) => m[1]);
const deskPanels = [...settingsJs.matchAll(/class="st-panel" id="([a-z]+)"/g)].map((m) => m[1]);
const deskTabs = [...settingsJs.matchAll(/class="st-tab" href="#([a-z]+)"/g)].map((m) => m[1]);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
check('the This computer tabs are their panels and open_manager\'s sections',
  deskPanels.length > 0 && same(deskTabs, deskPanels) && same(deskPanels, sections),
  JSON.stringify({ deskTabs, deskPanels, sections }));
check('the manager\'s Lattice tabs are the ship page\'s panels and go_home\'s tabs',
  mgrGo.length > 0 && same(mgrGo, shipPanels) && same(mgrGo, tabsOk),
  JSON.stringify({ mgrGo, shipPanels, tabsOk }));

check.done();
