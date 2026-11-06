#!/usr/bin/env node
//  ui-skills-api.mjs: the skill routes (docs/agent-knowledge.md, Skills)
//  against a real ship, with agent keys minted for the run. Scope (none,
//  read, write), a round trip of SKILL.md and a file, front matter and
//  path checks, core protection, sensitive skills and taint, history, and
//  the owner's delete and restore.
//   LATTICE_URL=http://localhost:8150 LATTICE_COOKIE=<file> node scripts/ui-skills-api.mjs
import { shipEnv, makeCheck } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const B = env.base + '/apps/lattice/';
const run = Date.now().toString(36);
const NAME = 'api-skill-' + run;
const SECRET = 'api-secret-' + run;
const CORE = 'api-core-' + run;
const PERM = 'api-perm-' + run;

async function call(auth, method, p, body) {
  const headers = auth === 'owner' ? { Cookie: env.cookie } : { Authorization: 'Bearer ' + auth };
  const r = await fetch(B + p, { method, headers, body });
  let j = null; const t = await r.text();
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  return { status: r.status, j };
}
const owner = (m, p, b) => call('owner', m, p, b);
const md = (name, desc, extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n# ${name}\n\n1. step one\n`;
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

const minted = [];
async function mint(skills, sensitive = false) {
  const scope = { memory: 'none', pages: { all: 'none' }, web: { off: null }, sensitive, skills };
  const r = await owner('POST', 'key-mint', JSON.stringify({ name: `api-skills-${skills}`, by: `skills-${skills}`, scope }));
  if (!r.j.token) { console.error('key-mint failed', r.status, JSON.stringify(r.j)); process.exit(1); }
  minted.push(r.j.key.id);
  check.eq(`a minted key keeps skills ${skills}`, r.j.key.scope.skills, skills);
  return r.j.token;
}

try {
  const W = await mint('write');
  const R = await mint('read');
  const N = await mint('none');
  const C = await mint('write', true);
  //  a key minted without skills in its scope is none
  const bare = await owner('POST', 'key-mint', JSON.stringify({ name: 'api-skills-bare', by: 'bare', scope: { memory: 'read' } }));
  minted.push(bare.j.key.id);
  check.eq('a key minted without skills is none', bare.j.key.scope.skills, 'none');

  //  none: every skill route is a 403
  for (const [m, p] of [['GET', 'skills'], ['GET', `skill?name=${NAME}`], ['POST', `skill-save?name=${NAME}`]]) {
    const r = await call(N, m, p, m === 'POST' ? md(NAME, 'd') : undefined);
    check.eq(`skills none: ${m} ${p.split('?')[0]} is 403`, r.status, 403);
  }
  check.eq('a bare key cannot list skills', (await call(bare.j.token, 'GET', 'skills')).status, 403);

  //  read: no saves
  let r = await call(R, 'POST', `skill-save?name=${NAME}`, md(NAME, 'd'));
  check.eq('skills read: save is 403', r.status, 403);

  //  round trip
  r = await call(W, 'POST', `skill-save?name=${NAME}`, md(NAME, 'Use when checking the skill routes.'));
  check.eq('a write key creates a skill', r.status, 200);
  check('  ...created', r.j.created === true, JSON.stringify(r.j));
  r = await call(W, 'POST', `skill-save?${q({ name: NAME, path: 'references/notes.md' })}`, '# notes\nmore\n');
  check.eq('  ...and adds a file', r.status, 200);
  r = await call(R, 'GET', 'skills');
  const row = (r.j.skills || []).find((s) => s.name === NAME);
  check('a read key lists it', !!row, JSON.stringify(r.j).slice(0, 300));
  check.eq('  ...with its description', row?.description, 'Use when checking the skill routes.');
  check.eq('  ...signed by the key', row?.author, 'skills-write');
  check.eq('  ...and one file', row?.files, 1);
  r = await call(R, 'GET', `skill?name=${NAME}`);
  check('a read key reads SKILL.md', r.status === 200 && r.j.body.includes('1. step one'), JSON.stringify(r.j).slice(0, 300));
  check('  ...stamped source: agent', /\nsource: agent\n/.test(r.j.body || ''), r.j.body);
  check('  ...with its file list', (r.j.files || []).some((f) => f.path === 'references/notes.md'), JSON.stringify(r.j.files));
  r = await call(R, 'GET', `skill-file?${q({ name: NAME, path: 'references/notes.md' })}`);
  check.eq('  ...and the file', r.j.body, '# notes\nmore\n');
  const upd = (await call(R, 'GET', `skill?name=${NAME}`)).j.updated;
  r = await call(W, 'POST', `skill-save?${q({ name: NAME, expected_updated: upd })}`, md(NAME, 'Use when checking the skill routes, edited.'));
  check('an edit with the current expected_updated is not conflicted', r.status === 200 && r.j.conflicted === false, JSON.stringify(r.j));
  r = await call(W, 'POST', `skill-save?${q({ name: NAME, expected_updated: upd })}`, md(NAME, 'again'));
  check('a stale expected_updated is flagged conflicted', r.status === 200 && r.j.conflicted === true, JSON.stringify(r.j));

  //  validation
  for (const [what, p, body] of [
    ['no front matter', `skill-save?name=${NAME}`, '# nothing\n'],
    ['a name that is not the skill\'s', `skill-save?name=${NAME}`, md('other', 'd')],
    ['no description', `skill-save?name=${NAME}`, `---\nname: ${NAME}\n---\nbody\n`],
    ['a description over 1024 bytes', `skill-save?name=${NAME}`, md(NAME, 'd'.repeat(1025))],
    ['a code file', `skill-save?${q({ name: NAME, path: 'run.sh' })}`, 'echo hi'],
    ['an html file', `skill-save?${q({ name: NAME, path: 'x.html' })}`, '<script></script>'],
    ['a path that climbs out', `skill-save?${q({ name: NAME, path: '../../know/x.md' })}`, 'x'],
    ['an absolute path', `skill-save?${q({ name: NAME, path: '/etc/x.md' })}`, 'x'],
    ['a bad name', `skill-save?${q({ name: '../x' })}`, md('../x', 'd')],
    ['an upper-case name', `skill-save?${q({ name: 'Deploy' })}`, md('Deploy', 'd')],
    ['a file before SKILL.md', `skill-save?${q({ name: NAME + '-new', path: 'a.md' })}`, 'x'],
  ]) {
    r = await call(W, 'POST', p, body);
    check.eq(`refused: ${what}`, r.status, 400);
  }
  r = await call(R, 'GET', `skill-file?${q({ name: NAME, path: '../SKILL.md' })}`);
  check.eq('a file read that climbs out is 400', r.status, 400);

  //  core: the owner tags it; a key may not edit, supersede or untag it
  r = await call(W, 'POST', `skill-save?name=${CORE}`, md(CORE, 'A core skill.'));
  check.eq('a key makes a second skill', r.status, 200);
  check.eq('the owner tags it core', (await owner('POST', `skill-tag?name=${CORE}&tag=core`)).status, 200);
  check.eq('  ...a key cannot edit it', (await call(W, 'POST', `skill-save?name=${CORE}`, md(CORE, 'changed'))).status, 403);
  check.eq('  ...nor add a file', (await call(W, 'POST', `skill-save?${q({ name: CORE, path: 'x.md' })}`, 'x')).status, 403);
  check.eq('  ...nor untag it', (await call(W, 'POST', `skill-untag?name=${CORE}&tag=core`)).status, 403);
  check.eq('  ...nor untag Core', (await call(W, 'POST', `skill-untag?name=${CORE}&tag=Core`)).status, 403);
  check.eq('  ...nor supersede it', (await call(W, 'POST', `skill-supersede?old=${CORE}&new=${NAME}`)).status, 403);
  check.eq('a key may tag one', (await call(W, 'POST', `skill-tag?name=${NAME}&tag=ops`)).status, 200);
  r = await call(R, 'GET', `skill?name=${NAME}`);
  check('  ...and the tag is there', (r.j.tags || []).includes('ops'), JSON.stringify(r.j.tags));

  //  supersede
  check.eq('a key supersedes a skill', (await call(W, 'POST', `skill-supersede?old=${NAME}&new=${CORE}`)).status, 200);
  r = await call(R, 'GET', `skill?name=${NAME}`);
  check.eq('  ...which points at the new one', r.j.superseded_by, CORE);
  check.eq('  ...and clears again', (await call(W, 'POST', `skill-supersede?old=${NAME}&new=`)).status, 200);

  //  sensitive
  r = await call(C, 'POST', `skill-save?${q({ name: SECRET, sensitive: 1 })}`, md(SECRET, 'A sensitive skill.'));
  check('a cleared key saves a sensitive skill', r.status === 200 && r.j.sensitive === true, JSON.stringify(r.j));
  r = await call(R, 'GET', 'skills');
  check('an uncleared key does not list it', !(r.j.skills || []).some((s) => s.name === SECRET));
  check.eq('  ...nor read it', (await call(R, 'GET', `skill?name=${SECRET}`)).status, 404);
  check.eq('  ...nor its history', (await call(R, 'GET', `skill-history?name=${SECRET}`)).status, 404);
  check.eq('  ...nor save over it', (await call(W, 'POST', `skill-save?name=${SECRET}`, md(SECRET, 'x'))).status, 403);
  check.eq('  ...nor tag it', (await call(W, 'POST', `skill-tag?name=${SECRET}&tag=x`)).status, 404);
  r = await call(C, 'GET', 'skills');
  check('a cleared key does not list it unasked', !(r.j.skills || []).some((s) => s.name === SECRET));
  r = await owner('GET', 'keys');
  const cid = minted[3];
  check('  ...and is not tainted by the listing', !(r.j.find((k) => k.id === cid) || {}).tainted_until, JSON.stringify(r.j.find((k) => k.id === cid)));
  r = await call(C, 'GET', 'skills?sensitive=1');
  check('a cleared key lists it when it asks', (r.j.skills || []).some((s) => s.name === SECRET && s.sensitive));
  r = await call(C, 'GET', `skill?name=${SECRET}`);
  check.eq('  ...and reads it', r.status, 200);
  r = await owner('GET', 'keys');
  check('  ...which taints it', !!(r.j.find((k) => k.id === cid) || {}).tainted_until, JSON.stringify(r.j.find((k) => k.id === cid)));
  r = await call(C, 'POST', `skill-save?name=${NAME}`, md(NAME, 'leak'));
  check.eq('a tainted key cannot edit an ordinary skill', r.status, 403);
  r = await call(C, 'POST', `skill-save?name=${NAME}-t`, md(NAME + '-t', 'new from a tainted key'));
  check('  ...and its new skill is sensitive', r.status === 200 && r.j.sensitive === true, JSON.stringify(r.j));
  r = await call(W, 'POST', `skill-save?${q({ name: SECRET + '-w', sensitive: 1 })}`, md(SECRET + '-w', 'marked'));
  check('any write key may mark a skill sensitive', r.status === 200 && r.j.sensitive === true, JSON.stringify(r.j));
  r = await call(C, 'POST', `skill-save?${q({ name: SECRET, sensitive: 0 })}`, md(SECRET, 'still'));
  check('a key never lowers the mark', r.j.sensitive === true, JSON.stringify(r.j));

  //  permissions: front matter that grants Claude Code tools is the owner's
  for (const [what, extra] of [
    ['allowed-tools', 'allowed-tools: Bash\n'],
    ['allowed-tools as a list', 'allowed-tools:\n  - Bash\n'],
    ['hooks', 'hooks:\n  PreToolUse: []\n'],
    ['shell', 'shell: powershell\n'],
    ['a quoted allowed-tools', '"allowed-tools": Bash\n'],
    ['an unknown field', 'grant-all: yes\n'],
    ['the ship\'s own mark', 'permissions-by: owner\n'],
  ]) {
    r = await call(W, 'POST', `skill-save?name=${PERM}`, md(PERM, 'd', extra));
    check(`a key's save with ${what} is 403`, r.status === 403 && /owner/.test(r.j.error || r.j.raw || JSON.stringify(r.j)), `${r.status} ${JSON.stringify(r.j)}`);
  }
  check.eq('  ...and stores nothing', (await owner('GET', `skill?name=${PERM}`)).status, 404);
  r = await call(W, 'POST', `skill-save?name=${PERM}`, md(PERM, 'd', 'disable-model-invocation: true\ndisallowed-tools: Bash\n'));
  check('a key may set fields that grant nothing', r.status === 200 && r.j.owner_permissions === false, JSON.stringify(r.j));
  const permBody = md(PERM, 'd', 'allowed-tools: Bash(git status:*)\n');
  r = await owner('POST', `skill-save?name=${PERM}`, permBody);
  check('the owner saves allowed-tools', r.status === 200 && r.j.owner_permissions === true, JSON.stringify(r.j));
  r = await call(R, 'GET', `skill?name=${PERM}`);
  check('  ...a key reads it as the owner\'s', r.j.owner_permissions === true && /\nallowed-tools: Bash\(git status:\*\)\n/.test(r.j.body) && /\npermissions-by: owner\n/.test(r.j.body), JSON.stringify(r.j).slice(0, 400));
  check('  ...and so does the index', ((await call(R, 'GET', 'skills')).j.skills || []).some((x) => x.name === PERM && x.owner_permissions === true));
  r = await call(W, 'POST', `skill-save?name=${PERM}`, md(PERM, 'd'));
  check.eq('  ...a key cannot edit it, even to drop the grant', r.status, 403);
  check.eq('  ...nor keep it and change the steps', (await call(W, 'POST', `skill-save?name=${PERM}`, (await call(R, 'GET', `skill?name=${PERM}`)).j.body.replace('step one', 'rm -rf'))).status, 403);
  check.eq('  ...nor add a file', (await call(W, 'POST', `skill-save?${q({ name: PERM, path: 'references/x.md' })}`, 'x')).status, 403);
  check('  ...and it is unchanged', /\nallowed-tools: Bash\(git status:\*\)\n/.test((await owner('GET', `skill?name=${PERM}`)).j.body));
  r = await owner('POST', `skill-save?name=${PERM}`, md(PERM, 'd'));
  check('the owner drops the grant, and the mark goes', r.status === 200 && r.j.owner_permissions === false && !/permissions-by/.test((await owner('GET', `skill?name=${PERM}`)).j.body), JSON.stringify(r.j));
  check.eq('  ...and a key may edit it again', (await call(W, 'POST', `skill-save?name=${PERM}`, md(PERM, 'again'))).status, 200);

  //  history
  r = await call(R, 'GET', `skill-history?name=${NAME}`);
  const revs = r.j.revisions || [];
  check('a read key sees history', r.status === 200 && revs.length >= 1, JSON.stringify(r.j));
  if (revs.length) {
    r = await call(R, 'GET', `skill-read-at?name=${NAME}&rev=${revs[0].rev}`);
    check('  ...and reads a revision', r.status === 200 && typeof r.j.body === 'string', JSON.stringify(r.j).slice(0, 200));
  }

  //  the owner's routes: a key never reaches them
  check.eq('a key cannot delete a skill', (await call(W, 'POST', `skill-delete?name=${NAME}`)).status, 403);
  check.eq('a key cannot see the trash', (await call(W, 'GET', 'skill-trash')).status, 403);
  check.eq('a key cannot drop a file', (await call(W, 'POST', `skill-file-delete?${q({ name: NAME, path: 'references/notes.md' })}`)).status, 403);
  r = await owner('GET', 'skills');
  check('the owner lists sensitive skills too', (r.j.skills || []).some((s) => s.name === SECRET));
  check.eq('the owner drops a file', (await owner('POST', `skill-file-delete?${q({ name: NAME, path: 'references/notes.md' })}`)).status, 200);
  r = await owner('GET', `skill?name=${NAME}`);
  check.eq('  ...and it is gone', (r.j.files || []).length, 0);
  check.eq('the owner deletes a skill', (await owner('POST', `skill-delete?name=${NAME}`)).status, 200);
  check.eq('  ...it is not found', (await call(R, 'GET', `skill?name=${NAME}`)).status, 404);
  r = await owner('GET', 'skill-trash');
  check('  ...and is in the trash', (r.j.skills || []).some((s) => s.name === NAME));
  check.eq('  ...the owner reads its history', (await owner('GET', `skill-history?name=${NAME}`)).j.trashed, true);
  check.eq('the owner restores it', (await owner('POST', `skill-restore?name=${NAME}`)).status, 200);
  check.eq('  ...and it is back', (await call(R, 'GET', `skill?name=${NAME}`)).status, 200);
  //  the owner's plain save is verbatim
  const own = md(NAME, 'Owner text.', 'author: me\n');
  check.eq('the owner saves verbatim', (await owner('POST', `skill-save?name=${NAME}`, own)).status, 200);
  check.eq('  ...exactly', (await owner('GET', `skill?name=${NAME}`)).j.body, own);
} finally {
  for (const n of [NAME, SECRET, CORE, PERM, NAME + '-t', SECRET + '-w']) await owner('POST', `skill-delete?name=${n}`).catch(() => {});
  for (const id of minted) await owner('POST', `key-revoke?id=${id}`).catch(() => {});
}
check.done();
