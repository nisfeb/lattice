// Mirror the ship's skills (GET /skills) into a skills directory Claude
// Code loads natively, so a skill saved once on the ship triggers like any
// other skill in every session (docs/agent-knowledge.md, Skills).
//
// Where: <claudeHome()>/skills by default ($CLAUDE_CONFIG_DIR/skills, else ~/.claude/skills). Claude Code watches it and picks up
// added, changed and removed skills without a restart. A plugin's own
// skills/ dir would namespace them (/lattice:name), but it is the
// installed plugin's copy and is replaced on every update, so it is not
// ours to write.
//
// Ownership: every directory this writes holds a .lattice-skill.json
// marker naming the files it wrote. A directory without one is the user's
// own skill and is never touched, even when a ship skill has its name. A
// marked directory whose skill is gone from the ship (deleted, superseded,
// or now sensitive) has its files removed, and the directory too once it
// is empty. Sensitive skills are never written to disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKER = '.lattice-skill.json';

// Claude Code's config dir: CLAUDE_CONFIG_DIR when set (a second account,
// or a harness such as reins that gives each account its own), else
// ~/.claude. Its skills/ is where Claude Code looks for user skills.
export function claudeHome(env = process.env) {
  const d = (env.CLAUDE_CONFIG_DIR || '').trim();
  return d ? path.resolve(d.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), '.claude');
}
const NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;
const SEG = /^[A-Za-z0-9._-]+$/;
const EXT = /\.(md|txt|json|ya?ml)$/i;

export function nameOk(n) { return typeof n === 'string' && n.length <= 64 && NAME.test(n); }
export function pathOk(p) {
  if (typeof p !== 'string' || !p || p.length > 200 || !EXT.test(p)) return false;
  return p.split('/').every((s) => SEG.test(s) && s !== '.' && s !== '..');
}

function readMarker(dir) {
  try {
    const st = fs.lstatSync(path.join(dir, MARKER));
    if (!st.isFile()) return null;
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
  } catch { return null; }
}

// rel under dir, or null when it climbs out or a directory on the way is
// a link. A user who swaps a skill's references/ for a link to their own
// notes would otherwise have the mirror write and delete there.
function inside(dir, rel) {
  const target = path.resolve(dir, rel);
  if (!target.startsWith(dir + path.sep)) return null;
  let p = dir;
  for (const seg of path.relative(dir, path.dirname(target)).split(path.sep).filter(Boolean)) {
    p = path.join(p, seg);
    try { if (fs.lstatSync(p).isSymbolicLink()) return null; } catch { break; }
  }
  return target;
}

// a file inside dir, never through a link and never outside it; false
// when refused
function writeInside(dir, rel, text) {
  const target = inside(dir, rel);
  if (!target) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (inside(dir, rel) !== target) return false;
  try { if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target); } catch {}
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return true;
}

function removeOwned(dir, mark) {
  for (const rel of [...(mark.files || []), MARKER]) {
    if (rel !== MARKER && !pathOk(rel)) continue;
    const f = inside(dir, rel);
    try { if (f && !fs.lstatSync(f).isDirectory()) fs.rmSync(f); } catch {}
  }
  pruneEmpty(dir);
}

// empty directories under dir, deepest first, then dir itself when it is
// empty too. A directory holding anything (a file the user added) stays.
function pruneEmpty(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
  }
  try { fs.rmdirSync(dir); } catch {}
}

// get(route, args) answers the route's text or throws with .status.
// Returns what changed, for a one-line note.
export async function syncSkills({ get, root, ship }) {
  const index = JSON.parse(await get('skills', {})).skills || [];
  const want = new Map();
  for (const s of index) {
    if (!nameOk(s.name) || s.sensitive || s.superseded_by) continue;
    want.set(s.name, s);
  }
  fs.mkdirSync(root, { recursive: true });
  const out = { added: [], updated: [], removed: [], skipped: [] };
  // ours that the ship no longer has
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    const mark = readMarker(dir);
    // a marker naming another directory was copied there with the files:
    // the user's fork of a mirrored skill, not ours to remove
    if (!mark || mark.ship !== ship || mark.name !== ent.name) continue;
    if (!want.has(ent.name)) { removeOwned(dir, mark); out.removed.push(ent.name); }
  }
  for (const [name, s] of want) {
    const dir = path.join(root, name);
    let mark = null;
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      mark = st.isDirectory() && !st.isSymbolicLink() ? readMarker(dir) : null;
      // the user's own skill, or another ship's: leave it be
      if (!mark || mark.ship !== ship || mark.name !== name) { out.skipped.push(name); continue; }
      if (mark.updated === s.updated) continue;
    }
    const full = JSON.parse(await get('skill', { name }));
    const files = [['SKILL.md', full.body]];
    for (const f of full.files || []) {
      if (!pathOk(f.path)) continue;
      files.push([f.path, JSON.parse(await get('skill-file', { name, path: f.path })).body]);
    }
    fs.mkdirSync(dir, { recursive: true });
    const wrote = files.filter(([rel, text]) => writeInside(dir, rel, text));
    // files an earlier version had and this one does not
    if (mark) {
      const now = new Set(files.map(([p]) => p));
      for (const rel of mark.files || []) {
        if (now.has(rel) || !pathOk(rel)) continue;
        const f = inside(dir, rel);
        if (f) try { fs.rmSync(f); } catch {}
      }
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) pruneEmpty(path.join(dir, e.name));
      }
    }
    writeInside(dir, MARKER, JSON.stringify({ ship, name, updated: full.updated, files: wrote.map(([p]) => p) }, null, 1) + '\n');
    (mark ? out.updated : out.added).push(name);
  }
  return out;
}
