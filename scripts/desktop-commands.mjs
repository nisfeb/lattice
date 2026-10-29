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

//  ── native menu items click a button in the page ─────────────────────────
//  main.rs maps each menu id to an element id and clicks it. Rename the
//  button and the menu item silently does nothing. Every mapping is checked,
//  read straight out of the match, so a new item is checked too. (This used
//  to be copied into ui-view and ui-deskmenu, browser suites that need a
//  ship, so in practice it never ran.)
const appJs = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'app.js'), 'utf8');
const menu = [...main.matchAll(/"((?:file|view)-[a-z-]+)" => "([a-z]+)"/g)];
check('the native menu maps its items to page elements', menu.length >= 8,
  'found ' + menu.length + ' mappings in src/main.rs');
for (const [, item, id] of menu) {
  check('menu ' + item + ' clicks #' + id + ', which the shipped UI has',
    appJs.includes('id="' + id + '"'));
}

//  The view menu has no split: Edit and Read are the tab header's two
//  states (23-tabhead.js). Those two items call latSetRead instead of
//  clicking a button, and the page must expose that function.
check('the view menu has no split item', !main.includes('view-split'));
for (const [item, arg] of [['view-editor', 'false'], ['view-preview', 'true']]) {
  const m = main.match(new RegExp('"' + item + '"\\s*=>\\s*\\{?\\s*[^;]*latSetRead\\(' + arg + '\\)'));
  check('menu ' + item + ' calls latSetRead(' + arg + ')', !!m);
}
check('the shipped UI exposes window.latSetRead', appJs.includes('window.latSetRead'));

//  Preferences > scheduled backups lands on the manager page's backups
//  section from any page the window is on, as the Preferences menu always
//  has. On the ship page the page goes first (latOpenManager), so the
//  unsaved-work questions run before the window leaves; elsewhere the menu
//  calls show_manager itself.
check('menu backups names the backups section',
  /"backups"\s*=>\s*Some\(Some\("backups"\)\)/.test(main));
check('menu Preferences asks the ship page first, via latOpenManager',
  /Some\(w\) if !commands::on_shell_page\(&w\) => \{\s*let _ = w\.eval\(manager_menu_js\(section\)\)/.test(main)
  && /if\(window\.latOpenManager\)window\.latOpenManager\(s\)/.test(main));
check('menu Preferences falls back to show_manager off the ship page',
  /_ => \{\s*commands::show_manager\(app, section\)/.test(main));
check('the shipped UI exposes window.latOpenManager', appJs.includes('window.latOpenManager'));
check('the shipped UI exposes window.latOpenSettings', appJs.includes('window.latOpenSettings'));

//  The settings page is ship-served, so on the desktop it runs at the
//  bridge origin and only workspace-remote applies to it. The schedule
//  commands must stay off that list: with them, anything the ship serves
//  could delete or pause the schedules and wipe the archives with no
//  dialog. They live on the local manager page, which the settings page
//  reaches only through open_manager.
const remote = new Set(JSON.parse(readFileSync(join(capDir, 'workspace-remote.json'), 'utf8'))
  .permissions.filter((p) => typeof p === 'string' && p.startsWith('allow-')).map((p) => p.slice(6)));
const scheduleCmds = ['backup_schedules', 'set_backup_schedules', 'pick_backup_dir', 'run_backup_now', 'verify_backup'];
const leaked = scheduleCmds.filter((c) => remote.has(kebab(c)));
check('no schedule command is granted to the ship page', leaked.length === 0, JSON.stringify(leaked));
const hoon = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'app.hoon'), 'utf8');
const vaultJs = readFileSync(join(here, '..', 'code', 'nex', 'lattice', 'ui-app', 'vault.js'), 'utf8');
const shipCalls = new Set([...(vaultJs + hoon).matchAll(/invoke\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]));
const notRemote = [...shipCalls].filter((c) => !remote.has(kebab(c)));
check('every command the settings page invokes is granted to the ship page',
  shipCalls.has('open_manager') && notRemote.length === 0,
  JSON.stringify({ calls: [...shipCalls], notRemote }));
check('settings-html opens the manager at its backups section',
  hoon.includes('open_manager",{section:"backups"}') && hoon.includes('latOpenManager("backups")'));

check.done();
