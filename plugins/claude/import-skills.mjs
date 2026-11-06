#!/usr/bin/env node
// Bring existing Claude Code skills into lattice's skill store, once.
//
//   LATTICE_URL=https://ship.example.com LATTICE_KEY=<key> node import-skills.mjs [--yes] [dir ...]
//
// With no dirs it reads <config dir>/skills ($CLAUDE_CONFIG_DIR, else
// ~/.claude) and every installed plugin's
// skills (~/.claude/plugins/cache/*/*/*/skills, newest version of each
// plugin). Each <dir>/<name>/SKILL.md becomes a lattice skill, with its md,
// txt, json and yaml files. Anything else (scripts, binaries) is left out
// and listed, since a skill on the ship is text only. A skill the ship
// already has is listed as a duplicate to merge by hand, never
// overwritten. Directories the plugin's own mirror wrote
// (.lattice-skill.json) came from the ship and are skipped.
//
// Without --yes it only says what it would do. The key needs skills
// write, and every skill it saves is signed with the key's name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, nameOk, pathOk, claudeHome } from './hooks/skills-sync.mjs';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const dirs = args.filter((a) => !a.startsWith('--'));
const base = (process.env.LATTICE_URL || '').replace(/\/$/, '') + '/apps/lattice/';
const key = process.env.LATTICE_KEY || '';
if (!process.env.LATTICE_URL || !key) {
  console.error('set LATTICE_URL and LATTICE_KEY (a key with skills write)');
  process.exit(2);
}

async function call(method, route, params, body) {
  const r = await fetch(base + route + '?' + new URLSearchParams(params), {
    method, headers: { authorization: `Bearer ${key}` }, body,
  });
  const t = await r.text();
  return { status: r.status, text: t };
}

function pluginSkillDirs() {
  const cache = path.join(claudeHome(), 'plugins/cache');
  const out = [];
  for (const mk of safeList(cache)) {
    for (const pl of safeList(path.join(cache, mk))) {
      // the newest installed version only
      const vs = safeList(path.join(cache, mk, pl)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!vs.length) continue;
      const d = path.join(cache, mk, pl, vs[vs.length - 1], 'skills');
      if (fs.existsSync(d)) out.push(d);
    }
  }
  return out;
}
function safeList(d) {
  try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// the front matter name made a lattice name, written into SKILL.md when it
// had none or a different one
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 64).replace(/-+$/, '');
}
function prepare(text, fallback) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { problem: 'no front matter' };
  const lines = m[1].split('\n');
  const nameLine = lines.findIndex((l) => /^name:/.test(l));
  const raw = nameLine >= 0 ? lines[nameLine].slice(5).trim().replace(/^["']|["']$/g, '') : fallback;
  const name = slug(raw);
  if (!nameOk(name)) return { problem: `no usable name (${raw})` };
  if (!lines.some((l) => /^description:/.test(l))) return { problem: 'no description' };
  if (nameLine >= 0) lines[nameLine] = `name: ${name}`; else lines.unshift(`name: ${name}`);
  return { name, body: `---\n${lines.join('\n')}\n---\n${text.slice(m[0].length)}` };
}

const roots = dirs.length ? dirs : [path.join(claudeHome(), 'skills'), ...pluginSkillDirs()];
let saved = 0;
const seen = new Map();
for (const root of roots) {
  for (const d of safeList(root)) {
    const dir = path.join(root, d);
    const where = path.join(root, d);
    if (fs.existsSync(path.join(dir, MARKER))) continue;
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const p = prepare(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), d);
    if (p.problem) { console.log(`skip ${where}: ${p.problem}`); continue; }
    if (seen.has(p.name)) { console.log(`duplicate ${p.name}: ${where} and ${seen.get(p.name)}; merge by hand`); continue; }
    seen.set(p.name, where);
    const files = walk(dir).filter((f) => f !== 'SKILL.md');
    const keep = files.filter(pathOk);
    const left = files.filter((f) => !pathOk(f));
    const have = await call('GET', 'skill', { name: p.name });
    if (have.status === 200) { console.log(`duplicate ${p.name}: the ship has one; merge ${where} by hand`); continue; }
    if (have.status === 403 || have.status === 401) { console.error(`the key was refused (${have.status}): it needs skills write`); process.exit(1); }
    console.log(`${yes ? 'import' : 'would import'} ${p.name} from ${where}${keep.length ? ` with ${keep.join(', ')}` : ''}${left.length ? `; leaving out ${left.join(', ')}` : ''}`);
    if (!yes) continue;
    const r = await call('POST', 'skill-save', { name: p.name }, p.body);
    if (r.status !== 200) { console.log(`  refused: ${r.status} ${r.text}`); continue; }
    for (const f of keep) {
      const fr = await call('POST', 'skill-save', { name: p.name, path: f }, fs.readFileSync(path.join(dir, f), 'utf8'));
      if (fr.status !== 200) console.log(`  ${f} refused: ${fr.status} ${fr.text}`);
    }
    saved++;
  }
}
console.log(yes ? `${saved} skill(s) imported` : 'nothing written: pass --yes to import');
