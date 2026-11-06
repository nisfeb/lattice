#!/usr/bin/env node
//  ui-skills-sync.mjs: the Claude plugin's skill mirror
//  (plugins/claude/hooks/skills-sync.mjs) against a fake ship, into a
//  scratch dir. Pure: no ship. It adds, updates and removes only what it
//  owns, leaves the user's own skills alone, never writes a sensitive or
//  superseded skill, and never writes outside a skill's directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCheck } from './lib/check.mjs';
import { syncSkills, MARKER, claudeHome } from '../plugins/claude/hooks/skills-sync.mjs';

const check = makeCheck();
const scratch = process.env.LATTICE_SCRATCH || path.join(os.homedir(), '.cache/lattice-gate');
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'skills-sync-'));
const SHIP = 'https://ship.example';

let ship = {};
const md = (n, d) => `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}\n`;
const get = async (route, a) => {
  if (route === 'skills') {
    return JSON.stringify({ skills: Object.entries(ship).map(([name, s]) => ({ name, description: 'd', updated: s.updated, sensitive: !!s.sensitive, superseded_by: s.sup || null, files: Object.keys(s.files).length })) });
  }
  const s = ship[a.name];
  if (!s) throw Object.assign(new Error('404'), { status: 404 });
  if (route === 'skill') return JSON.stringify({ name: a.name, body: s.body, updated: s.updated, files: Object.keys(s.files).map((p) => ({ path: p, bytes: 1 })) });
  if (route === 'skill-file') return JSON.stringify({ body: s.files[a.path] });
  throw new Error('route ' + route);
};
const exists = (p) => fs.existsSync(path.join(root, p));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

try {
  //  the user's own skill, with a name the ship also uses
  fs.mkdirSync(path.join(root, 'mine'));
  fs.writeFileSync(path.join(root, 'mine/SKILL.md'), 'my own');
  ship = {
    deploy: { body: md('deploy', 'd'), updated: '~1', files: { 'references/notes.md': 'notes' } },
    mine: { body: md('mine', 'ship copy'), updated: '~1', files: {} },
    secret: { body: md('secret', 'd'), updated: '~1', files: {}, sensitive: true },
    old: { body: md('old', 'd'), updated: '~1', files: {}, sup: 'deploy' },
    climb: { body: md('climb', 'd'), updated: '~1', files: { '../escape.md': 'x', 'a/../../b.md': 'y' } },
  };
  let r = await syncSkills({ get, root, ship: SHIP });
  check('a ship skill is written', exists('deploy/SKILL.md') && read('deploy/SKILL.md').includes('name: deploy'));
  check('  ...with its file', read('deploy/references/notes.md') === 'notes');
  check('  ...and our marker', JSON.parse(read('deploy/' + MARKER)).ship === SHIP);
  check.eq('the user\'s own skill is untouched', read('mine/SKILL.md'), 'my own');
  check('  ...and reported skipped', r.skipped.includes('mine'), JSON.stringify(r));
  check('a sensitive skill is never written', !exists('secret'));
  check('a superseded skill is not written', !exists('old'));
  check('a path that climbs out is not written', !fs.existsSync(path.join(root, '../escape.md')) && !exists('b.md'));
  check('  ...but the skill itself is', exists('climb/SKILL.md'));
  check.eq('added', r.added.sort().join(','), 'climb,deploy');

  r = await syncSkills({ get, root, ship: SHIP });
  check('an unchanged ship changes nothing', !r.added.length && !r.updated.length && !r.removed.length, JSON.stringify(r));

  ship.deploy = { body: md('deploy', 'new'), updated: '~2', files: { 'b.md': 'b' } };
  r = await syncSkills({ get, root, ship: SHIP });
  check('a changed skill is rewritten', read('deploy/SKILL.md').includes('description: new') && r.updated.includes('deploy'));
  check('  ...its dropped file goes', !exists('deploy/references/notes.md'));
  check('  ...its new file comes', read('deploy/b.md') === 'b');

  delete ship.deploy;
  fs.writeFileSync(path.join(root, 'climb/user-note.md'), 'a file I added');
  delete ship.climb;
  r = await syncSkills({ get, root, ship: SHIP });
  check('a skill deleted on the ship is removed', !exists('deploy') && r.removed.includes('deploy'));
  check('a file the user added inside one is kept', read('climb/user-note.md') === 'a file I added');
  check('  ...but ours are gone', !exists('climb/SKILL.md') && !exists('climb/' + MARKER));
  check('the user\'s own skill is still there', read('mine/SKILL.md') === 'my own');
  //  another ship's mirror in the same dir is not ours to remove
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other/' + MARKER), JSON.stringify({ ship: 'https://elsewhere', files: ['SKILL.md'] }));
  fs.writeFileSync(path.join(root, 'other/SKILL.md'), 'theirs');
  await syncSkills({ get, root, ship: SHIP });
  check('another ship\'s mirror is left alone', read('other/SKILL.md') === 'theirs');

  //  the user forks a mirrored skill by copying its directory, marker and
  //  all: the copy is theirs, even once the ship drops the original
  ship = { fork: { body: md('fork', 'd'), updated: '~1', files: {} } };
  await syncSkills({ get, root, ship: SHIP });
  fs.cpSync(path.join(root, 'fork'), path.join(root, 'fork-mine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fork-mine/SKILL.md'), 'my fork');
  delete ship.fork;
  r = await syncSkills({ get, root, ship: SHIP });
  check.eq('a copied mirror under a new name is the user\'s', exists('fork-mine/SKILL.md') && read('fork-mine/SKILL.md'), 'my fork');
  check('  ...and not reported removed', !r.removed.includes('fork-mine'), JSON.stringify(r));

  //  a directory inside a mirrored skill swapped for a link: the mirror
  //  never writes or deletes through it
  const outside = fs.mkdtempSync(path.join(scratch, 'skills-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'notes.md'), 'my notes');
    ship = { linked: { body: md('linked', 'd'), updated: '~1', files: { 'references/notes.md': 'ship notes' } } };
    await syncSkills({ get, root, ship: SHIP });
    fs.rmSync(path.join(root, 'linked/references'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'linked/references'));
    ship.linked = { ...ship.linked, updated: '~2' };
    await syncSkills({ get, root, ship: SHIP });
    check.eq('an update does not write through a linked directory', fs.readFileSync(path.join(outside, 'notes.md'), 'utf8'), 'my notes');
    check('  ...and still writes the rest', read('linked/SKILL.md').includes('name: linked'));
    delete ship.linked;
    await syncSkills({ get, root, ship: SHIP });
    check('a removal does not delete through a linked directory', fs.existsSync(path.join(outside, 'notes.md')));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
// where the mirror goes by default: the config dir Claude Code runs with
// (reins and second accounts set CLAUDE_CONFIG_DIR), else ~/.claude
check('no CLAUDE_CONFIG_DIR is ~/.claude', claudeHome({}) === path.join(os.homedir(), '.claude'));
check('CLAUDE_CONFIG_DIR wins', claudeHome({ CLAUDE_CONFIG_DIR: '/x/acct2' }) === '/x/acct2');
check('  ...with ~ expanded', claudeHome({ CLAUDE_CONFIG_DIR: '~/.claude-acct2' }) === path.join(os.homedir(), '.claude-acct2'));
check('  ...and blank ignored', claudeHome({ CLAUDE_CONFIG_DIR: '  ' }) === path.join(os.homedir(), '.claude'));
check.done();
