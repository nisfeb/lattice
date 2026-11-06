// A move takes a page's history, comments and settings with it. It used
// to make each page fresh at its new name and delete the old one, so the
// revisions, the comments and the comment and comet settings were gone.
// One page renamed, then a folder moved with a page in it.
//   LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> node scripts/ui-movecarry.mjs
import { shipEnv, makeCheck, waitFor, seed } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = 'umc' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const post = (p, body) => api(p, { method: 'POST', body });
const q = encodeURIComponent;
const body = async (n) => {
  const r = await api('page-source?name=' + q(n));
  return r.ok ? ((await r.json()).body || '') : null;
};
const history = async (n) => {
  const r = await api('page-history?name=' + q(n));
  return r.ok ? (await r.json()).revisions || [] : null;
};
const sourceAt = async (n, rev) => {
  const r = await api('page-source-at?name=' + q(n) + '&rev=' + rev);
  return r.ok ? (await r.json()).body : null;
};
const comments = async (n) => {
  const j = await (await api('comments-inbox')).json();
  return (j.items || []).filter((c) => c.page === n).map((c) => c.body);
};
const comet = async (n) => {
  const r = await api('page-comets?name=' + q(n));
  return r.ok ? (await r.json()).mode : null;
};

async function prepare(name, tag) {
  await seed(env, [[name, '# ' + tag + ' first\n']]);
  await waitFor(async () => /first/.test((await body(name)) || ''), 30000, 500);
  await post('page-save?type=md&name=' + q(name), '# ' + tag + ' second\n');
  check(tag + ': the second body lands',
    await waitFor(async () => /second/.test((await body(name)) || ''), 30000, 500));
  const h = await history(name);
  check(tag + ': two revisions before the move', h && h.length >= 2, JSON.stringify(h));
  check(tag + ': comments on', (await post('page-comments?name=' + q(name) + '&on=1', '')).ok);
  check(tag + ': comet mode held', (await post('page-comets?name=' + q(name) + '&mode=held', '')).ok);
  const c = await post('comment?page=' + q(name), 'body=' + q(tag + ' a comment'));
  check(tag + ': comment filed', c.ok, c.status);
  check(tag + ': comment listed', await waitFor(async () => (await comments(name)).length === 1, 30000, 500));
  return h;
}

async function verify(from, to, tag, before) {
  check(tag + ': the page is at the new name',
    await waitFor(async () => /second/.test((await body(to)) || ''), 60000, 500));
  check(tag + ': nothing at the old name', (await body(from)) === null);
  const h = await history(to);
  check(tag + ': the history moved', h && h.length >= before.length, JSON.stringify(h));
  const oldest = h && h[h.length - 1];
  check(tag + ': its oldest revision reads the first body',
    oldest && /first/.test((await sourceAt(to, oldest.rev)) || ''));
  check.eq(tag + ': and keeps the time it was saved', oldest && oldest.updated,
    before[before.length - 1].updated);
  check(tag + ': no history left at the old name', (await history(from)) === null
    || (await history(from)).length === 0);
  check.eq(tag + ': the comment moved', (await comments(to)).join(), tag + ' a comment');
  check.eq(tag + ': none left at the old name', (await comments(from)).length, 0);
  check.eq(tag + ': the comet mode moved', await comet(to), 'held');
}

// one page renamed
const P = RUN + '/p', P2 = RUN + '/p2';
const ph = await prepare(P, 'page');
const mv = await post('page-move?from=' + q(P) + '&to=' + q(P2), '');
check('page: moved', mv.ok, mv.status);
await verify(P, P2, 'page', ph);

// a folder moved, with a page under it
const F = RUN + '/f', F2 = RUN + '/g';
const fh = await prepare(F + '/x', 'folder');
const fm = await post('page-move?from=' + q(F) + '&to=' + q(F2), '');
check('folder: moved', fm.ok, fm.status);
await verify(F + '/x', F2 + '/x', 'folder', fh);

// a later save at the new name is a revision on top of the moved history
await post('page-save?type=md&name=' + q(P2), '# page third\n');
await waitFor(async () => /third/.test((await body(P2)) || ''), 30000, 500);
// (the moved head may be coalesced away: it and the save are one burst)
const h3 = await history(P2);
const first = h3 && h3.length > 1 && await sourceAt(P2, h3[h3.length - 1].rev);
check('a save after the move keeps the moved revisions', /first/.test(first || ''),
  JSON.stringify(h3));

for (const n of [P2, F2]) await post('page-del?name=' + q(n), '');
check.done();
