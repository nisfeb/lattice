#!/usr/bin/env node
//  ui-plugin-urb.mjs: the lattice plugin's urb_read, urb_list and web_read
//  (plugins/claude/server.mjs) against a fake ship, no Urbit needed. The
//  fake answers /apps/lattice/urb-read with the JSON +serve-urb-read sends,
//  one shape per case, so the rendering is checked here: folders and
//  boards as followable entries, a thread's comments, a binary file as its
//  type and size, long text cut with an offset, html as text, the quoted()
//  label on another ship's text and not on our own, and the errors.
//  scripts/two-ship-urb-read.sh checks the same tools against real ships.
import { spawn } from 'child_process';
import http from 'http';

const SERVER = new URL('../plugins/claude/server.mjs', import.meta.url).pathname;
const A = '~zod', ME = '~nec';
const big = 'x'.repeat(50000);
const answers = {
  [`urb://${A}/pub`]: { url: `urb://${A}/pub`, ship: A, own: false, kind: 'page', shared: false, mode: 'md', body: '# Hello from zod', size: 16,
    comments: [{ author: '~bus', when: '~2026.11.5..10.00.00', body: 'nice page' }] },
  [`urb://${A}/priv`]: { url: `urb://${A}/priv`, ship: A, own: false, kind: 'page', shared: true, mode: 'md', body: 'for nec only', size: 12, comments: [] },
  [`urb://${A}/big`]: { url: `urb://${A}/big`, ship: A, own: false, kind: 'page', mode: 'md', body: big, size: big.length, comments: [] },
  [`urb://${A}/h`]: { url: `urb://${A}/h`, ship: A, own: false, kind: 'page', mode: 'html', body: '<h1>Title</h1><script>evil()</script><p>a &amp; b</p>', size: 50, comments: [] },
  [`urb://${A}/t/bin/pic`]: { url: `urb://${A}/t/bin/pic`, ship: A, own: false, kind: 'binary', mark: 'mime', type: 'image/png', size: 12345 },
  [`urb://${A}/dir/`]: { url: `urb://${A}/dir/`, ship: A, own: false, kind: 'folder', path: '/dir',
    entries: [{ name: 'sub', url: `urb://${A}/dir/sub/`, folder: true, title: 'sub/', when: '~2026.11.5' },
      { name: 'one', url: `urb://${A}/dir/one`, folder: false, title: 'One', when: '~2026.11.4..1.2.3' }] },
  [`urb://${A}/forum/b`]: { url: `urb://${A}/forum/b`, ship: A, own: false, kind: 'board', board: 'b', title: 'Board B', description: 'talk',
    boardUrl: `urb://${A}/forum/b`, count: 1,
    posts: [{ id: 1, url: `urb://${A}/forum/b/1`, title: 'First', author: A, created: '~2026.11.5', link: null, body: null, up: 2, down: 0, comments: 1, pinned: true }] },
  [`urb://${A}/forum/b/1`]: { url: `urb://${A}/forum/b/1`, ship: A, own: false, kind: 'thread', board: 'b', title: 'Board B', boardUrl: `urb://${A}/forum/b`,
    post: { id: 1, url: `urb://${A}/forum/b/1`, title: 'First', author: A, created: '~2026.11.5', link: 'https://example.com', body: 'post body', up: 2, down: 0, comments: 2 },
    comments: [{ id: 1, parent: null, author: '~bus', created: '~2026.11.5', body: 'top' }, { id: 2, parent: 1, author: ME, created: '~2026.11.5', body: 'reply' }] },
  [`urb://${ME}/notes/mine`]: { url: `urb://${ME}/notes/mine`, ship: ME, own: true, kind: 'page', mode: 'md', name: 'notes/mine', share: 'private', body: 'my own words', size: 12 },
  [`urb://${ME}/clips/site`]: { url: `urb://${ME}/clips/site`, ship: ME, own: true, kind: 'page', mode: 'md', name: 'clips/site', share: 'private', body: 'clipped words', size: 13 },
};
const errors = { [`urb://${A}/nope`]: [404, 'not found, or not shared with this ship'], [`urb://~sampel/notes`]: [504, 'that ship does not answer'],
  [`urb://${ME}/other`]: [403, "not published, and outside this key's page scope"] };
