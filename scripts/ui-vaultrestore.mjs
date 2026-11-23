#!/usr/bin/env node
// Unit tests for the vault's restore and export orchestration (ui-app/vault.js).
//
// ui-vaultar.mjs checks the tar bytes. This checks what the restore and the
// export DO with them, against a fake ship that records every request:
//
//   - the writes a restore makes after the pages (share modes, display names,
//     folders) go out as POST. They went out as GET, which those routes
//     refuse, so none of them ever came back.
//   - share.json and names.json only touch pages the restore actually saved.
//   - the confirm names every page that would be published, with its mode.
//   - an export that could not read everything says so to backup_write, and
//     its manifest.json says what it meant to write.
//
// Usage:  node scripts/ui-vaultrestore.mjs

import { makeCheck, cut } from './lib/check.mjs';

const { eq, done } = makeCheck();

// everything from the tar code down to the settings UI: restore and export,
// minus the DOM panes. The browser globals it touches are passed in as
// parameters, so each test hands it its own fake.
const code = cut('code/nex/lattice/ui-app/vault.js',
  /const te = new TextEncoder\(\);[\s\S]*?(?=\/\/ ── settings-page UI)/, 'the restore and export code');
const load = new Function('window', 'fetch', 'document', 'FileReader', 'setTimeout',
  `${code}\nreturn { tarBlob, untar, configure, restorePlan, restoreMessage, uploadPages, restoreVault, exportVault };`);

// a ship that answers ok to everything except the names in `refuse`, and
// remembers each request as "METHOD path?query"
function fakeShip({ refuse = [], dump = null, know = null, scopes = null, fail = [] } = {}) {
  const log = [];
  const fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    log.push({ method, url, body: opts && opts.body });
    const u = new URL(url, 'http://ship');
    const json = (v) => ({ ok: true, status: 200, json: async () => v });
    if (u.pathname.endsWith('/page-dump')) return json(dump);
    if (u.pathname.endsWith('/know-all')) return know ? json(know) : { ok: false, status: 500 };
    if (u.pathname.endsWith('/page-scopes')) return json(scopes);
    if (u.pathname.endsWith('/page-save-batch')) {
      const names = JSON.parse(opts.body).map((x) => x.name);
      return { ok: !names.some((n) => refuse.includes(n)), status: 400 };
    }
    if (u.pathname.endsWith('/page-save')) {
      return { ok: !refuse.includes(u.searchParams.get('name')), status: 400 };
    }
    //  `fail`: routes the ship answers 500 on
    return fail.some((f) => u.pathname.endsWith(f)) ? { ok: false, status: 500 } : { ok: true, status: 200 };
  };
  return { log, fetch };
}

const MT = 1750000000;

console.log('restorePlan: metadata follows the pages that were saved');
{
  const { restorePlan } = load({}, null, null, null, () => {});
  const saved = new Set(['notes/todo', 'pub']);
  const p = restorePlan(
    { 'notes/todo': 'clearweb', pub: 'urbit', ghost: 'clearweb' },
    { notes: 'My Notes', 'notes/todo': 'To Do', not: 'prefix only', ghost: 'Ghost' },
    saved);
  eq('a share mode for a saved page applies', JSON.stringify(p.share),
    JSON.stringify([['notes/todo', 'clearweb'], ['pub', 'shared']]));
  eq('a folder holding a saved page keeps its name, a page keeps its own',
    JSON.stringify(p.names), JSON.stringify([['notes', 'My Notes'], ['notes/todo', 'To Do']]));
  // 'not' is a string prefix of 'notes/todo' but not a path prefix
  eq('entries for anything not restored are dropped and counted', p.dropped, 3);
}

console.log('\nthe confirm names what it will publish');
{
  const { restoreMessage } = load({}, null, null, null, () => {});
  const m = restoreMessage(3, true, [['a/b', 'clearweb'], ['c', 'shared']]);
  eq('each page is named with its mode', m.includes('a/b (clearweb)') && m.includes('c (shared)'), true);
  eq('with the publish warning', m.includes('Once published, deletion is not assured'), true);
  eq('nothing to publish, no warning', restoreMessage(3, false, []).includes('published'), false);
}

