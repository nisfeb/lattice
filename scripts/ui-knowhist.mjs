// Memory history across a move. A cull keeps a grub's stored revisions,
// and the next write at that road picks them up again. So a move that
// only culled its source left the moved memory's old bodies behind, and
// the next memory saved at the old key listed them in its own history,
// readable by any key that may read the new one. And a batch save's
// duplicate check against a memory the same batch rewrote.
//   LATTICE_URL=http://localhost:<port> LATTICE_COOKIE=<cookie file> node scripts/ui-knowhist.mjs
import { shipEnv, makeCheck, waitFor } from './lib/harness.mjs';

const env = shipEnv();
const check = makeCheck();
const RUN = '/ukh' + Date.now().toString(36);
const H = { Cookie: env.cookie };
const api = (p, o = {}) => fetch(env.base + '/apps/lattice/' + p, { headers: H, ...o });
const post = (p, body) => api(p, { method: 'POST', body });
const q = encodeURIComponent;
const A = RUN + '/a', B = RUN + '/b';

async function history(k) {
  const r = await api('know-history?key=' + q(k));
  return r.ok ? (await r.json()).revisions || [] : null;
}
async function body(k) {
  const r = await api('know-read?key=' + q(k));
  if (!r.ok) return null;
  const j = await r.json();
  return j.body ?? (j.entry && j.entry.body) ?? null;
}
const has = async (k, text) => ((await body(k)) || '').includes(text);

check('save the first body', (await post('know-save?key=' + q(A), 'old body one')).ok);
await waitFor(() => has(A, 'old body one'), 30000, 500);
check('save the second body', (await post('know-save?key=' + q(A), 'old body two')).ok);
check('the second body lands', await waitFor(() => has(A, 'old body two'), 30000, 500));
const before = await history(A);
check('the memory has two revisions before the move', before && before.length >= 2,
  JSON.stringify(before));

check('move it', (await post('know-move?from=' + q(A) + '&to=' + q(B), '')).ok);
check('it is at the new key', await waitFor(() => has(B, 'old body two'), 30000, 500));
check('the old key is empty', await waitFor(async () => (await body(A)) === null, 30000, 500));

check('save a new memory at the old key', (await post('know-save?key=' + q(A), 'a different note')).ok);
check('the new memory lands', await waitFor(() => has(A, 'a different note'), 30000, 500));
const after = await history(A);
check.eq('the new memory has only its own revision', after && after.length, 1);
// and none of the moved memory's bodies is readable through it
let leaked = false;
for (const v of after || []) {
  const r = await api('know-read-at?key=' + q(A) + '&rev=' + v.rev);
  if (r.ok && (await r.text()).includes('old body')) leaked = true;
}
check('no revision of the new memory holds the moved one\'s body', !leaked);

// A batch that rewrites a memory, then saves a new one resembling the
// rewritten memory's OLD body: the old body is gone, so the new one is
// no duplicate of it. The duplicate pool kept the old body and refused it.
const D = RUN + '/d', E = RUN + '/e';
const OLD = 'quartz harbor lantern meadow violin glacier pepper saddle tundra orchid marble falcon';
check('seed the memory to rewrite', (await post('know-save?key=' + q(D), OLD)).ok);
await waitFor(() => has(D, 'quartz harbor'), 30000, 500);
const br = await api('know-save-batch', {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ items: [
    { key: D, body: 'nothing alike remains here after this rewrite of it', author: 'ukh' },
    { key: E, body: OLD + ' sparrow', author: 'ukh' },
  ] }),
});
const bj = br.ok ? await br.json() : null;
const res = (bj && bj.results) || [];
check('the batch answers', br.ok, br.status);
check('the rewrite lands', res[0] && res[0].ok === true, JSON.stringify(res[0]));
check('the new memory is not refused as a duplicate of the rewritten body',
  res[1] && res[1].ok === true, JSON.stringify(res[1]));

// A save at the key of a deleted memory is a new memory. It used to take
// the trashed one's place: the trash copy was culled, so it could not be
// restored, and its pre-delete revisions came back under the new entry.
const T = RUN + '/t', T2 = RUN + '/t2';
const inTrash = async (k) => {
  const r = await api('know-trash');
  return r.ok && JSON.stringify(await r.json()).includes(k + '"');
};
check('save the memory to delete', (await post('know-save?key=' + q(T), 'secret body one')).ok);
await waitFor(() => has(T, 'secret body one'), 30000, 500);
check('save it again', (await post('know-save?key=' + q(T), 'secret body two')).ok);
await waitFor(() => has(T, 'secret body two'), 30000, 500);
check('delete it', (await post('know-delete?key=' + q(T), '')).ok);
check('it is in the trash', await waitFor(() => inTrash(T), 30000, 500));
check('save a new memory at its key', (await post('know-save?key=' + q(T), 'a fresh note')).ok);
check('the new memory lands', await waitFor(() => has(T, 'a fresh note'), 30000, 500));
const th = await history(T);
check.eq('the new memory has only its own revision', th && th.length, 1);
let tleak = false;
for (const v of th || []) {
  const r = await api('know-read-at?key=' + q(T) + '&rev=' + v.rev);
  if (r.ok && (await r.text()).includes('secret body')) tleak = true;
}
check('no revision of the new memory holds the deleted one\'s body', !tleak);
check('the deleted one is still in the trash', await inTrash(T));
const dr = await post('know-delete?key=' + q(T), '');
check.eq('deleting the new one would overwrite the trash copy, so it is refused', dr.status, 409);
check('move the new one aside', (await post('know-move?from=' + q(T) + '&to=' + q(T2), '')).ok);
await waitFor(async () => (await body(T)) === null, 30000, 500);
check('restore the deleted one', (await post('know-restore?key=' + q(T), '')).ok);
check('the deleted memory comes back whole', await waitFor(() => has(T, 'secret body two'), 30000, 500));

for (const k of [A, B, D, E, T, T2]) await post('know-delete?key=' + q(k), '');
check.done();
