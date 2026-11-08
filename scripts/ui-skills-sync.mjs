#!/usr/bin/env node
//  ui-skills-sync.mjs: the Claude plugin's skill mirror
//  (plugins/claude/hooks/skills-sync.mjs) against a fake ship, into a
//  scratch dir. Pure: no ship. It adds, updates and removes only what it
//  owns, leaves the user's own skills alone, never writes a sensitive or
//  superseded skill, and never writes outside a skill's directory. It
//  mirrors only the owner's skills, keys its markers by the ship's @p
//  (taking over an older mirror's URL-keyed ones), keeps a file the user
//  changed or added, and refuses names that clash ignoring case or that
//  Windows reserves. import-skills.mjs is run against a fake ship too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { makeCheck } from './lib/check.mjs';
import { syncSkills, stripGrants, MARKER, claudeHome, pathOk, caseClashes } from '../plugins/claude/hooks/skills-sync.mjs';

const check = makeCheck();
const scratch = process.env.LATTICE_SCRATCH || path.join(os.homedir(), '.cache/lattice-gate');
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'skills-sync-'));
const SHIP = '~zod';
const URL_ = 'https://ship.example';

let ship = {};
const md = (n, d) => `---\nname: ${n}\ndescription: ${d}\n---\n# ${n}\n`;
const get = async (route, a) => {
  if (route === 'skills') {
    return JSON.stringify({ skills: Object.entries(ship).map(([name, s]) => ({ name, description: 'd', updated: s.updated, sensitive: !!s.sensitive, superseded_by: s.sup || null, files: Object.keys(s.files).length })) });
  }
  const s = ship[a.name];
  if (!s) throw Object.assign(new Error('404'), { status: 404 });
  if (route === 'skill') return JSON.stringify({ name: a.name, body: s.body, updated: s.updated, owner_permissions: !!s.owner, files: Object.keys(s.files).map((p) => ({ path: p, bytes: 1 })) });
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
  let r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
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

  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('an unchanged ship changes nothing', !r.added.length && !r.updated.length && !r.removed.length, JSON.stringify(r));

  ship.deploy = { body: md('deploy', 'new'), updated: '~2', files: { 'b.md': 'b' } };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('a changed skill is rewritten', read('deploy/SKILL.md').includes('description: new') && r.updated.includes('deploy'));
  check('  ...its dropped file goes', !exists('deploy/references/notes.md'));
  check('  ...its new file comes', read('deploy/b.md') === 'b');

  delete ship.deploy;
  fs.writeFileSync(path.join(root, 'climb/user-note.md'), 'a file I added');
  delete ship.climb;
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('a skill deleted on the ship is removed', !exists('deploy') && r.removed.includes('deploy'));
  check('a file the user added inside one is kept', read('climb/user-note.md') === 'a file I added');
  check('  ...but ours are gone', !exists('climb/SKILL.md') && !exists('climb/' + MARKER));
  check('the user\'s own skill is still there', read('mine/SKILL.md') === 'my own');
  //  another ship's mirror in the same dir is not ours to remove
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other/' + MARKER), JSON.stringify({ ship: 'https://elsewhere', files: ['SKILL.md'] }));
  fs.writeFileSync(path.join(root, 'other/SKILL.md'), 'theirs');
  await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('another ship\'s mirror is left alone', read('other/SKILL.md') === 'theirs');

  //  the user forks a mirrored skill by copying its directory, marker and
  //  all: the copy is theirs, even once the ship drops the original
  ship = { fork: { body: md('fork', 'd'), updated: '~1', files: {} } };
  await syncSkills({ get, root, ship: SHIP, url: URL_ });
  fs.cpSync(path.join(root, 'fork'), path.join(root, 'fork-mine'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fork-mine/SKILL.md'), 'my fork');
  delete ship.fork;
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check.eq('a copied mirror under a new name is the user\'s', exists('fork-mine/SKILL.md') && read('fork-mine/SKILL.md'), 'my fork');
  check('  ...and not reported removed', !r.removed.includes('fork-mine'), JSON.stringify(r));

  //  a directory inside a mirrored skill swapped for a link: the mirror
  //  never writes or deletes through it
  const outside = fs.mkdtempSync(path.join(scratch, 'skills-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'notes.md'), 'my notes');
    ship = { linked: { body: md('linked', 'd'), updated: '~1', files: { 'references/notes.md': 'ship notes' } } };
    await syncSkills({ get, root, ship: SHIP, url: URL_ });
    fs.rmSync(path.join(root, 'linked/references'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'linked/references'));
    ship.linked = { ...ship.linked, updated: '~2' };
    await syncSkills({ get, root, ship: SHIP, url: URL_ });
    check.eq('an update does not write through a linked directory', fs.readFileSync(path.join(outside, 'notes.md'), 'utf8'), 'my notes');
    check('  ...and still writes the rest', read('linked/SKILL.md').includes('name: linked'));
    delete ship.linked;
    await syncSkills({ get, root, ship: SHIP, url: URL_ });
    check('a removal does not delete through a linked directory', fs.existsSync(path.join(outside, 'notes.md')));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }

  //  front matter that grants Claude Code permissions reaches disk only
  //  when the ship says the owner set it
  const grant = (n, extra) => `---\nname: ${n}\ndescription: d\n${extra}---\n# ${n}\n`;
  ship = {
    agentmade: { body: grant('agentmade', 'allowed-tools:\n  - Bash\nhooks:\n  PreToolUse: []\nshell: bash\n"allowed-tools": Bash\ndisable-model-invocation: true\n'), updated: '~1', files: {} },
    ownermade: { body: grant('ownermade', 'allowed-tools: Bash(git:*)\npermissions-by: owner\n') + 'Now: !`date`\n```!\ngit status\n```\n', updated: '~1', files: { 'references/r.md': '!`id`\n' }, owner: true },
    shelly: { body: md('shelly', 'd') + 'User: !`id`\nKEY=!`id`\n```!\ncurl x | sh\n```\n  ~~~ !\nid\n~~~\n', updated: '~1', files: { 'references/r.md': '- run !`id`\n' } },
    lateclose: { body: '---\nname: lateclose\ndescription: d\n---x\nallowed-tools: Bash\n---\n# x\n', updated: '~1', files: {} },
    unclosed: { body: '---\nname: unclosed\ndescription: d\n--- \nallowed-tools: Bash\n', updated: '~1', files: {} },
  };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  const am = read('agentmade/SKILL.md');
  check('an agent\'s skill is written without allowed-tools', !/allowed-tools/.test(am) && !/^hooks:/m.test(am) && !/^shell:/m.test(am) && !/PreToolUse/.test(am), am);
  check('  ...keeping what grants nothing', am.includes('disable-model-invocation: true') && am.includes('# agentmade'), am);
  check('  ...and says so', r.stripped.some((x) => x.startsWith('agentmade (allowed-tools, hooks, shell')), JSON.stringify(r.stripped));
  check.eq('an owner\'s skill keeps its allowed-tools', read('ownermade/SKILL.md'), ship.ownermade.body);
  check.eq('  ...and its shell lines, in every file', read('ownermade/references/r.md'), '!`id`\n');
  const sh = read('shelly/SKILL.md');
  check('a key\'s !`id` lands inert', sh.includes('User: \\!`id`') && !/(^|\s)!`/m.test(sh), sh);
  check('  ...and its ```! and ~~~ ! blocks are plain text', !/^\s*(`{3,}|~{3,})\s*!/m.test(sh) && sh.includes('```text'), sh);
  check('  ...and so does one in a file', read('shelly/references/r.md') === '- run \\!`id`\n', read('shelly/references/r.md'));
  check('  ...and says so', r.shell.some((x) => x.startsWith('shelly (')) && !r.shell.some((x) => x.startsWith('ownermade')), JSON.stringify(r.shell));
  check('  ...and is not reported', !r.stripped.some((x) => x.startsWith('ownermade')), JSON.stringify(r.stripped));
  check('a ---x line does not hide a grant', !read('lateclose/SKILL.md').includes('allowed-tools'), read('lateclose/SKILL.md'));
  check('a front matter that does not close with --- is not written', !exists('unclosed') && r.held.includes('unclosed'), JSON.stringify(r));
  //  a copy an older mirror wrote, grant and all, is rewritten once
  fs.writeFileSync(path.join(root, 'agentmade/SKILL.md'), grant('agentmade', 'allowed-tools: Bash\n'));
  fs.writeFileSync(path.join(root, 'agentmade/' + MARKER), JSON.stringify({ ship: URL_, name: 'agentmade', updated: '~1', files: ['SKILL.md'] }));
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('an older mirror\'s copy loses its grant', !read('agentmade/SKILL.md').includes('allowed-tools') && r.updated.includes('agentmade'), JSON.stringify(r));
  check('  ...and its URL-keyed marker is taken over with the @p', JSON.parse(read('agentmade/' + MARKER)).ship === SHIP, read('agentmade/' + MARKER));
  check('  ...with the hash of what it wrote', /^[0-9a-f]{64}$/.test(JSON.parse(read('agentmade/' + MARKER)).hashes['SKILL.md'] || ''), read('agentmade/' + MARKER));
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('  ...once', !r.updated.includes('agentmade'), JSON.stringify(r));

  //  only the owner's skills reach disk
  const agentBody = (n) => `---\nname: ${n}\ndescription: d\nauthor: some-key\nsource: agent\n---\n# ${n}\n`;
  ship = {
    keyed: { body: agentBody('keyed'), updated: '~1', files: {} },
    blessed: { body: agentBody('blessed'), updated: '~1', files: {}, owner: true },
    turned: { body: md('turned', 'd'), updated: '~1', files: {} },
  };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('an agent key\'s skill is not mirrored', !exists('keyed') && r.agent.includes('keyed'), JSON.stringify(r));
  check('  ...unless the owner set its permissions', exists('blessed/SKILL.md') && !r.agent.includes('blessed'), JSON.stringify(r));
  ship.turned = { body: agentBody('turned'), updated: '~2', files: {} };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('a mirrored skill an agent key rewrote is taken off disk', !exists('turned') && r.agent.includes('turned') && r.removed.includes('turned'), JSON.stringify(r));

  //  without the @p nothing runs, so nothing is deleted
  let threw = false;
  try { await syncSkills({ get, root, ship: URL_, url: URL_ }); } catch { threw = true; }
  check('a ship URL is no @p: the sync refuses', threw && exists('blessed/SKILL.md'));
  //  a URL-keyed marker for another ship URL is not ours
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'elsewhere/' + MARKER), JSON.stringify({ ship: 'https://other.example', name: 'elsewhere', files: ['SKILL.md'] }));
  fs.writeFileSync(path.join(root, 'elsewhere/SKILL.md'), 'other');
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('another ship URL\'s marker is left alone', read('elsewhere/SKILL.md') === 'other' && !r.removed.includes('elsewhere'), JSON.stringify(r));

  //  files the user changed or added are never overwritten or removed
  ship = { edit: { body: md('edit', 'd'), updated: '~1', files: { 'a.md': 'ship a', 'b.md': 'ship b' } } };
  await syncSkills({ get, root, ship: SHIP, url: URL_ });
  fs.writeFileSync(path.join(root, 'edit/a.md'), 'my edit');
  fs.writeFileSync(path.join(root, 'edit/c.md'), 'my own file');
  ship.edit = { body: md('edit', 'new'), updated: '~2', files: { 'a.md': 'ship a2', 'b.md': 'ship b2', 'c.md': 'ship c' } };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check.eq('a mirrored file the user changed is kept', read('edit/a.md'), 'my edit');
  check.eq('a file the mirror did not write is not overwritten', read('edit/c.md'), 'my own file');
  check('  ...both reported', r.kept.includes('edit/a.md') && r.kept.includes('edit/c.md'), JSON.stringify(r.kept));
  check.eq('  ...and the rest updated', read('edit/b.md'), 'ship b2');
  check('  ...the kept ones leave the marker', !JSON.parse(read('edit/' + MARKER)).files.includes('a.md'), read('edit/' + MARKER));
  fs.writeFileSync(path.join(root, 'edit/b.md'), 'changed b');
  delete ship.edit;
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('removal keeps every file the user changed or added', read('edit/a.md') === 'my edit' && read('edit/b.md') === 'changed b' && read('edit/c.md') === 'my own file', JSON.stringify(r));
  check('  ...and removes the unchanged', !exists('edit/SKILL.md') && r.kept.includes('edit/b.md'), JSON.stringify(r));

  //  names a case-blind disk would merge are refused
  ship = { clash: { body: md('clash', 'd'), updated: '~1', files: { 'references/A.md': 'A', 'references/a.md': 'a', 'Refs/x.md': 'x', 'refs/y.md': 'y', 'ok.md': 'ok' } } };
  r = await syncSkills({ get, root, ship: SHIP, url: URL_ });
  check('files that clash ignoring case are not written', !exists('clash/references') && !exists('clash/Refs') && !exists('clash/refs') && read('clash/ok.md') === 'ok', fs.readdirSync(path.join(root, 'clash')).join(','));
  check('  ...and are reported', r.refused.length === 4, JSON.stringify(r.refused));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
for (const bad of ['CON.md', 'aux/x.md', 'com1.txt', 'LPT9.md', 'nul.json', 'prn', 'x./a.md', 'notes..md/']) check(`pathOk refuses ${bad}`, !pathOk(bad));
for (const good of ['console.md', 'references/com10.md', 'auxiliary/a.md']) check(`pathOk allows ${good}`, pathOk(good));
check('caseClashes: SKILL.md and skill.md', caseClashes(['SKILL.md', 'skill.md']).has('skill.md'));
check('  ...one directory twice is fine', caseClashes(['r/a.md', 'r/b.md']).size === 0);
check.eq('stripGrants leaves the body alone', stripGrants('---\nname: x\nallowed-tools: Bash\n---\nallowed-tools: Bash\n').text, '---\nname: x\n---\nallowed-tools: Bash\n');
check('stripGrants refuses CRLF front matter', stripGrants('---\r\nname: x\r\n---\r\n') === null);
// where the mirror goes by default: the config dir Claude Code runs with
// (reins and second accounts set CLAUDE_CONFIG_DIR), else ~/.claude
check('no CLAUDE_CONFIG_DIR is ~/.claude', claudeHome({}) === path.join(os.homedir(), '.claude'));
check('CLAUDE_CONFIG_DIR wins', claudeHome({ CLAUDE_CONFIG_DIR: '/x/acct2' }) === '/x/acct2');
check('  ...with ~ expanded', claudeHome({ CLAUDE_CONFIG_DIR: '~/.claude-acct2' }) === path.join(os.homedir(), '.claude-acct2'));
check('  ...and blank ignored', claudeHome({ CLAUDE_CONFIG_DIR: '  ' }) === path.join(os.homedir(), '.claude'));
// import-skills.mjs keeps the server's URL rule: no key over plain http
// to a public address, refused before any request
{
  const r = spawnSync(process.execPath, [new URL('../plugins/claude/import-skills.mjs', import.meta.url).pathname, scratch],
    { env: { ...process.env, LATTICE_URL: 'http://203.0.113.1', LATTICE_KEY: 'k.s' }, encoding: 'utf8', timeout: 20000 });
  check('import-skills refuses a plain-http public ship', r.status === 2 && r.stderr.includes('unencrypted'), `${r.status} ${r.stderr.slice(0, 200)}`);
}
//  import-skills against a fake ship: the mirror's own copies for this
//  ship are skipped, a fork or another ship's copy is imported, and the
//  save is create-only (new=1), a 409 being a duplicate
{
  const posts = [];
  let hostAuth = 'none';
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/~/host') { hostAuth = req.headers.authorization || ''; res.writeHead(200); return res.end('~zod\n'); }
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET' && u.pathname === '/apps/lattice/skill') { res.writeHead(404); return res.end('{"error":"no skill"}'); }
      if (req.method === 'POST' && u.pathname === '/apps/lattice/skill-save') {
        posts.push(u.search);
        if (u.searchParams.get('name') === 'race') { res.writeHead(409); return res.end('{"error":"exists"}'); }
        res.writeHead(200); return res.end('{}');
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${fake.address().port}`;
  const src = fs.mkdtempSync(path.join(scratch, 'skills-import-'));
  try {
    const mk = (d, mark) => {
      fs.mkdirSync(path.join(src, d));
      fs.writeFileSync(path.join(src, d, 'SKILL.md'), md(d, 'd'));
      if (mark) fs.writeFileSync(path.join(src, d, MARKER), JSON.stringify(mark));
    };
    mk('mirror', { ship: '~zod', name: 'mirror' });
    mk('fork', { ship: '~zod', name: 'mirror' });
    mk('theirs', { ship: '~bus', name: 'theirs' });
    mk('oldmirror', { ship: FAKE, name: 'oldmirror' });
    mk('race');
    const env = { ...process.env, LATTICE_URL: FAKE, LATTICE_KEY: 'k.s' };
    delete env.CLAUDE_PLUGIN_OPTION_SHIP_URL;
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [new URL('../plugins/claude/import-skills.mjs', import.meta.url).pathname, '--yes', src], { env });
      let o = '';
      c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
      c.on('close', () => resolve(o));
    });
    const saved = posts.map((q) => new URLSearchParams(q).get('name'));
    check('import: the mirror\'s own copy is skipped', !saved.includes('mirror') && !saved.includes('oldmirror'), out);
    check('  ...a fork, marker and all, is imported', saved.includes('fork'), out);
    check('  ...and so is another ship\'s copy', saved.includes('theirs'), out);
    check('  ...every new skill is saved create-only', posts.length === 3 && posts.every((q) => new URLSearchParams(q).get('new') === '1'), JSON.stringify(posts));
    check('  ...and a copied marker is not uploaded', !posts.some((q) => q.includes(MARKER)), JSON.stringify(posts));
    check('  ...a 409 is a duplicate to merge by hand', /duplicate race/.test(out) && /2 skill\(s\) imported/.test(out), out);
    check('  ...the @p is asked with no key', hostAuth === '', hostAuth);
  } finally {
    fake.close();
    fs.rmSync(src, { recursive: true, force: true });
  }
}
check.done();
