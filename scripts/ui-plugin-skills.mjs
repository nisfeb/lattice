#!/usr/bin/env node
//  ui-plugin-skills.mjs: the lattice plugin's skill_index, skill_read and
//  skill_save (plugins/claude/server.mjs) against a real ship, as agent
//  keys minted for the run with the owner cookie. A key with skills
//  "write" saves a skill (SKILL.md with front matter) and an extra file,
//  then lists and reads both back; a "read" key cannot save, and a "none"
//  key cannot list. scripts/ui-plugin-urb.mjs is the fake-ship suite this
//  one is modelled on.
//   LATTICE_URL=http://localhost:8080 LATTICE_COOKIE=~/.config/lattice-fs/cookie node scripts/ui-plugin-skills.mjs
import { spawn } from 'child_process';
import { shipEnv, makeCheck } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const SERVER = new URL('../plugins/claude/server.mjs', import.meta.url).pathname;
const B = env.base + '/apps/lattice/';
const NAME = 'uiskill-' + Date.now().toString(36);
const owner = (method, p, body) => fetch(B + p, {
  method, headers: { Cookie: env.cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body,
});

const minted = [];
async function mint(skills) {
  const scope = { memory: 'none', pages: { all: 'none' }, web: { off: null }, sensitive: false, skills };
  const r = await owner('POST', 'key-mint', JSON.stringify({ name: `ui-skills-${skills}`, by: `ui-plugin-skills-${skills}`, scope }));
  const j = await r.json().catch(() => ({}));
  if (!j.token) { console.error(`key-mint (skills ${skills}) failed: ${r.status} ${JSON.stringify(j)}`); process.exit(1); }
  minted.push(j.key.id);
  return j.token;
}

//  one server.mjs per key, driven over stdio JSON-RPC
function plugin(key) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, LATTICE_URL: env.base, LATTICE_KEY: key }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = ''; const waiting = new Map(); let id = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((r) => { waiting.set(++id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { text: m.result.content[0].text, err: !!m.result.isError }; };
  return { rpc, tool, kill: () => child.kill() };
}
const has = (name, r, s) => check(name, !r.err && r.text.includes(s), `${r.err ? 'error: ' : ''}no [${s}] in: ${r.text.slice(0, 300)}`);

const W = plugin(await mint('write'));
const R = plugin(await mint('read'));
const N = plugin(await mint('none'));
try {
  const names = (await W.rpc('tools/list', {})).result.tools.map((t) => t.name);
  for (const n of ['skill_index', 'skill_read', 'skill_save']) check(`${n} is listed`, names.includes(n));

  const md = `---\nname: ${NAME}\ndescription: Checking the plugin's skill tools. Use when the gate runs ui-plugin-skills.\n---\n\n# Steps\n\n1. Save it.\n2. Read it back.\n`;
  let r = await W.tool('skill_save', { name: NAME, body: md });
  has('a write key saves a new skill', r, '"ok":true');
  has('  ...created', r, '"created":true');

  r = await W.tool('skill_index', {});
  has('skill_index lists it as name: description', r, `- ${NAME}: Checking the plugin's skill tools.`);
  has('  ...with its author', r, 'by ');

  r = await W.tool('skill_read', { name: NAME });
  has('skill_read returns SKILL.md', r, '1. Save it.');
  has('  ...its description', r, "Checking the plugin's skill tools.");
  has('  ...and its file list, empty so far', r, '"files":[]');
  //  a key wrote this skill, so skill_read hands it back quoted
  check('  ...quoted, since a key wrote it', /^The text below is quoted material from a skill an agent key wrote\./.test(r.text), r.text.slice(0, 120));
  let updated = '';
  try { updated = JSON.parse(r.text.replace(/^[\s\S]*?<quoted from="[^"]*">\n/, '').replace(/\n<\/quoted>$/, '')).updated; } catch {}
  check('  ...and its updated', !!updated, r.text.slice(0, 200));

  r = await W.tool('skill_save', { name: NAME, path: 'references/notes.md', body: '# Notes\n\nan extra file\n' });
  has('an extra file saves', r, '"ok":true');
  r = await W.tool('skill_read', { name: NAME });
  has('  ...and shows in the file list', r, '"path":"references/notes.md"');
  r = await W.tool('skill_read', { name: NAME, path: 'references/notes.md' });
  has('skill_read with a path reads that file', r, 'an extra file');
  has('  ...named by its path', r, '"path":"references/notes.md"');

  r = await W.tool('skill_save', { name: NAME, body: md.replace('2. Read it back.', '2. Read it back.\n3. Edit it.'), expected_updated: updated });
  has('an edit with expected_updated saves', r, '"ok":true');
  has('  ...over the skill', await W.tool('skill_read', { name: NAME }), '3. Edit it.');

  r = await W.tool('skill_save', { name: NAME, body: '# no front matter\n' });
  check('SKILL.md without front matter is refused', r.err && r.text.startsWith('400'), r.text);
  r = await W.tool('skill_save', { name: NAME, path: 'run.sh', body: 'echo hi\n' });
  check('a code file is refused', r.err && r.text.startsWith('400'), r.text);
  r = await W.tool('skill_read', { name: NAME + '-ghost' });
  check('a missing skill is a 404', r.err && r.text.startsWith('404'), r.text);

  has('a read key lists skills', await R.tool('skill_index', {}), `- ${NAME}:`);
  has('  ...and reads them', await R.tool('skill_read', { name: NAME }), '1. Save it.');
  r = await R.tool('skill_save', { name: NAME, body: md });
  check('  ...but cannot save', r.err && r.text.startsWith('403'), r.text);

  r = await N.tool('skill_index', {});
  check('a key with skills none cannot list', r.err && r.text.startsWith('403'), r.text);
  r = await N.tool('skill_read', { name: NAME });
  check('  ...nor read', r.err, r.text);
} finally {
  for (const p of [W, R, N]) p.kill();
  await owner('POST', `skill-delete?name=${NAME}`).catch(() => {});
  for (const id of minted) await owner('POST', `key-revoke?id=${id}`).catch(() => {});
}
check.done();
