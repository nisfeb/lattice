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
function fakeShip({ refuse = [], dump = null, know = null, scopes = null } = {}) {
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
    return { ok: true, status: 200 };
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
      { page: true, path: 'b', kind: 'md', body: 'b' },
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

done();