console.log('\nuploadPages: POST everywhere, and only saved names come back');
{
  const ship = fakeShip({ refuse: ['bad'] });
  const { uploadPages } = load({}, ship.fetch, null, null, () => {});
  const u = await uploadPages([
    { name: 'dir/sub/a', kind: 'md', body: 'a' },
    { name: 'bad', kind: 'md', body: 'b' },
  ]);
  eq('the saved set holds what the ship took', JSON.stringify([...u.saved].sort()), '["dir/sub/a"]');
  eq('and not what it refused', u.bad, 1);
  const folders = ship.log.filter((r) => r.url.includes('/folder-new'));
  eq('both parent folders are made', folders.length, 2);
  eq('folder-new is a POST', folders.every((r) => r.method === 'POST'), true);
  eq('every request is a POST', ship.log.every((r) => r.method === 'POST'), true);
}

console.log('\nrestoreVault end to end');
{
  const { tarBlob } = load({}, null, null, null, () => {});
  const arc = await tarBlob([
    { name: 'pages/notes/todo.md', body: '# todo\n', mtime: MT },
    { name: 'pages/bad.md', body: 'x\n', mtime: MT },
    { name: 'share.json', body: JSON.stringify({ 'notes/todo': 'clearweb', bad: 'clearweb', ghost: 'urbit' }), mtime: MT },
    { name: 'names.json', body: JSON.stringify({ notes: 'Notes', ghost: 'Ghost' }), mtime: MT },
    { name: 'sensitive.json', body: JSON.stringify(['notes', 'notes/todo', 'ghost', 'bad']), mtime: MT },
  ]).arrayBuffer();
  const ship = fakeShip({ refuse: ['bad'] });
  let asked = '';
  const win = { confirm: (m) => { asked = m; return true; } };
  const v = load(win, ship.fetch, null, null, () => {});
  v.configure({ status: () => {} });
  await v.restoreVault({ arrayBuffer: async () => arc });

  eq('the confirm lists a page that will go clearweb', asked.includes('notes/todo (clearweb)'), true);
  eq('but not a share entry with no page in the archive', asked.includes('ghost'), false);
  const shares = ship.log.filter((r) => r.url.includes('/page-share?'));
  eq('one share write: the page that was saved', shares.length, 1);
  eq('for that page', shares[0] && new URL(shares[0].url, 'http://s').searchParams.get('name'), 'notes/todo');
  eq('page-share is a POST', shares.every((r) => r.method === 'POST'), true);
  const moves = ship.log.filter((r) => r.url.includes('/page-move?'));
  eq('one display name: the folder of a saved page', moves.length, 1);
  eq('page-move is a POST', moves.every((r) => r.method === 'POST'), true);
  eq('nothing at all went out as GET', ship.log.some((r) => r.method === 'GET'), false);
  // sensitive marks come back for a saved page and the folder holding it,
  // and before any share mode, so nothing is published unmarked
  const marks = ship.log.filter((r) => r.url.includes('/page-sensitive?'));
  eq('a mark for the saved page and its folder only',
    JSON.stringify(marks.map((r) => new URL(r.url, 'http://s').searchParams.get('name')).sort()),
    '["notes","notes/todo"]');
  eq('each mark turns it on, as a POST',
    marks.every((r) => r.method === 'POST' && r.url.includes('on=1')), true);
  const at = (f) => ship.log.findIndex(f);
  eq('marks land before share modes',
    at((r) => r.url.includes('/page-sensitive?')) < at((r) => r.url.includes('/page-share?')), true);
}

