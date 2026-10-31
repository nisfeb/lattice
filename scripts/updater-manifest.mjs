#!/usr/bin/env node
//  updater-manifest.mjs — write the desktop self-updater's latest.json.
//
//    node scripts/updater-manifest.mjs <version> <base-url> <notes-file> <file.sig>...
//
//  Each .sig is the minisign signature tauri wrote beside an updater
//  artifact, and its name minus ".sig" is that artifact's asset name, found
//  at <base-url>/<name>. release.yml points base-url at the tag's download
//  path. The local update test points it at a plain http server.
//
//  Only the bundles that replace themselves are listed: the AppImage and the
//  macOS .app.tar.gz. A .deb .sig is skipped. The app shows a .deb install
//  the release page instead (desktop/src/update.rs).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [version, base, notesFile, ...sigs] = process.argv.slice(2);
if (!version || !base || !notesFile || !sigs.length) {
  console.error('usage: updater-manifest.mjs <version> <base-url> <notes-file> <file.sig>...');
  process.exit(2);
}

//  {os}-{arch} is what an updater with no bundle type looks up, and
//  {os}-{arch}-{bundle} what one that knows its bundle looks up first
function platformOf(name) {
  if (name.endsWith('.AppImage') && /amd64|x86_64/.test(name)) return ['linux-x86_64', 'appimage'];
  if (name.endsWith('.app.tar.gz')) {
    if (/aarch64|arm64/.test(name)) return ['darwin-aarch64', 'app'];
    if (/x64|x86_64/.test(name)) return ['darwin-x86_64', 'app'];
  }
  return null;
}

const platforms = {};
for (const sig of sigs) {
  const name = basename(sig).replace(/\.sig$/, '');
  const p = platformOf(name);
  if (!p) {
    console.error(`skipping ${name}: not a self-updating bundle`);
    continue;
  }
  const entry = {
    signature: readFileSync(sig, 'utf8').trim(),
    url: `${base.replace(/\/$/, '')}/${encodeURIComponent(name)}`,
  };
  if (platforms[p[0]]) {
    console.error(`two artifacts for ${p[0]}: ${name}`);
    process.exit(1);
  }
  platforms[p[0]] = entry;
  platforms[`${p[0]}-${p[1]}`] = entry;
}
if (!Object.keys(platforms).length) {
  console.error('no updater artifacts among the signatures');
  process.exit(1);
}

const notes = readFileSync(notesFile, 'utf8').trim();
process.stdout.write(JSON.stringify({
  version: version.replace(/^v/, ''),
  notes,
  pub_date: new Date().toISOString(),
  platforms,
}, null, 2) + '\n');
