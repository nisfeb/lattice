// Memory history across a move. A cull keeps a grub's stored revisions,
// and the next write at that road picks them up again. So a move that
// only culled its source left the moved memory's old bodies behind, and
// the next memory saved at the old key listed them in its own history,
// readable by any key that may read the new one.
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

for (const k of [A, B]) await post('know-delete?key=' + q(k), '');
check.done();