console.log('\nrestoreVault: the last word says what failed');
{
  // every stage writes to the one status line. A failure in an early stage
  // must still be on it when the last stage has run.
  const { tarBlob } = load({}, null, null, null, () => {});
  const files = [
    { name: 'pages/notes/todo.md', body: '# todo\n', mtime: MT },
    { name: 'pages/bad.md', body: 'x\n', mtime: MT },
    { name: 'share.json', body: '{"notes/todo":"clearweb"}', mtime: MT },
    { name: 'names.json', body: '{"notes":"Notes"}', mtime: MT },
    { name: 'sensitive.json', body: '["notes/todo"]', mtime: MT },
    { name: 'know.json', body: '{"items":[{"key":"/k","body":"b"}]}', mtime: MT },
  ];
  const run = async (opts, list = files) => {
    const arc = await tarBlob(list).arrayBuffer();
    const ship = fakeShip(opts);
    const said = [];
    let asked = '';
    const v = load({ confirm: (m) => { asked = m; return true; } }, ship.fetch, null, null, () => {});
    v.configure({ status: (m, ok) => said.push([m, ok]) });
    await v.restoreVault({ arrayBuffer: async () => arc });
    return { last: said[said.length - 1] || ['', null], asked, ship };
  };
  let r = await run({ refuse: ['bad'] });
  eq('a refused page is still named at the end', /1 failed: bad/.test(r.last[0]), true);
  eq('and the end is an error', r.last[1], false);
  eq('which also says the memories came back', /memories restored/.test(r.last[0]), true);
  r = await run({ fail: ['/page-sensitive'] });
  eq('a failed sensitive mark is still named at the end', /sensitive marks: 1 failed/.test(r.last[0]), true);
  eq('as an error', r.last[1], false);
  r = await run({ fail: ['/page-share'] });
  eq('a failed share mode too', /share modes: 0 restored, 1 failed/.test(r.last[0]) && r.last[1] === false, true);
  r = await run({ fail: ['/page-move'] });
  eq('and a failed display name', /display names: 1 failed/.test(r.last[0]) && r.last[1] === false, true);
  r = await run({ fail: ['/know-import'] });
  eq('memories that did not come back are an error', /memories did not/.test(r.last[0]) && r.last[1] === false, true);
  eq('beside the pages that did', /pages: 2 restored/.test(r.last[0]), true);
  r = await run({});
  eq('a clean restore ends as a success', r.last[1], true);
  eq('naming the pages and the memories', /pages: 2 restored/.test(r.last[0]) && /memories restored/.test(r.last[0]), true);

  //  an editor on the unpacked archive may put a byte order mark on a
  //  control file. The page that has one keeps it, the JSON does not.
  const bom = (f) => (f.name.endsWith('.json') ? { ...f, body: '\uFEFF' + f.body } : f);
  r = await run({}, [...files, { name: 'manifest.json', body: JSON.stringify({ pages: 2, memories: 1, missing: [] }), mtime: MT }].map(bom));
  eq('control files with a byte order mark restore as before', r.last[1] === true && !/unreadable/.test(r.last[0] + r.asked), true);
  eq('the share mode comes back', r.ship.log.filter((x) => x.url.includes('/page-share?')).length, 1);
  eq('and the display name', r.ship.log.filter((x) => x.url.includes('/page-move?')).length, 1);
  eq('and the sensitive mark', r.ship.log.filter((x) => x.url.includes('/page-sensitive?')).length >= 1, true);
  const ki = r.ship.log.find((x) => x.url.includes('/know-import'));
  eq('know.json goes to the ship without it', ki && String(ki.body).charCodeAt(0), 123);

  console.log('\nrestoreVault: an archive short of its own manifest');
  // manifest.json says what the export meant to write. An archive holding
  // less than that is said to, before anything is written and at the end.
  const manifest = (m) => ({ name: 'manifest.json', body: JSON.stringify(m), mtime: MT });
  r = await run({}, [...files, manifest({ pages: 5, memories: 3, missing: [] })]);
  eq('the confirm says pages are missing', /2 of the 5 pages/.test(r.asked), true);
  eq('and memories', /1 of the 3 memories/.test(r.asked), true);
  eq('and so does the last word, as an error', /2 of the 5 pages/.test(r.last[0]) && r.last[1] === false, true);
  r = await run({}, [...files.filter((f) => f.name !== 'know.json'), manifest({ pages: 2, memories: 3, missing: [] })]);
  eq('memories the manifest counts and the archive lacks', /0 of the 3 memories/.test(r.asked), true);
  r = await run({}, [...files, manifest({ pages: 3, memories: 1, missing: ['notes/gone'] })]);
  eq('a page the export itself could not read is not counted as cut', /of the 3 pages/.test(r.asked), false);
  eq('but is named', /could not read: notes\/gone/.test(r.asked) && /notes\/gone/.test(r.last[0]) && r.last[1] === false, true);
  r = await run({}, [...files, manifest({ pages: 2, memories: 1, missing: [] })]);
  eq('an archive that matches its manifest says nothing of it', /manifest|of the/.test(r.asked + r.last[0]), false);
  eq('and ends as a success', r.last[1], true);
  r = await run({}, [...files, { name: 'manifest.json', body: 'not json', mtime: MT }]);
  eq('an unreadable manifest is said', /manifest\.json is unreadable/.test(r.asked), true);
  r = await run({});
  eq('an archive with no manifest (an older export, or one made by hand) restores as before', r.last[1], true);
}