const seen = [];
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push(u.pathname + u.search);
  const url = u.searchParams.get('url');
  if (u.pathname !== '/apps/lattice/urb-read' || req.headers.authorization !== 'Bearer k.s') { res.writeHead(404); return res.end('{"error":"no route"}'); }
  if (errors[url]) { res.writeHead(errors[url][0], { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: errors[url][1] })); }
  const j = u.searchParams.get('list') === '1' ? answers[`urb://${A}/dir/`] : answers[url];
  if (!j) { res.writeHead(404); return res.end('{"error":"not found"}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(j));
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const child = spawn(process.execPath, [SERVER], { env: { ...process.env, LATTICE_URL: `http://127.0.0.1:${fake.address().port}`, LATTICE_KEY: 'k.s' }, stdio: ['pipe', 'pipe', 'inherit'] });
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

let fails = 0;
const check = (name, ok, why = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : '  ' + why}`); if (!ok) fails++; };
const has = (name, t, s) => check(name, t.includes(s), `no [${s}] in: ${t.slice(0, 300)}`);
const hasnt = (name, t, s) => check(name, !t.includes(s), `unexpected [${s}]`);

const names = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
for (const n of ['urb_read', 'urb_list', 'web_read']) check(`${n} is listed`, names.includes(n));

let r = await tool('urb_read', { url: `urb://${A}/pub` });
has('a published page', r.text, '# Hello from zod');
has('  ...quoted, from its address', r.text, `<quoted from="urb://${A}/pub">`);
has('  ...with its public comments', r.text, '- ~bus (2026.11.5): nice page');
has('a page shared with us says so', (await tool('urb_read', { url: `urb://${A}/priv` })).text, 'shared with this ship, not published');
r = await tool('urb_read', { url: `urb://${A}/big` });
has('a long page is cut', r.text, '[truncated: characters 0 to 40000 of 50000. Pass offset 40000 to read on.]');
r = await tool('urb_read', { url: `urb://${A}/big`, offset: 40000 });
hasnt('  ...and reads to its end at the offset', r.text, 'truncated');
check('  ...the rest, 10000 characters', (r.text.match(/x+/g) || []).some((s) => s.length === 10000));
has('  ...past the end says so', (await tool('urb_read', { url: `urb://${A}/big`, offset: 90000 })).text, 'nothing at offset 90000');
r = await tool('urb_read', { url: `urb://${A}/h` });
has('html comes back as text', r.text, 'Title\na & b');
hasnt('  ...without its scripts', r.text, 'evil()');
r = await tool('urb_read', { url: `urb://${A}/t/bin/pic` });
has('a binary file: its type and size', r.text, 'is a binary file: type image/png, mark mime, 12345 bytes. Its bytes are not shown.');
r = await tool('urb_read', { url: `urb://${A}/dir/` });
has('a folder lists its entries with addresses', r.text, `- One: urb://${A}/dir/one (updated 2026.11.4)`);
has('  ...folders marked', r.text, `- sub/ (folder): urb://${A}/dir/sub/`);
has('  ...quoted', r.text, '<quoted from=');
r = await tool('urb_read', { url: `urb://${A}/forum/b` });
has('a board lists its posts', r.text, `- [pinned] First by ${A}, 1 comment, +2/-0, 2026.11.5: urb://${A}/forum/b/1`);
r = await tool('urb_read', { url: `urb://${A}/forum/b/1` });
has('a thread has its body', r.text, 'post body');
has('  ...its link', r.text, 'link: https://example.com');
has('  ...and its comments, nested', r.text, `- ~bus (2026.11.5): top\n  - ${ME} (2026.11.5): reply`);
r = await tool('urb_read', { url: `urb://${ME}/notes/mine` });
has('our own page', r.text, 'my own words');
hasnt('  ...is not quoted', r.text, '<quoted');
has('our own clip is quoted', (await tool('urb_read', { url: `urb://${ME}/clips/site` })).text, '<quoted from="a web page clipped to clips/site">');
r = await tool('urb_list', { url: `urb://${A}/` });
has('urb_list lists', r.text, `urb://${A}/dir/one`);
check('  ...asking for the listing', seen.some((s) => s.includes('list=1')));
has('web_read is urb_read', (await tool('web_read', { url: `urb://${A}/pub` })).text, '# Hello from zod');
r = await tool('urb_read', { url: `urb://${A}/nope` });
check('not found is an error', r.err && r.text.startsWith('not found: not found, or not shared'), r.text);
r = await tool('urb_read', { url: 'urb://~sampel/notes' });
check('an unreachable ship says so', r.err && r.text.startsWith('ship unreachable:'), r.text);
r = await tool('urb_read', { url: `urb://${ME}/other` });
check('outside the scope is no access', r.err && r.text.startsWith('no access:'), r.text);
r = await tool('urb_read', { url: 'https://example.com' });
check('a web address is refused before any request', r.err && r.text.includes('not a urb:// address'), r.text);
check('  ...and nothing was asked', !seen.some((s) => s.includes('example.com')));

child.kill(); fake.close();
console.log(fails ? `ui-plugin-urb: ${fails} failed` : 'ui-plugin-urb: all passed');
process.exit(fails ? 1 : 0);