console.log('\nrestoreVault: cancelling the confirm writes nothing');
{
  const { tarBlob } = load({}, null, null, null, () => {});
  const arc = await tarBlob([
    { name: 'pages/p.md', body: 'p\n', mtime: MT },
    { name: 'share.json', body: '{"p":"clearweb"}', mtime: MT },
  ]).arrayBuffer();
  const ship = fakeShip();
  const v = load({ confirm: () => false }, ship.fetch, null, null, () => {});
  v.configure({ status: () => {} });
  await v.restoreVault({ arrayBuffer: async () => arc });
  eq('no request at all', ship.log.length, 0);
}

// a FileReader good enough for blobToB64
class FakeReader {
  readAsDataURL(b) {
    b.arrayBuffer().then((buf) => {
      this.result = 'data:application/x-tar;base64,' + Buffer.from(buf).toString('base64');
      this.onload();
    });
  }
}

async function scheduledExport(ship) {
  const calls = [];
  const win = { __TAURI__: { core: { invoke: async (cmd, args) => { calls.push({ cmd, args }); return '/backups/x.tar'; } } } };
  const v = load(win, ship.fetch, null, FakeReader, () => {});
  v.configure({ status: () => {} });
  await v.exportVault('bk1');
  const call = calls.find((c) => c.cmd === 'backup_write');
  const files = new Map();
  if (call) for (const e of v.untar(Buffer.from(call.args.b64, 'base64'))) files.set(e.name, e.text);
  return { call, files };
}

console.log('\nexportVault: a complete scheduled backup');
{
  const ship = fakeShip({
    dump: { nodes: [
      { page: true, path: 'a', kind: 'md', body: 'a' },
      { page: true, path: 'b', kind: 'md', body: 'b', sensitive: true },
      { page: true, path: 'dir', kind: 'index', body: 'gen' },
    ] },
    know: { items: [{ key: 'k', body: 'v' }] },
    scopes: { items: [] },
  });
  const { call, files } = await scheduledExport(ship);
  eq('backup_write is told it is complete', call && call.args.complete, true);
  const m = JSON.parse(files.get('manifest.json') || 'null');
  eq('the manifest counts the pages it meant to write', m && m.pages, 2);
  eq('and the memories', m && m.memories, 1);
  eq('and names nothing missing', m && m.missing.length, 0);
  eq('sensitive.json lists what the dump marks', files.get('sensitive.json'), JSON.stringify(['b'], null, 1));
}

console.log('\nexportVault: an incomplete scheduled backup');
{
  const ship = fakeShip({
    // no body, and /page-source answers with no json: that page is missing
    dump: { nodes: [
      { page: true, path: 'a', kind: 'md', body: 'a' },
      { page: true, path: 'lost', kind: 'md' },
    ] },
    know: null,
    scopes: { items: [] },
  });
  const { call, files } = await scheduledExport(ship);
  eq('backup_write is told it is NOT complete', call && call.args.complete, false);
  const m = JSON.parse(files.get('manifest.json') || 'null');
  eq('the manifest still expects both pages', m && m.pages, 2);
  eq('and names what it could not read', JSON.stringify(m && m.missing), '["lost","the memories"]');
  eq('the memory count is unknown, not zero', m && m.memories, null);
}

console.log('\nfodt: a Writer document survives export and restore');
{
  const doc = '<office:document a=\'1\'>\n\t<text:p>it\'s</text:p>\n</office:document>\n';
  const ship = fakeShip({
    dump: { nodes: [{ page: true, path: 'w', kind: 'fodt', body: doc }] },
    know: { items: [] },
    scopes: { items: [] },
  });
  const { files } = await scheduledExport(ship);
  eq('it is exported as w.fodt, byte for byte', files.get('pages/w.fodt'), doc);
  const { tarBlob } = load({}, null, null, null, () => {});
  const arc = await tarBlob([{ name: 'pages/w.fodt', body: doc, mtime: MT }]).arrayBuffer();
  const back = fakeShip();
  const v = load({ confirm: () => true }, back.fetch, null, null, () => {});
  v.configure({ status: () => {} });
  await v.restoreVault({ arrayBuffer: async () => arc });
  const batch = back.log.find((r) => r.url.includes('/page-save-batch'));
  const sent = batch ? JSON.parse(batch.body) : [];
  eq('restore saves it as kind fodt', JSON.stringify(sent.map((x) => [x.name, x.type])), '[["w","fodt"]]');
  eq('with the same body', sent[0] && sent[0].body, doc);
}

done();
